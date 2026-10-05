import { Component, normalizePath, Notice, setIcon, Setting, TFile } from "obsidian";
import { emptyState } from "../cardbodies";
import { extractBrowserCookie } from "../browser-cookie";
import { scrapeDouyinFavorites } from "../douyin-browser";
import { readImaFavorites, splitImaCredential, formatImaError } from "../ima-favorites";
import { scrapeRednoteFavorites } from "../rednote-browser";
import { FavoritesArchiveModal } from "../favorites-archive-modal";
import {
	emptyIndex,
	isArchived,
	listEntries,
	loadIndex,
	onIndexChanged,
	saveIndex,
	upsertEntry,
	type IndexData,
} from "../favorites-index";
import { t } from "../i18n";
import type { DashboardCard, SocialConfig, SocialSource } from "../types";
import {
	saveSocialSyncItems,
	syncBilibiliFavorites,
	syncZhihuCollections,
	writeSyncLog,
	type SaveStats,
} from "../social-sync";
import { makeClickable } from "../ui";
import type { HomeView } from "../view";
import type { CardDefinition, CardEditorContext } from "./definition";

export const DEFAULT_SOCIAL_FOLDERS = {
	rednote: "raw/red",
	wechat: "raw/wechat",
	douyin: "raw/douyin",
	zhihu: "raw/zhihu",
	bilibili: "raw/bilibili",
} as const;

const SOCIAL_SOURCES: SocialSource[] = ["rednote", "wechat", "douyin", "zhihu", "bilibili"];

const activeSources = new WeakMap<DashboardCard, SocialSource>();
const syncingSources = new WeakMap<DashboardCard, Set<SocialSource | "all">>();
/** Per-card cached favorites index (archived flags). Loaded once, kept in sync
 * on every sync, and shared by reference with the archive modal. */
const indexByCard = new WeakMap<DashboardCard, IndexData>();
/** Per-card inbox/archived view toggle. Ephemeral; defaults to the inbox. */
const archivedFilter = new WeakMap<DashboardCard, "unarchived" | "archived">();

const SOURCE_ICONS: Record<SocialSource, string> = {
	rednote: "heart",
	wechat: "message-circle",
	douyin: "music-2",
	zhihu: "circle-help",
	bilibili: "tv",
};

function folderFor(cfg: SocialConfig, source: SocialSource): string {
	const configured = {
		rednote: cfg.rednoteFolder,
		wechat: cfg.wechatFolder,
		douyin: cfg.douyinFolder,
		zhihu: cfg.zhihuFolder,
		bilibili: cfg.bilibiliFolder,
	}[source];
	return normalizePath(configured?.trim() || DEFAULT_SOCIAL_FOLDERS[source]);
}

export function renderSocial(
	view: HomeView,
	card: DashboardCard,
	body: HTMLElement,
	component: Component,
): void {
	const cfg = card.social ?? {};
	let active = activeSources.get(card) ?? cfg.initialSource ?? "rednote";
	if (!SOCIAL_SOURCES.includes(active)) active = "rednote";

	const wrap = body.createDiv("flexible-workbench-social");
	let destroyed = false;
	component.register(() => {
		destroyed = true;
	});
	const header = wrap.createDiv("flexible-workbench-social-header");
	const tabs = header.createDiv("flexible-workbench-social-tabs");
	tabs.setAttribute("role", "tablist");
	const syncAll = header.createEl("button", {
		cls: "flexible-workbench-social-sync-all",
		attr: { "aria-label": t().cards.social.syncAll },
	});
	setIcon(syncAll.createSpan("flexible-workbench-social-sync-all-icon"), "download-cloud");
	syncAll.createSpan({ cls: "flexible-workbench-social-sync-all-label", text: t().cards.social.syncAll });
	const manage = header.createEl("button", {
		cls: "flexible-workbench-social-manage",
		attr: { "aria-label": t().cards.social.archive.manage },
	});
	setIcon(manage.createSpan("flexible-workbench-social-manage-icon"), "archive");
	manage.createSpan({ cls: "flexible-workbench-social-manage-label", text: t().cards.social.archive.manage });
	const content = wrap.createDiv("flexible-workbench-social-content");

	// Load the archived-state index once per card; until it resolves, paint()
	// treats it as empty, so everything shows in the default inbox view.
	if (!indexByCard.has(card)) {
		indexByCard.set(card, emptyIndex());
		void loadIndex(view.plugin).then((data) => {
			indexByCard.set(card, data);
			if (!destroyed) paint();
		});
	}

	manage.addEventListener("click", () => {
		const index = indexByCard.get(card) ?? emptyIndex();
		indexByCard.set(card, index);
		new FavoritesArchiveModal(
			view.app,
			index,
			() => saveIndex(view.plugin, index),
			() => {
				if (!destroyed) paint();
			},
		).open();
	});

	function paint(): void {
		content.empty();
		for (const button of Array.from(tabs.querySelectorAll("button"))) {
			const selected = button.getAttribute("data-source") === active;
			button.toggleClass("is-active", selected);
			button.setAttribute("aria-selected", String(selected));
		}
		const syncingAll = syncingSources.get(card)?.has("all") ?? false;
		syncAll.disabled = syncingAll;
		syncAll.toggleClass("is-loading", syncingAll);
		renderVaultSource(view, card, cfg, active, content, () => {
			if (!destroyed) paint();
		});
	}

	component.register(onIndexChanged(() => {
		void loadIndex(view.plugin).then((data) => {
			if (destroyed) return;
			indexByCard.set(card, data);
			paint();
		});
	}));

	syncAll.addEventListener("click", () =>
		void syncAllSources(view, card, cfg, () => {
			if (!destroyed) paint();
		}),
	);

	for (const source of SOCIAL_SOURCES) {
		const label = t().cards.social.sources[source];
		const button = tabs.createEl("button", {
			cls: `flexible-workbench-social-tab is-${source}`,
			attr: {
				role: "tab",
				"data-source": source,
				"aria-label": label,
			},
		});
		setIcon(button.createSpan("flexible-workbench-social-tab-icon"), SOURCE_ICONS[source]);
		button.createSpan({ cls: "flexible-workbench-social-tab-label", text: label });
		button.addEventListener("click", () => {
			if (source === active) return;
			active = source;
			activeSources.set(card, source);
			paint();
		});
	}

	paint();
}

function renderVaultSource(
	view: HomeView,
	card: DashboardCard,
	cfg: SocialConfig,
	source: SocialSource,
	content: HTMLElement,
	repaint: () => void,
): void {
	const folder = folderFor(cfg, source);
	const prefix = `${folder}/`;
	const limit = Math.max(1, Math.min(100, Math.round(cfg.itemLimit ?? 12)));
	const index = indexByCard.get(card) ?? emptyIndex();
	const filter = archivedFilter.get(card) ?? "unarchived";
	const isFileArchived = (file: TFile): boolean => {
		const id = frontmatterSourceId(view, file);
		return id ? isArchived(index, source, id) : false;
	};
	const allFiles = view.app.vault
		.getMarkdownFiles()
		.filter((file) => file.path === folder || file.path.startsWith(prefix))
		.sort((a, b) => b.stat.mtime - a.stat.mtime);
	const inbox = allFiles.filter((file) => !isFileArchived(file));
	const archivedFiles = allFiles.filter((file) => isFileArchived(file));
	const files = filter === "archived" ? archivedFiles : inbox;

	const toolbar = content.createDiv("flexible-workbench-social-toolbar");
	toolbar.createDiv({
		cls: "flexible-workbench-social-summary",
		text: t().cards.social.summary(files.length, folder),
	});
	const filters = toolbar.createDiv("flexible-workbench-social-filter");
	const addFilter = (key: "unarchived" | "archived", label: string): void => {
		const button = filters.createEl("button", {
			cls: "flexible-workbench-social-filter-tab",
			text: label,
		});
		button.toggleClass("is-active", filter === key);
		button.setAttribute("aria-pressed", String(filter === key));
		button.addEventListener("click", () => {
			if (filter === key) return;
			archivedFilter.set(card, key);
			repaint();
		});
	};
	addFilter("unarchived", `${t().cards.social.archive.filterUnarchived} ${inbox.length}`);
	addFilter("archived", `${t().cards.social.archive.filterArchived} ${archivedFiles.length}`);
	const configure = toolbar.createEl("button", {
		cls: "flexible-workbench-social-action",
		attr: { "aria-label": t().cards.social.configure },
	});
	setIcon(configure, "settings-2");
	configure.addEventListener("click", () => {
		void import("../dashboard").then(({ openCardSettings }) => openCardSettings(view, card));
	});

	const active = syncingSources.get(card);
	const syncing = (active?.has(source) || active?.has("all")) ?? false;
	const sync = toolbar.createEl("button", {
		cls: "flexible-workbench-social-action flexible-workbench-social-sync",
		attr: { "aria-label": t().cards.social.sync },
	});
	setIcon(sync, "refresh-cw");
	sync.disabled = syncing;
	sync.toggleClass("is-loading", syncing);
	sync.addEventListener("click", () => void syncSource(view, card, cfg, source, folder, repaint));

	if (files.length === 0) {
		emptyState(content, SOURCE_ICONS[source], t().cards.social.empty(folder));
		return;
	}

	const list = content.createDiv("flexible-workbench-social-list");
	for (const file of files.slice(0, limit)) renderVaultItem(view, list, file, source);
	if (files.length > limit) {
		content.createDiv({
			cls: "flexible-workbench-social-more",
			text: t().cards.social.showing(limit, files.length),
		});
	}
}

/** Read a synced note's `source_id` frontmatter (string or numeric) for index lookup. */
function frontmatterSourceId(view: HomeView, file: TFile): string {
	const value: unknown = view.app.metadataCache.getFileCache(file)?.frontmatter?.source_id;
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

/** Source ids of favorites already saved under a source's folder — the vault is
 * the source of truth for "already have", so a deleted note is re-fetched. */
function existingSourceIds(view: HomeView, folder: string): Set<string> {
	const prefix = `${folder}/`;
	const ids = new Set<string>();
	for (const file of view.app.vault.getMarkdownFiles()) {
		if (file.path !== folder && !file.path.startsWith(prefix)) continue;
		const id = frontmatterSourceId(view, file);
		if (id) ids.add(id);
	}
	return ids;
}

/** Zhihu has no browser-context fallback and needs a login cookie that could
 * not be auto-detected. Callers decide whether to open settings or record it. */
class CredentialRequiredError extends Error {}

/** How many items a Sync pulls per source. Deliberately independent of
 * `itemLimit` (display count) and generous by default, so a Sync grabs the
 * whole favorites list instead of being throttled to the few rows on the card. */
function syncFetchLimit(cfg: SocialConfig): number {
	return Math.max(1, Math.min(1000, Math.round(cfg.syncLimit ?? 500)));
}

/** Outcome of syncing one source, used for the aggregated notice and the log. */
interface SyncOutcome {
	source: SocialSource;
	fetched: number;
	created: number;
	updated: number;
	/** Present when the source failed; the human-readable reason. */
	error?: string;
}

/** Record just-saved notes into the favorites index (new → unarchived; existing
 * keep their archived flag), persist it, refresh the card cache, and build the
 * sync outcome. Index-write failures are logged, never fatal to the sync. */
async function indexAndOutcome(
	view: HomeView,
	card: DashboardCard,
	source: SocialSource,
	fetched: number,
	stats: SaveStats,
): Promise<SyncOutcome> {
	const index = indexByCard.get(card) ?? await loadIndex(view.plugin);
	const syncedAt = new Date().toISOString();
	for (const entry of stats.entries) {
		upsertEntry(index, { source, id: entry.id, title: entry.title, url: entry.url, path: entry.path, syncedAt });
	}
	indexByCard.set(card, index);
	try {
		await saveIndex(view.plugin, index);
	} catch (error) {
		console.error("Flexible Workbench: failed to write favorites index", error);
	}
	return { source, fetched, created: stats.created, updated: stats.updated };
}

/** Sync one source end-to-end and return its stats. Throws on failure; callers
 * own the in-flight guard, notices, logging and repaint. */
async function runSourceSync(
	view: HomeView,
	card: DashboardCard,
	cfg: SocialConfig,
	source: SocialSource,
	folder: string,
): Promise<SyncOutcome> {
	// RedNote and Douyin read the user's own logged-in session in a webview, so
	// neither needs a pasted credential. Both are incremental: we hand the scraper
	// the ids already in the vault so it stops scrolling once it reaches them, and
	// we only save favorites we don't already have (never rewriting old notes).
	if (source === "douyin" || source === "rednote") {
		const limit = syncFetchLimit(cfg);
		const knownIds = existingSourceIds(view, folder);
		const scraped = source === "douyin"
			? await scrapeDouyinFavorites({ limit, knownIds })
			: await scrapeRednoteFavorites({ limit, knownIds });
		const fresh = scraped.filter((item) => !knownIds.has(item.id));
		const stats = await saveSocialSyncItems(view.app.vault, folder, source, fresh);
		return await indexAndOutcome(view, card, source, fresh.length, stats);
	}

	// WeChat 公众号 comes from Tencent IMA's Open API; the credential is the
	// pasted "clientId:apiKey[:kbId]" — it can't be auto-detected from a browser.
	if (source === "wechat") {
		const credential = splitImaCredential(cfg.credentials?.wechat?.trim() ?? "");
		if (!credential.clientId || !credential.apiKey) {
			throw new CredentialRequiredError(t().cards.social.imaCredentialHint);
		}
		try {
			const knownIds = existingSourceIds(view, folder);
			const items = await readImaFavorites(credential, { limit: syncFetchLimit(cfg), knownIds });
			const fresh = items.filter((item) => !knownIds.has(item.id));
			const stats = await saveSocialSyncItems(view.app.vault, folder, source, fresh);
			return await indexAndOutcome(view, card, source, fresh.length, stats);
		} catch (error) {
			throw new Error(formatImaError(error));
		}
	}

	// Bilibili's favorites API needs the logged-in account Cookie, which is
	// detected from the user's browser on the first sync or pasted in settings.
	if (source === "bilibili") {
		let credential = cfg.credentials?.bilibili?.trim() ?? "";
		if (!credential) {
			try {
				new Notice(t().cards.social.detectingCredential(t().cards.social.sources[source]));
				credential = await extractBrowserCookie(source);
				(cfg.credentials ??= {})[source] = credential;
				await view.plugin.saveSettings();
				new Notice(t().cards.social.credentialDetected(t().cards.social.sources[source]));
			} catch (error) {
				throw new CredentialRequiredError(error instanceof Error ? error.message : String(error));
			}
		}
		const knownIds = existingSourceIds(view, folder);
		const items = await syncBilibiliFavorites(credential, syncFetchLimit(cfg), knownIds);
		const fresh = items.filter((item) => !knownIds.has(item.id));
		const stats = await saveSocialSyncItems(view.app.vault, folder, source, fresh);
		return await indexAndOutcome(view, card, source, fresh.length, stats);
	}

	// Zhihu uses its signed private API with the login cookie.
	let credential = cfg.credentials?.[source]?.trim() ?? "";
	if (!credential) {
		try {
			new Notice(t().cards.social.detectingCredential(t().cards.social.sources[source]));
			credential = await extractBrowserCookie(source);
			(cfg.credentials ??= {})[source] = credential;
			await view.plugin.saveSettings();
			new Notice(t().cards.social.credentialDetected(t().cards.social.sources[source]));
		} catch (error) {
			throw new CredentialRequiredError(error instanceof Error ? error.message : String(error));
		}
	}
	const knownIds = existingSourceIds(view, folder);
	const items = await syncZhihuCollections(credential, syncFetchLimit(cfg), knownIds);
	const fresh = items.filter((item) => !knownIds.has(item.id));
	const stats = await saveSocialSyncItems(view.app.vault, folder, source, fresh);
	return await indexAndOutcome(view, card, source, fresh.length, stats);
}

/** Longest shared folder prefix of all sources, e.g. raw/red + raw/wechat
 * → "raw". The sync-log note lives here, beside (not inside) the source folders. */
function commonBaseFolder(cfg: SocialConfig): string {
	const paths = SOCIAL_SOURCES.map((source) => folderFor(cfg, source).split("/").filter(Boolean));
	const first = paths[0] ?? [];
	const base: string[] = [];
	for (let i = 0; i < first.length; i++) {
		const segment = first[i];
		if (paths.every((parts) => parts[i] === segment)) base.push(segment);
		else break;
	}
	return base.join("/");
}

function stamp(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function syncErrorMessage(source: SocialSource, error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	if (source === "bilibili" && /net::ERR_BLOCKED_BY_CLIENT/i.test(reason)) {
		return t().cards.social.bilibiliNetworkBlocked;
	}
	return reason;
}

/** Build the Markdown for one run: a table of per-source counts + a totals line. */
function buildLogSection(runLabel: string, outcomes: SyncOutcome[]): string {
	const log = t().cards.social.log;
	const sources = t().cards.social.sources;
	const rows = outcomes.map((outcome) => {
		const status = outcome.error ? `⚠️ ${outcome.error.replace(/\|/g, "/").replace(/\n+/g, " ")}` : log.ok;
		return `| ${sources[outcome.source]} | ${outcome.created} | ${outcome.updated} | ${outcome.fetched} | ${status} |`;
	});
	const created = outcomes.reduce((sum, outcome) => sum + outcome.created, 0);
	const updated = outcomes.reduce((sum, outcome) => sum + outcome.updated, 0);
	return [
		`## ${stamp(new Date())} · ${runLabel}`,
		"",
		`| ${log.colSource} | ${log.colNew} | ${log.colUpdated} | ${log.colFetched} | ${log.colStatus} |`,
		"| --- | ---: | ---: | ---: | --- |",
		...rows,
		"",
		log.totals(created, updated),
	].join("\n");
}

/** Persist one run's report to the sync-log note (best-effort; never throws). */
async function recordSyncLog(view: HomeView, cfg: SocialConfig, runLabel: string, outcomes: SyncOutcome[]): Promise<void> {
	if (outcomes.length === 0) return;
	const log = t().cards.social.log;
	try {
		await writeSyncLog(
			view.app.vault,
			commonBaseFolder(cfg),
			log.file,
			`# ${log.title}`,
			buildLogSection(runLabel, outcomes),
		);
	} catch (error) {
		console.error("Flexible Workbench: failed to write favorites sync log", error);
	}
}

/** Sync a single source from its per-tab refresh button. */
async function syncSource(
	view: HomeView,
	card: DashboardCard,
	cfg: SocialConfig,
	source: SocialSource,
	folder: string,
	repaint: () => void,
): Promise<void> {
	const active = syncingSources.get(card) ?? new Set<SocialSource | "all">();
	if (active.has(source) || active.has("all")) return;
	if (view.plugin.settings.disableExternalCalls) {
		new Notice(t().cards.social.disabled);
		return;
	}
	active.add(source);
	syncingSources.set(card, active);
	repaint();
	const label = t().cards.social.sources[source];
	try {
		const outcome = await runSourceSync(view, card, cfg, source, folder);
		await recordSyncLog(view, cfg, label, [outcome]);
		new Notice(t().cards.social.synced(label, outcome.fetched));
	} catch (error) {
		if (error instanceof CredentialRequiredError) {
			new Notice(`${t().cards.social.credentialRequired(label)} (${error.message})`);
			void import("../dashboard").then(({ openCardSettings }) => openCardSettings(view, card));
		} else {
			console.error(`Flexible Workbench: ${source} favorites sync failed`, error);
			const reason = syncErrorMessage(source, error);
			await recordSyncLog(view, cfg, label, [{ source, fetched: 0, created: 0, updated: 0, error: reason }]);
			new Notice(t().cards.social.syncFailed(label, reason));
		}
	} finally {
		active.delete(source);
		repaint();
	}
}

/** One click: sync every source in turn, then report an aggregated result and
 * write a per-run log note. A single source failing never aborts the others. */
export async function syncAllSources(
	view: HomeView,
	card: DashboardCard,
	cfg: SocialConfig,
	repaint: () => void,
): Promise<void> {
	const active = syncingSources.get(card) ?? new Set<SocialSource | "all">();
	if (active.has("all")) return;
	if (view.plugin.settings.disableExternalCalls) {
		new Notice(t().cards.social.disabled);
		return;
	}
	active.add("all");
	syncingSources.set(card, active);
	repaint();
	new Notice(t().cards.social.syncingAll);
	const outcomes: SyncOutcome[] = [];
	const failures: string[] = [];
	for (const source of SOCIAL_SOURCES) {
		const label = t().cards.social.sources[source];
		try {
			outcomes.push(await runSourceSync(view, card, cfg, source, folderFor(cfg, source)));
		} catch (error) {
			const reason = error instanceof CredentialRequiredError
				? t().cards.social.credentialRequiredShort(label)
				: syncErrorMessage(source, error);
			outcomes.push({ source, fetched: 0, created: 0, updated: 0, error: reason });
			failures.push(`${label}: ${reason}`);
			console.error(`Flexible Workbench: ${source} favorites sync failed`, error);
		}
	}
	await recordSyncLog(view, cfg, t().cards.social.log.runAll, outcomes);
	const total = outcomes.reduce((sum, outcome) => sum + outcome.fetched, 0);
	active.delete("all");
	repaint();
	new Notice(failures.length
		? t().cards.social.syncedAllPartial(total, failures.join("; "))
		: t().cards.social.syncedAll(total));
}

function renderVaultItem(
	view: HomeView,
	container: HTMLElement,
	file: TFile,
	source: SocialSource,
): void {
	const cache = view.app.metadataCache.getFileCache(file);
	const frontmatter = cache?.frontmatter;
	const title = typeof frontmatter?.title === "string" && frontmatter.title.trim()
		? frontmatter.title.trim()
		: file.basename;
	const authorValues: unknown[] = [frontmatter?.author, frontmatter?.mp_name, frontmatter?.account];
	const author = authorValues
		.find((value) => typeof value === "string" && value.trim());
	const open = (): void => {
		const url = typeof frontmatter?.url === "string" ? frontmatter.url : "";
		if (source === "bilibili" && /^https?:\/\//i.test(url)) {
			window.open(url, "_blank");
			return;
		}
		void view.app.workspace.getLeaf(false).openFile(file);
	};

	const row = container.createDiv(`flexible-workbench-social-item is-${source}`);
	row.addEventListener("click", open);
	makeClickable(row, open, t().cards.social.open(title));
	const badge = row.createDiv("flexible-workbench-social-source-mark");
	setIcon(badge, SOURCE_ICONS[source]);
	const main = row.createDiv("flexible-workbench-social-item-main");
	main.createDiv({ cls: "flexible-workbench-social-title", text: title });
	main.createDiv({
		cls: "flexible-workbench-social-meta",
		text: typeof author === "string"
			? author
			: new Date(file.stat.mtime).toLocaleDateString(),
	});
}

export function socialEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg: SocialConfig = (ctx.card.social ??= {});
	const credentials = (cfg.credentials ??= {});
	const strings = t().editors.social;
	new Setting(containerEl)
		.setName(strings.initialSource)
		.setDesc(strings.initialSourceDesc)
		.addDropdown((dropdown) => {
			for (const source of ["rednote", "wechat", "douyin", "zhihu", "bilibili"] as SocialSource[]) {
				dropdown.addOption(source, t().cards.social.sources[source]);
			}
			dropdown.setValue(cfg.initialSource ?? "rednote").onChange((value) => {
				cfg.initialSource = value as SocialSource;
				ctx.opts.save();
				ctx.opts.rerender();
			});
		});

	containerEl.createEl("h4", { text: strings.credentialsHeading });
	for (const source of ["rednote", "wechat", "douyin", "zhihu", "bilibili"] as SocialSource[]) {
		let credentialInput: HTMLInputElement | null = null;
		new Setting(containerEl)
			.setName(strings.credential(t().cards.social.sources[source]))
			.setDesc(strings.credentialDesc[source])
			.addText((input) => {
				credentialInput = input.inputEl;
				input.setValue(credentials[source] ?? "").onChange((value) => {
					credentials[source] = value.trim() || undefined;
					ctx.opts.save();
				});
				input.inputEl.type = "password";
				input.inputEl.autocomplete = "off";
			})
			.addExtraButton((button) => {
				button
					.setIcon("scan-search")
					.setTooltip(strings.autoDetect)
					.onClick(async () => {
						button.setDisabled(true);
						try {
							const cookie = await extractBrowserCookie(source);
							credentials[source] = cookie;
							if (credentialInput) credentialInput.value = cookie;
							ctx.opts.save();
							new Notice(t().cards.social.credentialDetected(t().cards.social.sources[source]));
						} catch (error) {
							const reason = error instanceof Error ? error.message : String(error);
							new Notice(`${t().cards.social.autoDetectFailed} (${reason})`);
						} finally {
							button.setDisabled(false);
						}
					});
			});
	}

	for (const [key, label, placeholder] of [
		["rednoteFolder", strings.rednoteFolder, DEFAULT_SOCIAL_FOLDERS.rednote],
		["wechatFolder", strings.wechatFolder, DEFAULT_SOCIAL_FOLDERS.wechat],
		["douyinFolder", strings.douyinFolder, DEFAULT_SOCIAL_FOLDERS.douyin],
		["zhihuFolder", strings.zhihuFolder, DEFAULT_SOCIAL_FOLDERS.zhihu],
		["bilibiliFolder", strings.bilibiliFolder, DEFAULT_SOCIAL_FOLDERS.bilibili],
	] as const) {
		new Setting(containerEl)
			.setName(label)
			.setDesc(strings.folderDesc)
			.addText((text) => text
				.setPlaceholder(placeholder)
				.setValue(cfg[key] ?? "")
				.onChange((value) => {
					cfg[key] = value.trim() || undefined;
					ctx.opts.save();
					ctx.opts.rerender();
				}));
	}

	new Setting(containerEl)
		.setName(strings.itemLimit)
		.setDesc(strings.itemLimitDesc)
		.addText((text) => {
			text.setValue(String(cfg.itemLimit ?? 12)).onChange((value) => {
				const parsed = Number.parseInt(value, 10);
				cfg.itemLimit = Number.isFinite(parsed) && parsed > 0 ? Math.min(100, parsed) : undefined;
				ctx.opts.save();
				ctx.opts.rerender();
			});
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.inputEl.max = "100";
		});

	new Setting(containerEl)
		.setName(strings.syncLimit)
		.setDesc(strings.syncLimitDesc)
		.addText((text) => {
			text.setValue(String(cfg.syncLimit ?? 500)).onChange((value) => {
				const parsed = Number.parseInt(value, 10);
				cfg.syncLimit = Number.isFinite(parsed) && parsed > 0 ? Math.min(1000, parsed) : undefined;
				ctx.opts.save();
			});
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.inputEl.max = "1000";
		});

}

export const socialCard: CardDefinition<"social"> = {
	kind: "social",
	templates: [{
		id: "social",
		name: "Content favorites",
		icon: "panels-top-left",
		build: () => ({
			kind: "social",
			title: "Content favorites",
			social: { initialSource: "rednote", itemLimit: 12 },
			w: 7,
			h: 5,
		}),
	}],
	render: (view, card, body, component) => renderSocial(view, card, body, component),
	renderEditor: (container, ctx) => socialEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.social) copy.social = {
			...source.social,
			credentials: source.social.credentials ? { ...source.social.credentials } : undefined,
		};
	},
	liveness: { mode: "vault" },
};
