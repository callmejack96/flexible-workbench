/**
 * WeChat 公众号 favorites via Tencent IMA (ima.copilot) Open API.
 *
 * WeChat has no API for 收藏, but IMA ingests 公众号 articles into a knowledge
 * base, and its Open API (docs: ima.qq.com/agent-interface) exposes them:
 *   get_addable_knowledge_base_list → get_knowledge_list (title) → get_media_info (link)
 * For a 公众号 article (media_type 6), get_media_info's url_info.url is the
 * original mp.weixin.qq.com/s article link. We keep title + that link.
 *
 * Setup (user): get a Client ID + API Key at https://ima.qq.com/agent-interface
 * and paste them into the WeChat credential field as "clientId:apiKey"
 * (optionally "clientId:apiKey:kbNameOrId" to pin a specific knowledge base).
 *
 * Endpoints/shapes per the official IMA knowledge-base API reference.
 */
import { requestUrl } from "obsidian";
import { t } from "./i18n";
import type { SocialSyncItem } from "./social-sync";

const BASE_URL = "https://ima.qq.com";
/** Bound the recursive KB crawl so a huge base can't spin forever. */
const MAX_ITEMS_SCANNED = 2000;

type JsonRecord = Record<string, unknown>;

interface KnowledgeBase {
	id: string;
	name: string;
}

interface KnowledgeItem {
	media_id: string;
	title: string;
}

export interface ImaCredential {
	clientId: string;
	apiKey: string;
	/** Optional knowledge-base selector: exact id, or a name to match. */
	kbSelector: string;
}

export class ImaError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
		this.name = "ImaError";
	}
}

/** Split the pasted "clientId:apiKey[:kbNameOrId]" WeChat credential. */
export function splitImaCredential(raw: string): ImaCredential {
	// Only split into three parts: a KB name may itself contain ":".
	const first = (raw ?? "").indexOf(":");
	if (first < 0) return { clientId: (raw ?? "").trim(), apiKey: "", kbSelector: "" };
	const clientId = raw.slice(0, first).trim();
	const rest = raw.slice(first + 1);
	const second = rest.indexOf(":");
	if (second < 0) return { clientId, apiKey: rest.trim(), kbSelector: "" };
	return { clientId, apiKey: rest.slice(0, second).trim(), kbSelector: rest.slice(second + 1).trim() };
}

/** Choose the knowledge base to read: exact id, then exact name, then a name
 * substring, else the first one. */
export function pickKnowledgeBase(bases: KnowledgeBase[], selector: string): KnowledgeBase | undefined {
	const want = selector.trim();
	if (want) {
		return (
			bases.find((base) => base.id === want) ??
			bases.find((base) => base.name === want) ??
			bases.find((base) => base.name.includes(want)) ??
			bases[0]
		);
	}
	return bases[0];
}

/** Human-facing message from an IMA error (expired key is the common one). */
export function formatImaError(error: unknown): string {
	if (error instanceof ImaError && error.code === 200002) return t().cards.social.imaKeyExpired;
	return error instanceof Error ? error.message : String(error);
}

export async function readImaFavorites(
	credential: ImaCredential,
	options: { limit?: number; knownIds?: ReadonlySet<string> } = {},
): Promise<SocialSyncItem[]> {
	const { clientId, apiKey, kbSelector } = credential;
	const limit = Math.max(1, Math.min(1000, Math.round(options.limit ?? 100)));

	const bases = await listKnowledgeBases(clientId, apiKey);
	const kb = pickKnowledgeBase(bases, kbSelector);
	// A pasted selector that isn't in the list may still be a valid KB id.
	const kbId = kb?.id || kbSelector.trim();
	if (!kbId) throw new Error(t().cards.social.imaNoKb);

	const items = await listKnowledgeItems(clientId, apiKey, kbId, limit, options.knownIds ?? new Set());
	const out: SocialSyncItem[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (out.length >= limit) break;
		if (!item.media_id || seen.has(item.media_id)) continue;
		const url = await mediaUrl(clientId, apiKey, item.media_id);
		if (!/^https?:\/\//i.test(url)) continue;
		seen.add(item.media_id);
		out.push({ id: item.media_id, title: item.title.trim() || `微信收藏 ${item.media_id}`, url });
	}
	return out;
}

/** The user's own knowledge bases (those they can add content to). */
async function listKnowledgeBases(clientId: string, apiKey: string): Promise<KnowledgeBase[]> {
	const bases: KnowledgeBase[] = [];
	let cursor = "";
	do {
		const data = await post(clientId, apiKey, "openapi/wiki/v1/get_addable_knowledge_base_list", {
			cursor,
			limit: 50,
		});
		for (const entry of asArray(data.addable_knowledge_base_list ?? data.info_list)) {
			if (isRecord(entry) && str(entry.id)) bases.push({ id: str(entry.id), name: str(entry.name) });
		}
		cursor = data.is_end ? "" : str(data.next_cursor);
	} while (cursor);
	return bases;
}

/** Recursively enumerate files in a KB (folders are entries with folder_id). */
async function listKnowledgeItems(
	clientId: string,
	apiKey: string,
	kbId: string,
	limit: number,
	knownIds: ReadonlySet<string>,
): Promise<KnowledgeItem[]> {
	const out: KnowledgeItem[] = [];
	const seenIds = new Set<string>();
	const walk = async (folderId: string): Promise<void> => {
		let cursor = "";
		do {
			if (out.length >= limit || out.length >= MAX_ITEMS_SCANNED) return;
			let foundKnown = false;
			const body: JsonRecord = { knowledge_base_id: kbId, cursor, limit: 50 };
			if (folderId) body.folder_id = folderId;
			const data = await post(clientId, apiKey, "openapi/wiki/v1/get_knowledge_list", body);
			for (const entry of asArray(data.knowledge_list)) {
				if (!isRecord(entry)) continue;
				const mediaId = str(entry.media_id);
				if (mediaId) {
					if (knownIds.has(mediaId)) {
						foundKnown = true;
						break;
					}
					if (seenIds.has(mediaId)) continue;
					seenIds.add(mediaId);
					out.push({ media_id: mediaId, title: str(entry.title) });
					continue;
				}
				const folderInfo = entry.folder_info;
				const subFolder = str(entry.folder_id) || (isRecord(folderInfo) ? str(folderInfo.folder_id) : "");
				if (subFolder) await walk(subFolder);
			}
			if (foundKnown) break;
			cursor = data.is_end ? "" : str(data.next_cursor);
		} while (cursor && out.length < limit);
	};
	await walk("");
	return out;
}

async function mediaUrl(clientId: string, apiKey: string, mediaId: string): Promise<string> {
	try {
		const data = await post(clientId, apiKey, "openapi/wiki/v1/get_media_info", { media_id: mediaId });
		return isRecord(data.url_info) ? str(data.url_info.url) : "";
	} catch {
		// A single unreadable item (parse in progress, note-type, deleted) is skipped.
		return "";
	}
}

async function post(clientId: string, apiKey: string, path: string, body: unknown): Promise<JsonRecord> {
	const response = await requestUrl({
		url: `${BASE_URL}/${path}`,
		method: "POST",
		headers: {
			"ima-openapi-clientid": clientId,
			"ima-openapi-apikey": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		throw: false,
	});
	const result: unknown = response.json;
	if (!isRecord(result)) throw new ImaError(-1, `HTTP ${response.status} (non-JSON response)`);
	// IMA uses code/msg on some endpoints and retcode/errmsg on others.
	const code = num(result.retcode ?? result.code ?? -1);
	if (code !== 0) throw new ImaError(code, str(result.errmsg ?? result.msg) || "unknown error");
	return isRecord(result.data) ? result.data : {};
}

function folderRecord(value: unknown): JsonRecord | undefined {
	return isRecord(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

function num(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return -1;
}
