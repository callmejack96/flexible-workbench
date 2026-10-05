import { Component, Modal, Notice, setIcon, Setting, TFile } from "obsidian";
import { emptyState } from "../cardbodies";
import {
	emptyIndex,
	entryKey,
	listEntries,
	loadIndex,
	onIndexChanged,
	saveIndex,
	setArchived,
	upsertEntry,
	type FavoriteEntry,
	type IndexData,
} from "../favorites-index";
import { t } from "../i18n";
import type { DashboardCard, SocialConfig, SocialSource } from "../types";
import type { HomeView } from "../view";
import type { CardDefinition } from "./definition";
import { socialEditor, syncAllSources } from "./social";

type ReviewFilter = "all" | "pending" | "reviewed";
type SyncTimeSort = "newest" | "oldest";
type SyncTimeRange = "all" | "week" | "month" | "custom";

const ALL_CATEGORIES = "*";
const ALL_SOURCES = "*";
const UNCATEGORIZED = "__uncategorized__";
const SOCIAL_SOURCES: SocialSource[] = ["rednote", "wechat", "douyin", "zhihu", "bilibili"];

function parseLocalDate(value: string): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const [year, month, day] = value.split("-").map(Number);
	const date = new Date(year, month - 1, day);
	return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function matchesSyncTimeRange(
	syncedAt: string,
	range: SyncTimeRange,
	fromDate: string,
	toDate: string,
	now = new Date(),
): boolean {
	if (range === "all") return true;
	const syncedTime = Date.parse(syncedAt);
	if (!Number.isFinite(syncedTime)) return false;

	if (range === "week") {
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
		const end = new Date(start);
		end.setDate(end.getDate() + 7);
		return syncedTime >= start.getTime() && syncedTime < end.getTime();
	}
	if (range === "month") {
		const start = new Date(now.getFullYear(), now.getMonth(), 1);
		const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
		return syncedTime >= start.getTime() && syncedTime < end.getTime();
	}

	const start = fromDate ? parseLocalDate(fromDate) : null;
	const end = toDate ? parseLocalDate(toDate) : null;
	if ((fromDate && !start) || (toDate && !end)) return false;
	if (!start && !end) return true;
	if (start && syncedTime < start.getTime()) return false;
	if (end) {
		const endExclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
		if (syncedTime >= endExclusive.getTime()) return false;
	}
	return true;
}

function parseHttpUrl(raw: string): URL | null {
	const value = raw.trim();
	if (!value) return null;
	try {
		const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function displayCategory(entry: FavoriteEntry): string {
	if (entry.source === "manual") return t().cards.savedLinks.uncategorized;
	return entry.category?.trim() || t().cards.savedLinks.uncategorized;
}

function cloneSocialConfig(config: SocialConfig): SocialConfig {
	return {
		...config,
		credentials: config.credentials ? { ...config.credentials } : undefined,
	};
}

/** Copy the existing platform settings onto the library the first time it is
 * opened, so syncing no longer depends on keeping the old card on the board. */
function inheritSocialConfig(view: HomeView, card: DashboardCard): void {
	if (card.social) return;
	const settings = view.plugin.settings;
	const activeDashboard = settings.dashboards.find((dashboard) => dashboard.id === settings.activeDashboardId);
	const otherCards = settings.dashboards
		.filter((dashboard) => dashboard !== activeDashboard)
		.flatMap((dashboard) => dashboard.cards);
	const socialCard = [
		...(activeDashboard?.cards ?? []),
		...otherCards,
		...settings.pinnedCards,
	].find((candidate) => candidate.id !== card.id && candidate.kind === "social" && candidate.social);
	if (!socialCard?.social) return;
	card.social = cloneSocialConfig(socialCard.social);
	void view.plugin.saveSettings().catch((error: unknown) => {
		console.error("Flexible Workbench: failed to copy content-favorites settings to the library", error);
	});
}

export function renderSavedLinks(
	view: HomeView,
	card: DashboardCard,
	body: HTMLElement,
	component: Component,
): void {
	const strings = t().cards.savedLinks;
	inheritSocialConfig(view, card);
	let index = emptyIndex();
	let reviewFilter: ReviewFilter = "all";
	let activeCategory = ALL_CATEGORIES;
	let activeSource = ALL_SOURCES;
	let syncTimeSort: SyncTimeSort = "newest";
	let syncTimeRange: SyncTimeRange = "all";
	let fromDateValue = "";
	let toDateValue = "";
	let query = "";
	let indexLoaded = false;
	let syncingAll = false;
	let destroyed = false;
	component.register(() => {
		destroyed = true;
	});

	const root = body.createDiv("flexible-workbench-saved-links");
	const toolbar = root.createDiv("flexible-workbench-saved-links-toolbar");
	const statusTabs = toolbar.createDiv("flexible-workbench-saved-links-statuses");
	const tabButtons: Record<ReviewFilter, HTMLButtonElement> = {
		all: statusTabs.createEl("button", { cls: "flexible-workbench-saved-links-tab" }),
		pending: statusTabs.createEl("button", { cls: "flexible-workbench-saved-links-tab" }),
		reviewed: statusTabs.createEl("button", { cls: "flexible-workbench-saved-links-tab" }),
	};
	const toolbarActions = toolbar.createDiv("flexible-workbench-saved-links-actions-bar");
	const syncAll = toolbarActions.createEl("button", {
		cls: "flexible-workbench-saved-links-sync-all",
		attr: { "aria-label": strings.syncAll, title: strings.syncAll },
	});
	const syncAllIcon = syncAll.createSpan({ cls: "flexible-workbench-saved-links-sync-icon" });
	setIcon(syncAllIcon, "refresh-cw");
	const syncAllLabel = syncAll.createSpan({ cls: "flexible-workbench-saved-links-sync-label", text: strings.syncAll });
	const manageCategories = toolbarActions.createEl("button", {
		cls: "flexible-workbench-saved-links-manage-categories",
		attr: { "aria-label": strings.manageCategories, title: strings.manageCategories },
	});
	manageCategories.disabled = true;
	setIcon(manageCategories.createSpan(), "tags");
	manageCategories.createSpan({ text: strings.manageCategories });

	const filters = root.createDiv("flexible-workbench-saved-links-filters");
	const sourceSelect = filters.createEl("select", {
		cls: "flexible-workbench-saved-links-filter",
		attr: { "aria-label": strings.dataSource },
	});
	const categorySelect = filters.createEl("select", {
		cls: "flexible-workbench-saved-links-filter",
		attr: { "aria-label": strings.category },
	});
	const syncTimeRangeSelect = filters.createEl("select", {
		cls: "flexible-workbench-saved-links-filter",
		attr: { "aria-label": strings.syncTimeRange },
	});
	const sortSelect = filters.createEl("select", {
		cls: "flexible-workbench-saved-links-filter",
		attr: { "aria-label": strings.sortBySyncTime },
	});
	const search = filters.createEl("input", {
		cls: "flexible-workbench-saved-links-search",
		attr: { type: "search", placeholder: strings.searchPlaceholder, "aria-label": strings.searchPlaceholder },
	});
	const dateRange = filters.createDiv("flexible-workbench-saved-links-date-range");
	const fromLabel = dateRange.createEl("label", { cls: "flexible-workbench-saved-links-date-label" });
	fromLabel.createSpan({ text: strings.fromDate });
	const fromDate = fromLabel.createEl("input", {
		attr: { type: "date", "aria-label": strings.fromDate },
	});
	const toLabel = dateRange.createEl("label", { cls: "flexible-workbench-saved-links-date-label" });
	toLabel.createSpan({ text: strings.toDate });
	const toDate = toLabel.createEl("input", {
		attr: { type: "date", "aria-label": strings.toDate },
	});
	dateRange.hidden = true;
	const list = root.createDiv("flexible-workbench-saved-links-grid");

	function entries(): FavoriteEntry[] {
		return listEntries(index).filter((entry) => {
			return entry.source !== "manual" && view.app.vault.getAbstractFileByPath(entry.path) instanceof TFile;
		});
	}

	function saveAndPaint(): void {
		paint();
		void saveIndex(view.plugin, index).catch((error: unknown) => {
			console.error("Flexible Workbench: failed to save favorites", error);
			new Notice(strings.saveFailed);
		});
	}

	function openEditor(existing: FavoriteEntry): void {
		new FavoriteCategoryModal(view.app, existing.category ?? "", index.categories, (category) => {
			const entry = index.entries[entryKey(existing.source, existing.id)] ?? existing;
			entry.category = category || undefined;
			saveAndPaint();
		}).open();
	}

	function openCategoryManager(): void {
		if (!indexLoaded) return;
		new FavoriteCategoryManagerModal(view.app, index.categories, async (categories, replacements) => {
			for (const entry of Object.values(index.entries)) {
				if (entry.source === "manual") continue;
				if (!entry.category || !replacements.has(entry.category)) continue;
				entry.category = replacements.get(entry.category) || undefined;
			}
			index.categories = categories;
			await saveIndex(view.plugin, index);
			paint();
			new Notice(strings.categoriesSaved);
		}).open();
	}

	function paint(): void {
		syncAll.disabled = syncingAll;
		syncAll.toggleClass("is-loading", syncingAll);
		syncAllLabel.setText(syncingAll ? strings.syncingAll : strings.syncAll);
		const all = entries();
		const reviewedCount = all.filter((entry) => entry.archived).length;
		const pendingCount = all.length - reviewedCount;
		const labels: Record<ReviewFilter, string> = {
			all: `${strings.all} ${all.length}`,
			pending: `${strings.toReview} ${pendingCount}`,
			reviewed: `${strings.reviewed} ${reviewedCount}`,
		};
		for (const filter of ["all", "pending", "reviewed"] as const) {
			const button = tabButtons[filter];
			button.setText(labels[filter]);
			button.toggleClass("is-active", reviewFilter === filter);
			button.setAttribute("aria-pressed", String(reviewFilter === filter));
		}

		if (activeCategory !== ALL_CATEGORIES && activeCategory !== UNCATEGORIZED && !index.categories.includes(activeCategory)) {
			activeCategory = ALL_CATEGORIES;
		}
		sourceSelect.empty();
		sourceSelect.createEl("option", { value: ALL_SOURCES, text: strings.allDataSources });
		for (const source of SOCIAL_SOURCES) {
			sourceSelect.createEl("option", { value: source, text: t().cards.social.sources[source] });
		}
		sourceSelect.value = activeSource;
		categorySelect.empty();
		categorySelect.createEl("option", { value: ALL_CATEGORIES, text: strings.allCategories });
		categorySelect.createEl("option", { value: UNCATEGORIZED, text: strings.uncategorized });
		for (const category of index.categories) categorySelect.createEl("option", { value: category, text: category });
		categorySelect.value = activeCategory;
		sortSelect.empty();
		sortSelect.createEl("option", { value: "newest", text: strings.newestFirst });
		sortSelect.createEl("option", { value: "oldest", text: strings.oldestFirst });
		sortSelect.value = syncTimeSort;
		syncTimeRangeSelect.empty();
		syncTimeRangeSelect.createEl("option", { value: "all", text: strings.allSyncTimes });
		syncTimeRangeSelect.createEl("option", { value: "week", text: strings.thisWeek });
		syncTimeRangeSelect.createEl("option", { value: "month", text: strings.thisMonth });
		syncTimeRangeSelect.createEl("option", { value: "custom", text: strings.customRange });
		syncTimeRangeSelect.value = syncTimeRange;
		dateRange.hidden = syncTimeRange !== "custom";
		fromDate.value = fromDateValue;
		toDate.value = toDateValue;

		list.empty();
		const visible = all
			.filter((entry) => {
				if (activeSource !== ALL_SOURCES && entry.source !== activeSource) return false;
				if (activeCategory === UNCATEGORIZED && entry.category) return false;
				if (activeCategory !== ALL_CATEGORIES && activeCategory !== UNCATEGORIZED && entry.category !== activeCategory) return false;
				if (!matchesSyncTimeRange(entry.syncedAt, syncTimeRange, fromDateValue, toDateValue)) return false;
				if (reviewFilter === "pending" && entry.archived) return false;
				if (reviewFilter === "reviewed" && !entry.archived) return false;
				if (!query) return true;
				return entry.title.toLocaleLowerCase().includes(query);
			})
			.sort((a, b) => {
				const aTime = Date.parse(a.syncedAt) || 0;
				const bTime = Date.parse(b.syncedAt) || 0;
				return syncTimeSort === "newest" ? bTime - aTime : aTime - bTime;
			});

		if (visible.length === 0) {
			emptyState(list, all.length === 0 ? "bookmark-check" : "search-x", all.length === 0 ? strings.empty : strings.noMatches);
			return;
		}
		for (const entry of visible) renderEntry(entry);
	}

	syncAll.addEventListener("click", () => {
		if (syncingAll) return;
		const hadConfig = Boolean(card.social);
		const config = card.social ?? (card.social = {});
		if (!hadConfig) {
			void view.plugin.saveSettings().catch((error: unknown) => {
				console.error("Flexible Workbench: failed to save library sync settings", error);
			});
		}
		syncingAll = true;
		paint();
		void syncAllSources(view, card, config, () => {
			if (!destroyed) paint();
		}).finally(() => {
			syncingAll = false;
			if (!destroyed) paint();
		});
	});

	function renderEntry(entry: FavoriteEntry): void {
		const itemCard = list.createDiv("flexible-workbench-saved-links-item");
		const meta = itemCard.createDiv("flexible-workbench-saved-links-meta");
		const tags = meta.createDiv("flexible-workbench-saved-links-tags");
		tags.createSpan({ cls: "flexible-workbench-saved-links-source", text: t().cards.social.sources[entry.source as SocialSource] });
		tags.createSpan({
			cls: `flexible-workbench-saved-links-category-tag${entry.category ? "" : " is-empty"}`,
			text: displayCategory(entry),
		});
		meta.createSpan({
			cls: `flexible-workbench-saved-links-state ${entry.archived ? "is-reviewed" : "is-pending"}`,
			text: entry.archived ? strings.reviewed : strings.toReview,
		});

		const safeUrl = parseHttpUrl(entry.url);
		if (safeUrl) {
			itemCard.createEl("a", {
				cls: "flexible-workbench-saved-links-title",
				text: entry.title,
				attr: { href: safeUrl.href, target: "_blank", rel: "noopener noreferrer" },
			});
		} else {
			itemCard.createDiv({ cls: "flexible-workbench-saved-links-title is-invalid", text: entry.title });
		}

		const footer = itemCard.createDiv("flexible-workbench-saved-links-footer");
		const actions = footer.createDiv("flexible-workbench-saved-links-actions");
		const reviewButton = actions.createEl("button", {
			cls: "flexible-workbench-saved-links-action",
			attr: {
				"aria-label": entry.archived ? strings.markPending : strings.markReviewed,
				title: entry.archived ? strings.markPending : strings.markReviewed,
			},
		});
		setIcon(reviewButton, entry.archived ? "rotate-ccw" : "check");
		reviewButton.addEventListener("click", () => {
			setArchived(index, entryKey(entry.source, entry.id), !entry.archived);
			saveAndPaint();
		});

		const editButton = actions.createEl("button", {
			cls: "flexible-workbench-saved-links-action",
			attr: { "aria-label": strings.editCategory, title: strings.editCategory },
		});
		setIcon(editButton, "pencil");
		editButton.addEventListener("click", () => openEditor(entry));
	}
	manageCategories.addEventListener("click", openCategoryManager);

	for (const filter of ["all", "pending", "reviewed"] as const) {
		tabButtons[filter].addEventListener("click", () => {
			reviewFilter = filter;
			paint();
		});
	}
	sourceSelect.addEventListener("change", () => {
		activeSource = sourceSelect.value;
		paint();
	});
	categorySelect.addEventListener("change", () => {
		activeCategory = categorySelect.value;
		paint();
	});
	sortSelect.addEventListener("change", () => {
		syncTimeSort = sortSelect.value === "oldest" ? "oldest" : "newest";
		paint();
	});
	syncTimeRangeSelect.addEventListener("change", () => {
		syncTimeRange = syncTimeRangeSelect.value as SyncTimeRange;
		paint();
	});
	fromDate.addEventListener("change", () => {
		fromDateValue = fromDate.value;
		paint();
	});
	toDate.addEventListener("change", () => {
		toDateValue = toDate.value;
		paint();
	});
	search.addEventListener("input", () => {
		query = search.value.trim().toLocaleLowerCase();
		paint();
	});

	async function reload(): Promise<void> {
		index = await loadIndex(view.plugin);
		let changed = indexEntriesFromVault(view, index);
		const knownCategories = new Set(index.categories);
		for (const entry of entries()) {
			const category = entry.category?.trim();
			if (category && !knownCategories.has(category)) {
				knownCategories.add(category);
				index.categories.push(category);
				changed = true;
			}
		}
		indexLoaded = true;
		manageCategories.disabled = false;
		paint();
		if (changed) await saveIndex(view.plugin, index);
	}

	component.register(onIndexChanged(() => {
		void reload();
	}));
	paint();
	void reload();
}

/** Add older synced notes to the shared index so the manager includes content
 * collected before the index existed. Existing Review/category values survive. */
function indexEntriesFromVault(view: HomeView, index: IndexData): boolean {
	const before = JSON.stringify(index.entries);
	for (const file of view.app.vault.getMarkdownFiles()) {
		const frontmatter = view.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter || !SOCIAL_SOURCES.includes(frontmatter.source as SocialSource)) continue;
		const source = frontmatter.source as SocialSource;
		const rawId = frontmatter.source_id;
		const id = typeof rawId === "string" ? rawId : typeof rawId === "number" && Number.isFinite(rawId) ? String(rawId) : "";
		if (!id) continue;
		const title = typeof frontmatter.title === "string" && frontmatter.title.trim()
			? frontmatter.title.trim()
			: file.basename;
		const url = typeof frontmatter.url === "string" ? frontmatter.url : "";
		const syncedAt = typeof frontmatter.synced_at === "string" && !Number.isNaN(Date.parse(frontmatter.synced_at))
			? frontmatter.synced_at
			: new Date(file.stat.mtime).toISOString();
		upsertEntry(index, { source, id, title, url, path: file.path, syncedAt });
	}
	return before !== JSON.stringify(index.entries);
}

class FavoriteCategoryModal extends Modal {
	private categoryValue: string;

	constructor(
		app: HomeView["app"],
		currentCategory: string,
		private readonly categories: string[],
		private readonly onSave: (category: string) => void,
	) {
		super(app);
		this.categoryValue = currentCategory;
	}

	onOpen(): void {
		const strings = t().cards.savedLinks;
		this.titleEl.setText(strings.editCategory);
		const { contentEl } = this;
		contentEl.addClass("flexible-workbench-saved-links-modal");
		new Setting(contentEl).setName(strings.category).addDropdown((dropdown) => {
			dropdown.addOption("", strings.uncategorized);
			for (const category of this.categories) dropdown.addOption(category, category);
			if (this.categoryValue && !this.categories.includes(this.categoryValue)) {
				dropdown.addOption(this.categoryValue, this.categoryValue);
			}
			dropdown.setValue(this.categoryValue).onChange((value) => {
				this.categoryValue = value;
			});
		});
		new Setting(contentEl)
			.addButton((button) => button.setButtonText(strings.cancel).onClick(() => this.close()))
			.addButton((button) => button.setButtonText(strings.save).setCta().onClick(() => this.commit()));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private commit(): void {
		this.onSave(this.categoryValue.trim());
		this.close();
	}
}

interface CategoryDraftRow {
	original: string | null;
	value: string;
}

class FavoriteCategoryManagerModal extends Modal {
	private readonly rows: CategoryDraftRow[];
	private addValue = "";
	private addInput: HTMLInputElement | null = null;
	private rowsEl: HTMLElement | null = null;

	constructor(
		app: HomeView["app"],
		private readonly initialCategories: string[],
		private readonly onSave: (categories: string[], replacements: Map<string, string | undefined>) => Promise<void>,
	) {
		super(app);
		this.rows = initialCategories.map((category) => ({ original: category, value: category }));
	}

	onOpen(): void {
		const strings = t().cards.savedLinks;
		this.titleEl.setText(strings.manageCategoriesTitle);
		const { contentEl } = this;
		contentEl.addClass("flexible-workbench-saved-links-modal");
		contentEl.createEl("p", { cls: "flexible-workbench-saved-links-category-help", text: strings.manageCategoriesDesc });
		new Setting(contentEl)
			.setName(strings.newCategory)
			.addText((text) => {
				this.addInput = text.inputEl;
				text.setPlaceholder(strings.categoryNamePlaceholder).onChange((value) => {
					this.addValue = value;
				});
			})
			.addButton((button) => button.setButtonText(strings.addCategory).onClick(() => this.addCategory()));
		this.rowsEl = contentEl.createDiv("flexible-workbench-saved-links-category-list");
		this.renderRows();
		new Setting(contentEl)
			.addButton((button) => button.setButtonText(strings.cancel).onClick(() => this.close()))
			.addButton((button) => button.setButtonText(strings.save).setCta().onClick(() => void this.commit()));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private addCategory(): void {
		const strings = t().cards.savedLinks;
		const value = this.addValue.trim();
		if (!value) {
			new Notice(strings.categoryRequired);
			return;
		}
		if (this.rows.some((row) => row.value.trim().toLocaleLowerCase() === value.toLocaleLowerCase())) {
			new Notice(strings.categoryExists);
			return;
		}
		this.rows.push({ original: null, value });
		this.addValue = "";
		if (this.addInput) this.addInput.value = "";
		this.renderRows();
	}

	private renderRows(): void {
		if (!this.rowsEl) return;
		const strings = t().cards.savedLinks;
		this.rowsEl.empty();
		this.rows.forEach((row, index) => {
			new Setting(this.rowsEl!)
				.setName(row.original ?? strings.newCategory)
				.addText((text) => text.setValue(row.value).onChange((value) => {
					row.value = value;
				}))
				.addExtraButton((button) => button
					.setIcon("trash-2")
					.setTooltip(strings.removeCategory)
					.onClick(() => {
						this.rows.splice(index, 1);
						this.renderRows();
					}));
		});
	}

	private async commit(): Promise<void> {
		const strings = t().cards.savedLinks;
		const categories = this.rows.map((row) => row.value.trim());
		if (categories.some((category) => !category)) {
			new Notice(strings.categoryRequired);
			return;
		}
		if (new Set(categories.map((category) => category.toLocaleLowerCase())).size !== categories.length) {
			new Notice(strings.categoryExists);
			return;
		}
		const replacements = new Map<string, string | undefined>(this.initialCategories.map((category) => [category, undefined]));
		this.rows.forEach((row) => {
			if (row.original) replacements.set(row.original, row.value.trim());
		});
		try {
			await this.onSave(categories, replacements);
			this.close();
		} catch (error) {
			console.error("Flexible Workbench: failed to save favorite categories", error);
			new Notice(strings.saveFailed);
		}
	}
}

export const savedLinksCard: CardDefinition<"savedlinks"> = {
	kind: "savedlinks",
	templates: [{
		id: "savedlinks",
		name: t().templates.savedlinks,
		icon: "bookmark-check",
		build: () => ({ kind: "savedlinks", title: t().templates.savedlinks, w: 6, h: 4 }),
	}],
	render: (view, card, body, component) => renderSavedLinks(view, card, body, component),
	renderEditor: (container, ctx) => socialEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.social) copy.social = cloneSocialConfig(source.social);
	},
	liveness: { mode: "static" },
};
