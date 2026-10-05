import { Component, Notice, setIcon, Setting } from "obsidian";
import { emptyState } from "../cardbodies";
import { t } from "../i18n";
import {
	DEFAULT_DOUYIN_STORAGE_PATH,
	DouyinFavoritesVaultStore,
	DouyinSyncError,
	normalizeDouyinStoragePath,
	syncDouyinFavorites,
	type DouyinFavoriteItem,
	type DouyinFavoritesSnapshot,
} from "../douyin-sync";
import { makeClickable } from "../ui";
import { type DashboardCard, type DouyinConfig } from "../types";
import { type CardDefinition, type CardEditorContext } from "./definition";

interface DouyinCardState {
	path: string;
	snapshot: DouyinFavoritesSnapshot | null;
	loaded: boolean;
	loading: boolean;
	error: string;
}

const states = new WeakMap<DashboardCard, DouyinCardState>();

function stateFor(card: DashboardCard, path: string): DouyinCardState {
	const existing = states.get(card);
	if (existing?.path === path) return existing;
	const next: DouyinCardState = {
		path,
		snapshot: null,
		loaded: false,
		loading: false,
		error: "",
	};
	states.set(card, next);
	return next;
}

export function renderDouyin(
	view: import("../view").HomeView,
	card: DashboardCard,
	body: HTMLElement,
	component: Component,
): void {
	const cfg = card.douyin ?? {};
	const path = normalizeDouyinStoragePath(cfg.storagePath);
	const state = stateFor(card, path);
	const store = new DouyinFavoritesVaultStore(view.app.vault, path);
	let destroyed = false;
	component.register(() => {
		destroyed = true;
	});

	const wrap = body.createDiv("flexible-workbench-douyin");
	const toolbar = wrap.createDiv("flexible-workbench-douyin-toolbar");
	const summary = toolbar.createDiv("flexible-workbench-douyin-summary");
	const refresh = toolbar.createEl("button", {
		cls: "flexible-workbench-douyin-refresh",
		attr: { "aria-label": t().cards.douyin.sync },
	});
	setIcon(refresh, "refresh-cw");
	const content = wrap.createDiv("flexible-workbench-douyin-content");

	const paint = (): void => {
		if (destroyed) return;
		content.empty();
		refresh.toggleClass("is-loading", state.loading);
		refresh.disabled = state.loading;

		if (state.loading) {
			summary.setText(t().cards.douyin.loading);
			emptyState(content, "loader-circle", t().cards.douyin.loading);
			return;
		}
		if (state.error) {
			summary.setText(t().cards.douyin.error);
			emptyState(content, "alert-triangle", state.error);
			return;
		}
		const snapshot = state.snapshot;
		if (!snapshot) {
			summary.setText(t().cards.douyin.notSynced);
			emptyState(content, "heart", t().cards.douyin.notSyncedDesc);
			return;
		}

		summary.setText(t().cards.douyin.summary(snapshot.items.length, snapshot.folders.length));
		const limit = Math.max(1, Math.min(100, Math.round(cfg.itemLimit ?? 12)));
		const items = snapshot.items.slice(0, limit);
		if (items.length === 0) {
			emptyState(content, "heart", t().cards.douyin.empty);
			return;
		}
		const list = content.createDiv("flexible-workbench-douyin-list");
		for (const item of items) renderItem(list, item);
		if (snapshot.items.length > items.length) {
			content.createDiv({
				cls: "flexible-workbench-douyin-more",
				text: t().cards.douyin.showing(items.length, snapshot.items.length),
			});
		}
	};

	const loadSnapshot = async (): Promise<void> => {
		if (state.loaded || state.loading) return;
		state.loading = true;
		paint();
		try {
			state.snapshot = await store.load();
			state.loaded = true;
		} catch {
			state.error = t().cards.douyin.error;
		} finally {
			state.loading = false;
			paint();
		}
	};

	const sync = async (): Promise<void> => {
		if (state.loading) return;
		if (view.plugin.settings.disableExternalCalls) {
			state.error = t().cards.douyin.disabled;
			paint();
			return;
		}
		const cookie = cfg.cookie?.trim() ?? "";
		if (!cookie) {
			state.error = t().cards.douyin.configure;
			paint();
			return;
		}

		state.error = "";
		state.loading = true;
		paint();
		try {
			const snapshot = await syncDouyinFavorites({ cookie });
			await store.save(snapshot);
			if (destroyed) return;
			state.snapshot = snapshot;
			state.loaded = true;
			new Notice(t().cards.douyin.synced(snapshot.items.length));
			if (snapshot.warnings.length) {
				console.warn("Flexible Workbench: Douyin sync completed with warnings", snapshot.warnings);
			}
		} catch (error) {
			if (destroyed) return;
			state.error = douyinErrorMessage(error);
			new Notice(state.error);
		} finally {
			state.loading = false;
			paint();
		}
	};

	refresh.addEventListener("click", () => void sync());
	paint();
	void loadSnapshot();
}

function renderItem(container: HTMLElement, item: DouyinFavoriteItem): void {
	const row = container.createDiv("flexible-workbench-douyin-item");
	const title = item.title || t().cards.douyin.untitled;
	const open = (): void => {
		if (/^https?:\/\//i.test(item.shareUrl)) window.open(item.shareUrl, "_blank");
	};
	row.addEventListener("click", open);
	makeClickable(row, open, t().cards.douyin.open(title));

	if (item.coverUrl) {
		const image = row.createEl("img", {
			cls: "flexible-workbench-douyin-cover",
			attr: { src: item.coverUrl, loading: "lazy", referrerpolicy: "no-referrer" },
		});
		image.addEventListener("error", () => image.remove());
	}
	const main = row.createDiv("flexible-workbench-douyin-item-main");
	main.createDiv({ cls: "flexible-workbench-douyin-title", text: title });
	const meta: string[] = [];
	if (item.author) meta.push(item.author);
	if (item.folderNames.length) meta.push(item.folderNames.join("、"));
	if (item.createTime !== null) meta.push(formatDouyinDate(item.createTime));
	if (meta.length) {
		main.createDiv({ cls: "flexible-workbench-douyin-meta", text: meta.join(" · ") });
	}
}

function formatDouyinDate(timestamp: number): string {
	const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

function douyinErrorMessage(error: unknown): string {
	if (!(error instanceof DouyinSyncError)) return t().cards.douyin.error;
	switch (error.kind) {
		case "not-logged-in":
			return t().cards.douyin.loginRequired;
		case "rate-limited":
			return t().cards.douyin.rateLimited;
		case "api":
		case "http":
		case "invalid-response":
			return error.message || t().cards.douyin.error;
	}
}

export function douyinEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg: DouyinConfig = (ctx.card.douyin ??= {});
	const strings = t().editors.douyin;
	new Setting(containerEl)
		.setName(strings.cookie)
		.setDesc(strings.cookieDesc)
		.addText((text) => {
			text.setValue(cfg.cookie ?? "").onChange((value) => {
				cfg.cookie = value || undefined;
				ctx.opts.save();
			});
			text.inputEl.type = "password";
			text.inputEl.autocomplete = "off";
		});

	new Setting(containerEl)
		.setName(strings.storagePath)
		.setDesc(strings.storagePathDesc)
		.addText((text) =>
			text
				.setPlaceholder(DEFAULT_DOUYIN_STORAGE_PATH)
				.setValue(cfg.storagePath ?? "")
				.onChange((value) => {
					cfg.storagePath = value.trim() || undefined;
					ctx.opts.save();
					ctx.opts.rerender();
				}),
		);

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
			text.inputEl.addClass("flexible-workbench-count-input");
		});

}

export const douyinCard: CardDefinition<"douyin"> = {
	kind: "douyin",
	templates: [
		{
			id: "douyin",
			name: "Douyin favorites",
			icon: "heart",
			build: () => ({
				kind: "douyin",
				title: "Douyin favorites",
				douyin: { storagePath: DEFAULT_DOUYIN_STORAGE_PATH, itemLimit: 12 },
				w: 6,
				h: 5,
			}),
		},
	],
	render: (view, card, body, component) => renderDouyin(view, card, body, component),
	renderEditor: (container, ctx) => douyinEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.douyin) copy.douyin = { ...source.douyin };
	},
	liveness: { mode: "static" },
};
