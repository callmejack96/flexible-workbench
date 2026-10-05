import { Component, Notice, setIcon, Setting } from "obsidian";
import { emptyState } from "../cardbodies";
import { confirmAction } from "../ui";
import { t } from "../i18n";
import type { DashboardCard, ImageArchiveConfig } from "../types";
import {
	archiveStrayImages,
	countStrayImages,
	DEFAULT_IMAGE_ARCHIVE_FOLDER,
} from "../imagearchive";
import type { HomeView } from "../view";
import type { CardDefinition, CardEditorContext } from "./definition";

/** Guards against a second click while a move is in flight for this card. */
const archiving = new WeakMap<DashboardCard, boolean>();

function targetFolder(cfg: ImageArchiveConfig): string {
	return (cfg.targetFolder?.trim() || DEFAULT_IMAGE_ARCHIVE_FOLDER).replace(/\/+$/, "");
}

async function runArchive(view: HomeView, card: DashboardCard, folder: string): Promise<void> {
	const strings = t().cards.imagearchive;
	archiving.set(card, true);
	try {
		const result = await archiveStrayImages(view.app, folder);
		new Notice(
			result.failed > 0
				? strings.movedWithFailures(result.moved, result.failed)
				: strings.moved(result.moved),
		);
	} catch (error) {
		console.error("Flexible Workbench: image archive failed", error);
		new Notice(strings.failed(error instanceof Error ? error.message : String(error)));
	} finally {
		archiving.set(card, false);
		// Redraw so the count (and the now-empty state) reflect the moved files.
		view.render();
	}
}

function renderImageArchive(
	view: HomeView,
	card: DashboardCard,
	body: HTMLElement,
	_component: Component,
): void {
	const cfg = card.imagearchive ?? {};
	const folder = targetFolder(cfg);
	const strings = t().cards.imagearchive;
	const busy = archiving.get(card) ?? false;
	const count = countStrayImages(view.app, folder);

	const wrap = body.createDiv("flexible-workbench-imagearchive");
	if (count === 0 && !busy) {
		emptyState(wrap, "image-down", strings.empty(folder));
		return;
	}

	wrap.createDiv({ cls: "flexible-workbench-imagearchive-summary", text: strings.summary(count, folder) });
	const button = wrap.createEl("button", { cls: "flexible-workbench-imagearchive-action" });
	setIcon(button.createSpan("flexible-workbench-imagearchive-action-icon"), "folder-input");
	button.createSpan({ text: strings.button });
	button.disabled = busy;
	button.toggleClass("is-loading", busy);
	button.addEventListener("click", () => {
		if (archiving.get(card)) return;
		confirmAction(view.app, {
			title: strings.confirmTitle,
			message: strings.confirmMessage(count, folder),
			confirmText: strings.confirmButton,
			onConfirm: () => {
				button.disabled = true;
				button.toggleClass("is-loading", true);
				void runArchive(view, card, folder);
			},
		});
	});
}

export function imageArchiveEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg = (ctx.card.imagearchive ??= {});
	const strings = t().editors.imagearchive;
	new Setting(containerEl)
		.setName(strings.targetFolder)
		.setDesc(strings.targetFolderDesc)
		.addText((text) => text
			.setPlaceholder(DEFAULT_IMAGE_ARCHIVE_FOLDER)
			.setValue(cfg.targetFolder ?? "")
			.onChange((value) => {
				cfg.targetFolder = value.trim() || undefined;
				ctx.opts.save();
				ctx.requestRender();
			}));
}

/** A one-click "tidy stray images into an archive folder, links intact" card. */
export const imageArchiveCard: CardDefinition<"imagearchive"> = {
	kind: "imagearchive",
	templates: [
		{
			id: "imagearchive",
			name: "Image archiver",
			icon: "image-down",
			build: () => ({ kind: "imagearchive", title: "", imagearchive: {}, w: 4, h: 3 }),
		},
	],
	render: (view, card, body, component) => renderImageArchive(view, card, body, component),
	renderEditor: (container, ctx) => imageArchiveEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.imagearchive) copy.imagearchive = { ...source.imagearchive };
	},
	liveness: { mode: "vault" },
};
