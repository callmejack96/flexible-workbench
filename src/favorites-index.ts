/**
 * The shared favorites "database": a small JSON index for synced social favorites,
 * including their Review state and optional category.
 *
 * It lives beside the plugin's settings — `${configDir}/plugins/<id>/favorites-index.json`
 * — rather than in data.json, so a few hundred entries never bloat the settings
 * blob nor trigger a view refresh on every write. Review state and personal
 * categories live here (not in note frontmatter) so both content cards share
 * the same values.
 *
 * Synced Markdown notes remain the source of truth for favorite existence.
 * Legacy manual records are tolerated while reading older indexes, but are not
 * included in the content favorites manager.
 */
import { normalizePath, type DataAdapter } from "obsidian";
import type { FavoriteSource } from "./types";

const INDEX_FILE = "favorites-index.json";

export interface FavoriteEntry {
	source: FavoriteSource;
	id: string;
	title: string;
	url: string;
	/** Synced note path; empty only on legacy manual records. */
	path: string;
	syncedAt: string;
	archived: boolean;
	/** Optional personal category; unset synced entries use their source label. */
	category?: string;
	/** ISO timestamp of the last archive toggle to `true`. */
	archivedAt?: string;
}

export interface IndexData {
	version: 1;
	/** User-maintained category enum shared by every favorite. */
	categories: string[];
	/** Keyed by `${source}:${id}`. */
	entries: Record<string, FavoriteEntry>;
}

/** The subset of a plugin instance the index IO needs; kept minimal so tests
 * can pass a fake adapter without constructing a real plugin. */
export interface IndexHost {
	app: { vault: { configDir: string; adapter: Pick<DataAdapter, "exists" | "read" | "write" | "mkdir"> } };
	manifest: { dir?: string; id: string };
}

/** New favorite fields carried in from a sync; archived state is decided here. */
export type FavoriteSeed = Pick<FavoriteEntry, "source" | "id" | "title" | "url" | "path" | "syncedAt">
	& Partial<Pick<FavoriteEntry, "category">>;

export function entryKey(source: FavoriteSource, id: string): string {
	return `${source}:${id}`;
}

export function emptyIndex(): IndexData {
	return { version: 1, categories: [], entries: {} };
}

/** Insert a freshly-synced favorite, or refresh an existing one's metadata while
 * preserving its archived state — re-syncing must never un-archive. */
export function upsertEntry(data: IndexData, seed: FavoriteSeed): FavoriteEntry {
	const key = entryKey(seed.source, seed.id);
	const existing = data.entries[key];
	const entry: FavoriteEntry = existing
		? { ...existing, title: seed.title, url: seed.url, path: seed.path, syncedAt: seed.syncedAt }
		: { ...seed, archived: false };
	data.entries[key] = entry;
	return entry;
}

/** Set a single entry's archived flag. Returns false if the key is unknown. */
export function setArchived(data: IndexData, key: string, archived: boolean): boolean {
	const entry = data.entries[key];
	if (!entry) return false;
	entry.archived = archived;
	if (archived) entry.archivedAt = new Date().toISOString();
	else delete entry.archivedAt;
	return true;
}

export function isArchived(data: IndexData, source: FavoriteSource, id: string): boolean {
	return data.entries[entryKey(source, id)]?.archived ?? false;
}

/** Entries as an array, optionally filtered by source and/or archived state. */
export function listEntries(
	data: IndexData,
	filter: { source?: FavoriteSource; archived?: boolean } = {},
): FavoriteEntry[] {
	return Object.values(data.entries).filter((entry) => {
		if (filter.source && entry.source !== filter.source) return false;
		if (filter.archived !== undefined && entry.archived !== filter.archived) return false;
		return true;
	});
}

/** Remove an entry (used when its note was deleted). Returns false if unknown. */
export function removeEntry(data: IndexData, key: string): boolean {
	if (!data.entries[key]) return false;
	delete data.entries[key];
	return true;
}

/** Parse persisted JSON tolerantly: drop malformed entries rather than throw, so
 * a hand-edited or partially-written file still loads what it can. */
export function normalizeIndex(raw: unknown): IndexData {
	const out = emptyIndex();
	if (!isRecord(raw)) return out;
	if (Array.isArray(raw.categories)) {
		out.categories = [...new Set(raw.categories
			.filter((category): category is string => typeof category === "string")
			.map((category) => category.trim())
			.filter(Boolean))];
	}
	const entries = isRecord(raw.entries) ? raw.entries : {};
	for (const [key, value] of Object.entries(entries)) {
		if (!isRecord(value)) continue;
		const source = value.source;
		const id = str(value.id);
		if (!isFavoriteSource(source) || !id) continue;
		out.entries[key] = {
			source,
			id,
			title: str(value.title),
			url: str(value.url),
			path: str(value.path),
			syncedAt: str(value.syncedAt),
			archived: value.archived === true,
			...(str(value.category) ? { category: str(value.category) } : {}),
			...(str(value.archivedAt) ? { archivedAt: str(value.archivedAt) } : {}),
		};
	}
	return out;
}

function indexPath(host: IndexHost): string {
	const pluginDir =
		host.manifest.dir ??
		normalizePath(`${host.app.vault.configDir}/plugins/${host.manifest.id}`);
	return normalizePath(`${pluginDir}/${INDEX_FILE}`);
}

export async function loadIndex(host: IndexHost): Promise<IndexData> {
	const adapter = host.app.vault.adapter;
	const path = indexPath(host);
	try {
		if (!await adapter.exists(path)) return emptyIndex();
		return normalizeIndex(JSON.parse(await adapter.read(path)));
	} catch (error) {
		console.error("Flexible Workbench: could not read favorites index", error);
		return emptyIndex();
	}
}

export async function saveIndex(host: IndexHost, data: IndexData): Promise<void> {
	const adapter = host.app.vault.adapter;
	const path = indexPath(host);
	const parent = path.slice(0, path.lastIndexOf("/"));
	if (parent && !await adapter.exists(parent)) await adapter.mkdir(parent);
	await adapter.write(path, `${JSON.stringify(data, null, 2)}\n`);
	for (const listener of indexChangedListeners) {
		try {
			listener();
		} catch (error) {
			console.error("Flexible Workbench: favorites index listener failed", error);
		}
	}
}

const indexChangedListeners = new Set<() => void>();

/** Subscribe to saved or reviewed favorite changes so both cards stay in sync. */
export function onIndexChanged(listener: () => void): () => void {
	indexChangedListeners.add(listener);
	return () => indexChangedListeners.delete(listener);
}

function isFavoriteSource(value: unknown): value is FavoriteSource {
	return value === "rednote" || value === "wechat" || value === "douyin" ||
		value === "zhihu" || value === "bilibili" || value === "manual";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}
