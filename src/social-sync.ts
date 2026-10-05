import { normalizePath, requestUrl, TFile, type Vault } from "obsidian";
import type { SocialSource } from "./types";

type JsonRecord = Record<string, unknown>;

export interface SocialSyncItem {
	id: string;
	title: string;
	url: string;
}

/** How a save run turned out: brand-new notes vs. re-synced (overwritten) ones,
 * plus each written note's path so callers can index it. */
export interface SaveStats {
	created: number;
	updated: number;
	total: number;
	entries: { id: string; title: string; url: string; path: string }[];
}

function record(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
		// Zhihu's v4 API returns collection/content IDs as JSON numbers in some
		// responses and strings in others. Treat finite numbers as IDs instead of
		// dropping the whole item during normalization.
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return "";
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

async function getJson(url: string, credential: string): Promise<JsonRecord> {
	const response = await requestUrl({
		url,
		method: "GET",
		headers: {
			Cookie: credential,
			Accept: "application/json, text/plain, */*",
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/139 Safari/537.36",
		},
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
	return record(response.json);
}

export async function syncZhihuCollections(
	credential: string,
	limit = 100,
	knownIds: ReadonlySet<string> = new Set(),
): Promise<SocialSyncItem[]> {
	const boundedLimit = Math.max(1, Math.min(1000, Math.round(limit)));
	const me = await getJson("https://www.zhihu.com/api/v4/me", credential);
	const token = text(me.url_token, me.id);
	if (!token) throw new Error("Zhihu login Cookie is invalid");
	const collections = await getJson(
		`https://www.zhihu.com/api/v4/people/${encodeURIComponent(token)}/collections?limit=50&offset=0`,
		credential,
	);
	const items: SocialSyncItem[] = [];
	const seenContent = new Set<string>();
	const knownContent = new Set<string>();
	// Stored Zhihu IDs include a collection prefix. Compare the type + content ID
	// as well, so an item moved to a different collection is still recognized.
	for (const existingId of knownIds) {
		const match = /^.*-([^-]+)-(.+)$/.exec(existingId);
		if (match) knownContent.add(`${match[1]}-${match[2]}`);
	}
	const pageSize = 20;
	for (const collection of array(collections.data).map(record)) {
		if (items.length >= boundedLimit) break;
		const collectionId = text(collection.id);
		if (!collectionId) continue;
		let offset = 0;
		let foundExisting = false;
		// Each collection is ordered independently; stop paging it at the first
		// previously synced item, then continue with the user's other collections.
		while (items.length < boundedLimit && !foundExisting) {
			const page = await getJson(
				`https://www.zhihu.com/api/v4/collections/${encodeURIComponent(collectionId)}/items?limit=${pageSize}&offset=${offset}`,
				credential,
			);
			const rows = array(page.data).map(record);
			if (rows.length === 0) break;
			for (const row of rows) {
				const content = record(row.content);
				const type = text(content.type) || "answer";
				const id = text(content.id);
				if (!id) continue;
				const contentKey = `${type}-${id}`;
				if (knownContent.has(contentKey)) {
					foundExisting = true;
					break;
				}
				if (seenContent.has(contentKey)) continue;
				seenContent.add(contentKey);
				const question = record(content.question);
				const title = text(content.title, question.title, content.excerpt) || `知乎收藏 ${id}`;
				const questionId = text(question.id);
				const url = type === "article"
					? `https://zhuanlan.zhihu.com/p/${id}`
					: questionId
						? `https://www.zhihu.com/question/${questionId}/answer/${id}`
						: `https://www.zhihu.com/answer/${id}`;
				items.push({ id: `${collectionId}-${type}-${id}`, title, url });
				if (items.length >= boundedLimit) return items;
			}
			if (foundExisting || rows.length < pageSize) break;
			offset += pageSize;
		}
	}
	return items;
}

/** Read the signed-in user's own favorite folders and video URLs. The
 * endpoint is an internal Bilibili web API, so keep requests sequential and
 * spaced out to avoid hammering it on large libraries. */
export async function syncBilibiliFavorites(
	cookie: string,
	limit = 500,
	knownIds: ReadonlySet<string> = new Set(),
): Promise<SocialSyncItem[]> {
	const boundedLimit = Math.max(1, Math.min(1000, Math.round(limit)));
	const nav = await getBilibiliData("https://api.bilibili.com/x/web-interface/nav", cookie, "https://www.bilibili.com/");
	if (nav.isLogin !== true && nav.isLogin !== 1) throw new Error("Bilibili login Cookie is invalid or expired");
	const mid = text(nav.mid);
	if (!mid) throw new Error("Bilibili did not return the logged-in user id");
	const referer = `https://space.bilibili.com/${mid}/favlist`;

	const foldersData = await getBilibiliData(
		`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(mid)}`,
		cookie,
		referer,
	);
	if (!Array.isArray(foldersData.list)) {
		throw new Error("Bilibili did not return the favorite folder list; the request may need login or retrying");
	}

	const items: SocialSyncItem[] = [];
	const seen = new Set<string>();
	const pageSize = 20;
	for (const rawFolder of foldersData.list) {
		if (items.length >= boundedLimit) break;
		const folder = record(rawFolder);
		const mediaId = text(folder.id, folder.media_id);
		if (!mediaId) continue;

		let foundExisting = false;
		// Bilibili orders each favorite folder independently, so stop only this
		// folder at its first known video and continue checking other folders.
		for (let pn = 1; items.length < boundedLimit && !foundExisting; pn++) {
			const query = new URLSearchParams({ media_id: mediaId, pn: String(pn), ps: String(pageSize) });
			const page = await getBilibiliData(
				`https://api.bilibili.com/x/v3/fav/resource/list?${query.toString()}`,
				cookie,
				referer,
			);
			const videos = Array.isArray(page.medias) ? page.medias : array(page.list);
			if (videos.length === 0) break;

			for (const rawVideo of videos) {
				if (items.length >= boundedLimit) break;
				const video = record(rawVideo);
				const bvid = text(video.bvid);
				const aid = text(video.id, video.oid, video.aid);
				const id = bvid || (aid ? `av${aid}` : "");
				if (!id) continue;
				const oldAidId = aid ? `av${aid}` : "";
				if (knownIds.has(id) || (oldAidId && knownIds.has(oldAidId))) {
					foundExisting = true;
					break;
				}
				if (seen.has(id)) continue;
				seen.add(id);
				items.push({
					id,
					title: text(video.title) || `Bilibili 收藏 ${id}`,
					url: `https://www.bilibili.com/video/${bvid || `av${aid}`}`,
				});
			}

			if (foundExisting || page.has_more === false || videos.length < pageSize) break;
			await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
		}
	}
	return items;
}

async function getBilibiliData(url: string, cookie: string, referer: string): Promise<JsonRecord> {
	const response = await requestUrl({
		url,
		method: "GET",
		headers: {
			Cookie: cookie,
			Referer: referer,
			Accept: "application/json, text/plain, */*",
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/139 Safari/537.36",
		},
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Bilibili API returned HTTP ${response.status}`);
	}
	let payload: unknown;
	try {
		payload = response.json;
	} catch {
		throw new Error("Bilibili returned a non-JSON response; the request may have been rate-limited");
	}
	const envelope = record(payload);
	const code = finiteNumber(envelope.code);
	if (code !== 0) {
		throw new Error(text(envelope.message, envelope.msg) || `Bilibili API error (${String(envelope.code ?? "unknown")})`);
	}
	const data = envelope.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("Bilibili returned no data; the request may require login or retrying");
	}
	return data as JsonRecord;
}

function finiteNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function safeFilename(value: string): string {
	return value.replace(/[\\/:*?"<>|#^[\]]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "收藏";
}

/** The vault path a favorite's note is written to. Exported so the favorites
 * index can record the same path the save produced. */
export function favoriteNotePath(folder: string, item: SocialSyncItem): string {
	return normalizePath(`${normalizePath(folder)}/${safeFilename(item.title)} - ${safeFilename(item.id)}.md`);
}

async function ensureFolder(vault: Vault, folder: string): Promise<void> {
	const parts = normalizePath(folder).split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
	}
}

export async function saveSocialSyncItems(
	vault: Vault,
	folder: string,
	source: SocialSource,
	items: SocialSyncItem[],
): Promise<SaveStats> {
	const target = normalizePath(folder);
	await ensureFolder(vault, target);
	let created = 0;
	let updated = 0;
	const saved: SaveStats["entries"] = [];
	for (const item of items) {
		const path = favoriteNotePath(target, item);
		const body = [
			"---",
			`source: ${JSON.stringify(source)}`,
			`source_id: ${JSON.stringify(item.id)}`,
			`title: ${JSON.stringify(item.title)}`,
			`url: ${JSON.stringify(item.url)}`,
			`synced_at: ${JSON.stringify(new Date().toISOString())}`,
			"---",
			"",
			`# ${item.title}`,
			"",
			item.url ? `[查看原文](${item.url})` : "",
			"",
		].filter((line) => line !== "").join("\n");
		const existing = vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await vault.modify(existing, body);
			updated++;
		} else {
			await vault.create(path, body);
			created++;
		}
		saved.push({ id: item.id, title: item.title, url: item.url, path });
	}
	return { created, updated, total: items.length, entries: saved };
}

/** Prepend a run's report under the log note's H1 so the newest run is on top.
 * Returns the log file's vault path. `folder` is the shared parent of the
 * source folders (may be "" for the vault root). */
export async function writeSyncLog(
	vault: Vault,
	folder: string,
	fileName: string,
	titleLine: string,
	section: string,
): Promise<string> {
	const dir = folder ? normalizePath(folder) : "";
	if (dir) await ensureFolder(vault, dir);
	const path = normalizePath(dir ? `${dir}/${fileName}` : fileName);
	let prior = "";
	const existing = vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		// Drop a leading "# title" line so we don't stack duplicate headings.
		prior = (await vault.read(existing)).replace(/^#[^\n]*\n+/, "").trim();
	}
	const body = `${titleLine}\n\n${section}${prior ? `\n\n---\n\n${prior}` : ""}\n`;
	if (existing instanceof TFile) await vault.modify(existing, body);
	else await vault.create(path, body);
	return path;
}
