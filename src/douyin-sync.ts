/**
 * Douyin self-favorites synchronisation.
 *
 * The implementation follows jiji262/douyin-downloader's collection flow:
 * fetch the account-level collection, enumerate the user's custom folders,
 * fetch every folder page, then merge records by aweme_id. The HTTP transport
 * is deliberately injectable because Douyin's private web endpoints may need
 * a browser-provided signature (X-Bogus/A-Bogus) in addition to the login
 * cookie. The sync/pagination/normalisation layer does not depend on that
 * signing mechanism.
 */
import { requestUrl, TFile, type RequestUrlParam, type Vault } from "obsidian";

export const DOUYIN_FAVORITES_ENDPOINTS = {
	accountCollection: "/aweme/v1/web/aweme/listcollection/",
	collectFolders: "/aweme/v1/web/collects/list/",
	collectVideos: "/aweme/v1/web/collects/video/list/",
} as const;

const DOUYIN_BASE_URL = "https://www.douyin.com";
export const DEFAULT_DOUYIN_STORAGE_PATH = ".flexible-workbench/douyin-favorites.json";
const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
	"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const DEFAULT_PAGE_LIMIT = 500;
const DEFAULT_PAGE_SIZES = {
	account: 20,
	folders: 10,
	videos: 20,
} as const;

type JsonRecord = Record<string, unknown>;

/** A request before/after an optional browser signature is applied. */
export interface DouyinHttpRequest {
	path: string;
	url: string;
	method: "GET" | "POST";
	params: Record<string, string | number>;
	headers: Record<string, string>;
	body?: string;
}

/** Minimal response shape needed by the sync layer. */
export interface DouyinHttpResponse {
	status: number;
	json?: unknown;
	text?: string;
}

/**
 * A transport can be backed by Obsidian's requestUrl, a browser page bridge,
 * or a test double. It receives the request after URL/body construction but
 * before it is sent.
 */
export type DouyinHttpTransport = (
	request: DouyinHttpRequest,
) => Promise<DouyinHttpResponse>;

/** Optional signer for deployments that need X-Bogus/A-Bogus or page headers. */
export type DouyinRequestSigner = (
	request: DouyinHttpRequest,
) => DouyinHttpRequest | Promise<DouyinHttpRequest>;

export type DouyinSyncErrorKind =
	| "not-logged-in"
	| "rate-limited"
	| "http"
	| "api"
	| "invalid-response";

/** Errors are typed so a UI can tell the user to log in versus retry later. */
export class DouyinSyncError extends Error {
	readonly kind: DouyinSyncErrorKind;
	readonly status?: number;
	readonly path?: string;
	readonly cause?: unknown;

	constructor(
		kind: DouyinSyncErrorKind,
		message: string,
		options: { status?: number; path?: string; cause?: unknown } = {},
	) {
		super(message);
		this.name = "DouyinSyncError";
		this.kind = kind;
		this.status = options.status;
		this.path = options.path;
		if (options.cause !== undefined) this.cause = options.cause;
	}
}

/** One page in Douyin's cursor-based web API. */
export interface DouyinApiPage {
	items: JsonRecord[];
	hasMore: boolean;
	nextCursor: number;
	raw: JsonRecord;
}

/** Metadata for one custom folder in the user's Douyin account. */
export interface DouyinFavoriteFolder {
	id: string;
	name: string;
	count: number | null;
	raw: JsonRecord;
}

/** One normalised video ready for JSON or database persistence. */
export interface DouyinFavoriteItem {
	awemeId: string;
	title: string;
	description: string;
	author: string;
	authorSecUid: string;
	coverUrl: string;
	shareUrl: string;
	createTime: number | null;
	folderIds: string[];
	folderNames: string[];
	sources: ("account" | "folder")[];
	/** Original aweme payload, retained for future fields and reprocessing. */
	raw: JsonRecord;
}

export interface DouyinSyncProgress {
	stage: "account" | "folders" | "folder-videos";
	folderId?: string;
	folderName?: string;
	page: number;
	items: number;
}

export interface DouyinFavoritesSnapshot {
	version: 1;
	syncedAt: number;
	items: DouyinFavoriteItem[];
	folders: DouyinFavoriteFolder[];
	warnings: string[];
	counts: {
		accountItems: number;
		folderItems: number;
		uniqueItems: number;
	};
}

/** Small persistence boundary so the card can keep sync data outside settings. */
export interface DouyinFavoritesStore {
	load(): Promise<DouyinFavoritesSnapshot | null>;
	save(snapshot: DouyinFavoritesSnapshot): Promise<void>;
}

export interface DouyinSyncOptions {
	/** Cookie copied from a logged-in Douyin web session. */
	cookie?: string;
	/** Base URL override, primarily useful for tests or a controlled bridge. */
	baseUrl?: string;
	pageSize?: Partial<{
		account: number;
		folders: number;
		videos: number;
	}>;
	/** Safety cap per cursor walk. */
	maxPages?: number;
	/** Use a custom transport when requests need a browser page/session bridge. */
	transport?: DouyinHttpTransport;
	/** Apply request signing before the chosen transport sends the request. */
	signer?: DouyinRequestSigner;
	/** Injectable clock for deterministic persistence metadata and tests. */
	now?: () => number;
	onProgress?: (progress: DouyinSyncProgress) => void;
}

/**
 * Store snapshots in the vault rather than in plugin settings. The raw aweme
 * payload can be sizeable, and keeping it out of data.json also means card
 * layout exports do not accidentally carry a complete favorites database.
 */
export class DouyinFavoritesVaultStore implements DouyinFavoritesStore {
	readonly path: string;

	constructor(private readonly vault: Vault, path?: string) {
		this.path = normalizeDouyinStoragePath(path);
	}

	async load(): Promise<DouyinFavoritesSnapshot | null> {
		const file = this.vault.getFileByPath(this.path);
		if (!(file instanceof TFile)) return null;
		try {
			const parsed: unknown = JSON.parse(await this.vault.read(file));
			return isDouyinFavoritesSnapshot(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	async save(snapshot: DouyinFavoritesSnapshot): Promise<void> {
		await ensureVaultParent(this.vault, this.path);
		const content = `${JSON.stringify(snapshot, null, 2)}\n`;
		const file = this.vault.getFileByPath(this.path);
		if (file instanceof TFile) {
			await this.vault.modify(file, content);
			return;
		}
		await this.vault.create(this.path, content);
	}
}

interface PageWalkResult<T> {
	items: T[];
	pages: number;
}

/** Default Obsidian transport. It bypasses browser CORS restrictions. */
export const obsidianDouyinTransport: DouyinHttpTransport = async (
	request,
): Promise<DouyinHttpResponse> => {
	const params: RequestUrlParam = {
		url: request.url,
		method: request.method,
		headers: request.headers,
		throw: false,
	};
	if (request.body !== undefined) params.body = request.body;
	const response = await requestUrl(params);
	return {
		status: response.status,
		json: response.json,
		text: response.text,
	};
};

/**
 * Client for the three private web endpoints used by the collection sync.
 * Public methods return normalised pages, keeping endpoint details out of the
 * higher-level merge logic.
 */
export class DouyinFavoritesClient {
	private readonly baseUrl: string;
	private readonly cookie: string;
	private readonly transport: DouyinHttpTransport;
	private readonly signer?: DouyinRequestSigner;

	constructor(options: DouyinSyncOptions = {}) {
		this.baseUrl = (options.baseUrl ?? DOUYIN_BASE_URL).replace(/\/$/, "");
		this.cookie = options.cookie?.trim() ?? "";
		this.transport = options.transport ?? obsidianDouyinTransport;
		this.signer = options.signer;
		if (!this.cookie && !options.transport) {
			throw new DouyinSyncError(
				"not-logged-in",
				"Douyin sync needs a logged-in web Cookie, or a custom browser transport.",
			);
		}
	}

	async getUserCollection(
		cursor = 0,
		count: number = DEFAULT_PAGE_SIZES.account,
	): Promise<DouyinApiPage> {
		const params = this.defaultParams();
		params.publish_video_strategy_type = "2";
		params.version_code = "170400";
		params.version_name = "17.4.0";
		return this.page(
			DOUYIN_FAVORITES_ENDPOINTS.accountCollection,
			"POST",
			params,
			{
				count: String(count),
				cursor: String(cursor),
			},
			{
				Referer: `${this.baseUrl}/user/self?showTab=favorite_collection`,
			},
			["aweme_list"],
		);
	}

	async getUserCollects(
		cursor = 0,
		count: number = DEFAULT_PAGE_SIZES.folders,
	): Promise<DouyinApiPage> {
		const params = this.collectParams(cursor, count);
		return this.page(
			DOUYIN_FAVORITES_ENDPOINTS.collectFolders,
			"GET",
			params,
			undefined,
			undefined,
			["collects_list"],
		);
	}

	async getCollectAweme(
		folderId: string,
		cursor = 0,
		count: number = DEFAULT_PAGE_SIZES.videos,
	): Promise<DouyinApiPage> {
		const params = this.collectParams(cursor, count);
		params.collects_id = folderId;
		return this.page(
			DOUYIN_FAVORITES_ENDPOINTS.collectVideos,
			"GET",
			params,
			undefined,
			undefined,
			["aweme_list"],
		);
	}

	private defaultParams(): Record<string, string | number> {
		const params: Record<string, string | number> = {
			device_platform: "webapp",
			aid: "6383",
			channel: "channel_pc_web",
			update_version_code: "170400",
			pc_client_type: "1",
			pc_libra_divert: "Windows",
			version_code: "170400",
			version_name: "17.4.0",
			cookie_enabled: "true",
			screen_width: "1536",
			screen_height: "864",
			browser_language: "zh-CN",
			browser_platform: "MacIntel",
			browser_name: "Chrome",
			browser_version: "139.0.0.0",
			browser_online: "true",
			engine_name: "Blink",
			engine_version: "139.0.0.0",
			os_name: "Mac OS",
			os_version: "10.15.7",
			cpu_core_num: "8",
			device_memory: "8",
			platform: "PC",
			downlink: "10",
			effective_type: "4g",
			round_trip_time: "200",
			support_h265: "1",
			support_dash: "1",
			uifid: "",
		};
		const msToken = cookieValue(this.cookie, "msToken");
		if (msToken) params.msToken = msToken;
		return params;
	}

	private collectParams(
		cursor: number,
		count: number,
	): Record<string, string | number> {
		return {
			...this.defaultParams(),
			cursor,
			count,
			version_code: "170400",
			version_name: "17.4.0",
		};
	}

	private async page(
		path: string,
		method: "GET" | "POST",
		params: Record<string, string | number>,
		body: Record<string, string> | undefined,
		extraHeaders: Record<string, string> | undefined,
		itemKeys: string[],
	): Promise<DouyinApiPage> {
		const query = new URLSearchParams(
			Object.entries(params).map(([key, value]) => [key, String(value)]),
		).toString();
		const request: DouyinHttpRequest = {
			path,
			url: `${this.baseUrl}${path}?${query}`,
			method,
			params,
			headers: {
				Accept: "*/*",
				"Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
				"User-Agent": DEFAULT_USER_AGENT,
				...(this.cookie ? { Cookie: this.cookie } : {}),
				...(method === "POST"
					? { "Content-Type": "application/x-www-form-urlencoded" }
					: {}),
				...(extraHeaders ?? {}),
			},
		};
		if (body) {
			request.body = new URLSearchParams(body).toString();
		}

		const signed = this.signer ? await this.signer(request) : request;
		let response: DouyinHttpResponse;
		try {
			response = await this.transport(signed);
		} catch (error) {
			if (error instanceof DouyinSyncError) throw error;
			throw new DouyinSyncError(
				"http",
				`Douyin request failed: ${path}`,
				{ path, cause: error },
			);
		}

		const raw = response.json ?? parseJson(response.text);
		if (response.status === 403 || response.status === 429) {
			throw new DouyinSyncError(
				"rate-limited",
				`Douyin temporarily rejected the request (${response.status}). Try again later.`,
				{ status: response.status, path },
			);
		}
		if (response.status >= 400) {
			throw new DouyinSyncError(
				"http",
				`Douyin returned HTTP ${response.status}.`,
				{ status: response.status, path },
			);
		}
		if (!isRecord(raw)) {
			throw new DouyinSyncError(
				"invalid-response",
				"Douyin returned a non-JSON response.",
				{ status: response.status, path },
			);
		}
		assertApiSuccess(raw, path);
		return normalizePage(raw, itemKeys);
	}
}

/** Sync account collection + every custom folder into one deduplicated snapshot. */
export async function syncDouyinFavorites(
	options: DouyinSyncOptions = {},
): Promise<DouyinFavoritesSnapshot> {
	const client = new DouyinFavoritesClient(options);
	const pageLimit = positiveInt(options.maxPages, DEFAULT_PAGE_LIMIT);
	const sizes = {
		account: positiveInt(options.pageSize?.account, DEFAULT_PAGE_SIZES.account),
		folders: positiveInt(options.pageSize?.folders, DEFAULT_PAGE_SIZES.folders),
		videos: positiveInt(options.pageSize?.videos, DEFAULT_PAGE_SIZES.videos),
	};
	const warnings: string[] = [];
	const items = new Map<string, DouyinFavoriteItem>();

	const accountPages = await walkPages(
		(cursor) => client.getUserCollection(cursor, sizes.account),
		pageLimit,
		(page, pageNumber) => {
			options.onProgress?.({
				stage: "account",
				page: pageNumber,
				items: page.items.length,
			});
		},
		(message) => warnings.push(`account collection: ${message}`),
	);
	let accountItems = 0;
	for (const raw of accountPages.items) {
		const item = normalizeDouyinFavoriteItem(raw, { source: "account" });
		if (!item) continue;
		accountItems++;
		mergeFavorite(items, item);
	}

	const folderPages = await walkPages(
		(cursor) => client.getUserCollects(cursor, sizes.folders),
		pageLimit,
		(page, pageNumber) => {
			options.onProgress?.({
				stage: "folders",
				page: pageNumber,
				items: page.items.length,
			});
		},
		(message) => warnings.push(`collect folders: ${message}`),
	);
	const folders: DouyinFavoriteFolder[] = [];
	const seenFolders = new Set<string>();
	for (const raw of folderPages.items) {
		const folder = normalizeDouyinFavoriteFolder(raw);
		if (!folder || seenFolders.has(folder.id)) continue;
		seenFolders.add(folder.id);
		folders.push(folder);
	}

	let folderItems = 0;
	for (const folder of folders) {
		const folderPagesResult = await walkPages(
			(cursor) => client.getCollectAweme(folder.id, cursor, sizes.videos),
			pageLimit,
			(page, pageNumber) => {
				options.onProgress?.({
					stage: "folder-videos",
					folderId: folder.id,
					folderName: folder.name,
					page: pageNumber,
					items: page.items.length,
				});
			},
			(message) => warnings.push(`folder ${folder.name || folder.id}: ${message}`),
		);
		for (const raw of folderPagesResult.items) {
			const item = normalizeDouyinFavoriteItem(raw, {
				source: "folder",
				folderId: folder.id,
				folderName: folder.name,
			});
			if (!item) continue;
			folderItems++;
			mergeFavorite(items, item);
		}
	}

	return {
		version: 1,
		syncedAt: (options.now ?? Date.now)(),
		items: [...items.values()],
		folders,
		warnings,
		counts: {
			accountItems,
			folderItems,
			uniqueItems: items.size,
		},
	};
}

/** Walk a Douyin cursor chain and stop safely on an empty or stalled page. */
export async function walkPages<T>(
	fetchPage: (cursor: number) => Promise<DouyinApiPage>,
	maxPages = DEFAULT_PAGE_LIMIT,
	onPage?: (page: DouyinApiPage, pageNumber: number) => void,
	onWarning?: (message: string) => void,
): Promise<PageWalkResult<T>> {
	const items: T[] = [];
	let cursor = 0;
	const limit = positiveInt(maxPages, DEFAULT_PAGE_LIMIT);

	for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
		const page = await fetchPage(cursor);
		onPage?.(page, pageNumber);
		items.push(...(page.items as T[]));
		if (!page.hasMore || page.items.length === 0) {
			return { items, pages: pageNumber };
		}
		if (page.nextCursor === cursor) {
			onWarning?.(`cursor did not advance at ${cursor}; stopped this walk`);
			return { items, pages: pageNumber };
		}
		cursor = page.nextCursor;
	}

	onWarning?.(`reached the ${limit}-page safety limit; stopped this walk`);
	return { items, pages: limit };
}

/** Convert a raw aweme object into the stable persistence shape. */
export function normalizeDouyinFavoriteItem(
	input: unknown,
	context: {
		source: "account" | "folder";
		folderId?: string;
		folderName?: string;
	},
): DouyinFavoriteItem | null {
	if (!isRecord(input)) return null;
	const raw = isRecord(input.aweme_info) ? input.aweme_info : input;
	const awemeId = firstString(raw, ["aweme_id", "aweme_id_str", "id"]);
	if (!awemeId) return null;

	const author = isRecord(raw.author) ? raw.author : undefined;
	const title = firstString(raw, ["desc", "title"]);
	const coverUrl = firstUrl([
		valueAt(raw, ["video", "cover", "url_list", 0]),
		valueAt(raw, ["video", "dynamic_cover", "url_list", 0]),
		valueAt(raw, ["cover", "url_list", 0]),
		valueAt(raw, ["images", 0, "url_list", 0]),
		valueAt(raw, ["cover_url"]),
	]);
	const normalized: DouyinFavoriteItem = {
		awemeId,
		title,
		description: firstString(raw, ["desc", "description"]),
		author: firstString(author, ["nickname", "name", "unique_id"]),
		authorSecUid: firstString(author, ["sec_uid", "sec_user_id"]),
		coverUrl,
		shareUrl:
			firstString(raw, ["share_url", "share_url_web"]) ||
			`${DOUYIN_BASE_URL}/video/${encodeURIComponent(awemeId)}`,
		createTime: numberOrNull(raw.create_time),
		folderIds: context.folderId ? [context.folderId] : [],
		folderNames: context.folderName ? [context.folderName] : [],
		sources: [context.source],
		raw,
	};
	return normalized;
}

/** Convert a raw folder object into a stable folder record. */
export function normalizeDouyinFavoriteFolder(
	input: unknown,
): DouyinFavoriteFolder | null {
	if (!isRecord(input)) return null;
	const info = isRecord(input.collects_info) ? input.collects_info : input;
	const id = firstString(info, ["collects_id", "collects_id_str", "id"]);
	if (!id) return null;
	return {
		id,
		name: firstString(info, ["name", "collects_name", "title"]) || "未命名收藏夹",
		count: numberOrNull(info.video_count ?? info.count ?? info.aweme_count),
		raw: input,
	};
}

/** Normalise one endpoint response, accepting the shapes used by Douyin web APIs. */
export function normalizePage(raw: JsonRecord, itemKeys: string[]): DouyinApiPage {
	const candidates: JsonRecord[] = [raw];
	if (isRecord(raw.data)) candidates.push(raw.data);
	let items: JsonRecord[] = [];
	for (const candidate of candidates) {
		for (const key of itemKeys) {
			const value = candidate[key];
			if (Array.isArray(value)) {
				items = value.filter(isRecord);
				break;
			}
		}
		if (items.length > 0) break;
	}
	const nextCursor = numberOrDefault(
		firstValue(candidates, ["max_cursor", "cursor", "next_cursor"]),
		0,
	);
	const hasMore = booleanValue(
		firstValue(candidates, ["has_more", "hasMore", "has_next"]),
	);
	return { items, hasMore, nextCursor, raw };
}

function mergeFavorite(target: Map<string, DouyinFavoriteItem>, item: DouyinFavoriteItem): void {
	const existing = target.get(item.awemeId);
	if (!existing) {
		target.set(item.awemeId, item);
		return;
	}

	const folderIds = uniqueStrings([...existing.folderIds, ...item.folderIds]);
	const folderNames = uniqueStrings([...existing.folderNames, ...item.folderNames]);
	const sources = uniqueStrings([...existing.sources, ...item.sources]) as (
		| "account"
		| "folder"
	)[];
	target.set(item.awemeId, {
		...existing,
		title: existing.title || item.title,
		description: existing.description || item.description,
		author: existing.author || item.author,
		authorSecUid: existing.authorSecUid || item.authorSecUid,
		coverUrl: existing.coverUrl || item.coverUrl,
		shareUrl: existing.shareUrl || item.shareUrl,
		createTime: existing.createTime ?? item.createTime,
		folderIds,
		folderNames,
		sources,
		raw: existing.raw,
	});
}

function assertApiSuccess(raw: JsonRecord, path: string): void {
	const statusCode = numberOrNull(raw.status_code);
	const statusMessage = firstString(raw, ["status_msg", "message"]);
	if (
		statusCode === 2483 ||
		/请先登录|用户未登录|not.?logged.?in/i.test(statusMessage)
	) {
		throw new DouyinSyncError(
			"not-logged-in",
			"Douyin session is not logged in or has expired.",
			{ status: statusCode ?? undefined, path },
		);
	}
	if (statusCode !== null && statusCode !== 0) {
		throw new DouyinSyncError(
			"api",
			statusMessage || `Douyin API returned status_code ${statusCode}.`,
			{ status: statusCode, path },
		);
	}
}

function parseJson(text: string | undefined): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function cookieValue(cookie: string, name: string): string {
	const part = cookie.split(";").find((entry) => entry.trim().startsWith(`${name}=`));
	return part?.trim().slice(name.length + 1) ?? "";
}

function valueAt(value: unknown, path: (string | number)[]): unknown {
	let current: unknown = value;
	for (const key of path) {
		if (typeof key === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[key];
		} else {
			if (!isRecord(current)) return undefined;
			current = current[key];
		}
	}
	return current;
}

function firstValue(values: JsonRecord[], keys: string[]): unknown {
	for (const value of values) {
		for (const key of keys) {
			if (value[key] !== undefined && value[key] !== null) return value[key];
		}
	}
	return undefined;
}

function firstString(value: JsonRecord | undefined, keys: string[]): string {
	if (!value) return "";
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
		if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
	}
	return "";
}

function firstUrl(values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
			return value.trim();
		}
	}
	return "";
}

function numberOrNull(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function numberOrDefault(value: unknown, fallback: number): number {
	return numberOrNull(value) ?? fallback;
}

function booleanValue(value: unknown): boolean {
	if (value === true || value === 1 || value === "1" || value === "true") return true;
	return false;
}

function positiveInt(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

/** Keep user-configured vault paths relative and JSON-shaped. */
export function normalizeDouyinStoragePath(path?: string): string {
	const value = path?.trim().replace(/\\/g, "/");
	if (!value) return DEFAULT_DOUYIN_STORAGE_PATH;
	const parts = value.split("/");
	if (
		value.startsWith("/") ||
		parts.some((part) => !part || part === "." || part === "..")
	) {
		return DEFAULT_DOUYIN_STORAGE_PATH;
	}
	return value.toLowerCase().endsWith(".json") ? value : `${value}.json`;
}

/** Minimal runtime guard for snapshots read from a user-editable vault file. */
export function isDouyinFavoritesSnapshot(
	value: unknown,
): value is DouyinFavoritesSnapshot {
	if (!isRecord(value) || value.version !== 1) return false;
	return Array.isArray(value.items) && Array.isArray(value.folders);
}

async function ensureVaultParent(vault: Vault, filePath: string): Promise<void> {
	const parts = filePath.split("/");
	parts.pop();
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!vault.getFolderByPath(current)) await vault.createFolder(current);
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
