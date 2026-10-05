/**
 * The "organize favorites" page: a modal listing every synced favorite grouped
 * by source, each with an archive toggle. Archiving is just a flag in the
 * favorites index (see favorites-index.ts) — notes are never moved or deleted —
 * so the card's inbox view can hide finished items and the choice is reversible.
 */
import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { t } from "./i18n";
import type { SocialSource } from "./types";
import {
	entryKey,
	listEntries,
	removeEntry,
	setArchived,
	type IndexData,
} from "./favorites-index";

// Local copy of the source order (mirrors SOCIAL_SOURCES in cards/social.ts);
// duplicated deliberately so this module never imports the card and risks a cycle.
const SOURCE_ORDER: SocialSource[] = ["rednote", "wechat", "douyin", "zhihu", "bilibili"];

export class FavoritesArchiveModal extends Modal {
	private dirty = false;

	/**
	 * @param index   The shared, in-memory index; toggles mutate it in place so
	 *                the card (which holds the same reference) updates live.
	 * @param persist Writes the index to disk.
	 * @param onChanged Repaints the card after an in-memory change.
	 */
	constructor(
		app: App,
		private readonly index: IndexData,
		private readonly persist: () => Promise<void>,
		private readonly onChanged: () => void,
	) {
		super(app);
		this.titleEl.setText(t().cards.social.archive.manageTitle);
	}

	onOpen(): void {
		this.flexibleWorkbenchRenderBody();
	}

	onClose(): void {
		this.contentEl.empty();
		// Escape / the close button should still keep any toggles the user made.
		if (this.dirty) void this.persist();
	}

	private flexibleWorkbenchRenderBody(): void {
		const strings = t().cards.social.archive;
		const sources = t().cards.social.sources;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("flexible-workbench-archive-modal");
		contentEl.createEl("p", { cls: "flexible-workbench-archive-intro", text: strings.manageIntro });

		if (SOURCE_ORDER.every((source) => listEntries(this.index, { source }).length === 0)) {
			contentEl.createEl("p", { text: strings.empty });
			return;
		}

		for (const source of SOURCE_ORDER) {
			const group = listEntries(this.index, { source }).sort((a, b) => b.syncedAt.localeCompare(a.syncedAt));
			if (group.length === 0) continue;
			const archived = group.filter((entry) => entry.archived).length;
			contentEl.createEl("h4", {
				cls: "flexible-workbench-archive-group",
				text: `${sources[source]} · ${strings.count(group.length - archived, archived)}`,
			});
			new Setting(contentEl)
				.addButton((button) => button.setButtonText(strings.archiveAll).onClick(() => this.applyToGroup(source, true)))
				.addButton((button) => button.setButtonText(strings.unarchiveAll).onClick(() => this.applyToGroup(source, false)));
			for (const entry of group) this.renderEntryRow(contentEl, entry);
		}

		new Setting(contentEl)
			.addButton((button) => button
				.setButtonText(strings.save)
				.setCta()
				.onClick(() => void this.saveAndClose()));
	}

	private renderEntryRow(container: HTMLElement, entry: IndexData["entries"][string]): void {
		const strings = t().cards.social.archive;
		const key = entryKey(entry.source, entry.id);
		const setting = new Setting(container).setName(entry.title || entry.id);
		const file = entry.path ? this.app.vault.getAbstractFileByPath(entry.path) : null;

		if (file instanceof TFile) {
			setting.setDesc(entry.url || "");
			setting.addExtraButton((button) => button
				.setIcon("external-link")
				.setTooltip(strings.open(entry.title || entry.id))
				.onClick(() => void this.app.workspace.getLeaf(false).openFile(file)));
			setting.addToggle((toggle) => toggle
				.setValue(entry.archived)
				.onChange((value) => {
					setArchived(this.index, key, value);
					this.markChanged();
				}));
		} else {
			// The note was moved or deleted outside the plugin; offer to prune it.
			setting.setDesc(strings.missing);
			setting.addExtraButton((button) => button
				.setIcon("trash-2")
				.setTooltip(strings.removeEntry)
				.onClick(() => {
					removeEntry(this.index, key);
					this.markChanged();
					this.flexibleWorkbenchRenderBody();
				}));
		}
	}

	private applyToGroup(source: SocialSource, archived: boolean): void {
		for (const entry of listEntries(this.index, { source })) {
			setArchived(this.index, entryKey(entry.source, entry.id), archived);
		}
		this.markChanged();
		this.flexibleWorkbenchRenderBody();
	}

	private markChanged(): void {
		this.dirty = true;
		this.onChanged();
	}

	private async saveAndClose(): Promise<void> {
		await this.persist();
		this.dirty = false;
		new Notice(t().cards.social.archive.saved);
		this.close();
	}
}
