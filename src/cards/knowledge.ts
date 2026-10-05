import { Component, MarkdownRenderer, Modal, Notice, Platform, setIcon } from "obsidian";
import {
	collectInbox,
	createCapture,
	ensureKnowledgeConfig,
	generateKnowledgeLogSummary,
	isKnowledgeLogPending,
	markKnowledgeLogReviewed,
	providerLabel,
	readKnowledgeLogPage,
	saveKnowledgeLogSummary,
	scanKnowledgeLogs,
	summarizeKnowledgeLog,
	type KnowledgeLogEntry,
	type KnowledgeLogMessage,
} from "../knowledge";
import { type DashboardCard } from "../types";
import { type HomeView } from "../view";
import { type CardDefinition } from "./definition";
import { t } from "../i18n";

type KnowledgeTab = "inbox" | "review";

function shortText(text: string, max = 170): string {
	const compact = text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
	return compact.length > max ? `${compact.slice(0, max).trimEnd()}…` : compact;
}

function actionButton(parent: HTMLElement, label: string, icon: string, action: () => void, cls = ""): HTMLButtonElement {
	const button = parent.createEl("button", { cls: `knowledge-action ${cls}`.trim(), text: label });
	const glyph = button.createSpan("knowledge-action-icon");
	setIcon(glyph, icon);
	button.prepend(glyph);
	button.addEventListener("click", action);
	return button;
}

function openSource(view: HomeView, path: string): void {
	void view.app.workspace.openLinkText(path, "", false);
}

function formatDate(value: number): string {
	return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderKnowledge(view: HomeView, card: DashboardCard, body: HTMLElement, component: Component): void {
	const labels = t().cards.knowledge;
	const config = ensureKnowledgeConfig(view.app, card.knowledge);
	card.knowledge = config;
	if (card.title === "Knowledge Workbench" && t().templates.knowledge !== "Knowledge Workbench") {
		card.title = t().templates.knowledge;
		const title = body.closest(".flexible-workbench-card")?.querySelector(".flexible-workbench-card-title");
		if (title) title.textContent = card.title;
	}
	body.addClass("flexible-workbench-knowledge");
	const shell = body.createDiv("knowledge-shell");
	const tabBar = shell.createDiv("knowledge-tabs");
	const content = shell.createDiv("knowledge-content");
	let activeTab: KnowledgeTab = "inbox";
	let selectedLogPath = "";
	let renderGeneration = 0;
	let detailGeneration = 0;
	let transcriptComponent: Component | null = null;
	let providerFilter: "all" | "codex" | "claude" = "all";
	let visibleLogLimit = 60;
	const disposeTranscriptComponent = () => {
		if (transcriptComponent) component.removeChild(transcriptComponent);
		transcriptComponent = null;
	};

	const persistConfig = async () => view.plugin.saveData(view.plugin.settings);
	const renderTabBar = () => {
		tabBar.empty();
		const tabs: { id: KnowledgeTab; label: string; icon: string }[] = [
			{ id: "inbox", label: labels.inboxTab, icon: "inbox" },
			{ id: "review", label: labels.reviewTab, icon: "clipboard-check" },
		];
		for (const tab of tabs) {
			const button = tabBar.createEl("button", { cls: "knowledge-tab", text: tab.label });
			const icon = button.createSpan("knowledge-tab-icon");
			setIcon(icon, tab.icon);
			button.prepend(icon);
			button.toggleClass("is-active", activeTab === tab.id);
			button.addEventListener("click", () => {
				activeTab = tab.id;
				renderTabBar();
				void renderTab();
			});
		}
	};

	const renderInbox = async (generation: number) => {
		detailGeneration++;
		disposeTranscriptComponent();
		content.empty();
		const intro = content.createDiv("knowledge-intro");
		intro.createEl("h3", { text: labels.inboxHeading });
		intro.createEl("p", { text: labels.inboxDesc(config.inboxFolder) });
		const form = content.createDiv("knowledge-capture-form");
		const line = form.createEl("input", {
			cls: "knowledge-capture-line",
			attr: { type: "text", placeholder: labels.capturePlaceholder, autocomplete: "off" },
		});
		const save = form.createEl("button", { cls: "knowledge-primary", text: labels.captureButton });
		const doCapture = async (value: string, button: HTMLButtonElement, source: "quick-capture" | "gemini-paste") => {
			if (!value.trim()) return;
			button.disabled = true;
			button.setText(labels.saving);
			try {
				await createCapture(view.app, config, value, source);
				line.value = "";
				if (source === "gemini-paste") paste.value = "";
				if (activeTab === "inbox") await renderInbox(renderGeneration);
				new Notice(labels.captured);
			} catch (error) {
				new Notice(error instanceof Error ? error.message : String(error));
			} finally {
				button.disabled = false;
				button.setText(source === "quick-capture" ? labels.captureButton : labels.geminiSave);
			}
		};
		save.addEventListener("click", () => void doCapture(line.value, save, "quick-capture"));
		line.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void doCapture(line.value, save, "quick-capture");
			}
		});
		const actions = content.createDiv("knowledge-inline-actions");
		actionButton(actions, labels.geminiOpen, "sparkles", () => window.open("https://gemini.google.com/app", "_blank", "noopener"));
		const globalSearch = actionButton(actions, labels.searchVault, "search", () => {
			const input = view.contentEl.querySelector<HTMLInputElement>(".flexible-workbench-search-input");
			if (input) input.focus();
			else new Notice(labels.searchUnavailable);
		});
		globalSearch.addClass("knowledge-subtle-action");
		const paste = content.createEl("textarea", {
			cls: "knowledge-gemini-paste",
			attr: { placeholder: labels.geminiPastePlaceholder, rows: "3" },
		});
		const pasteSave = content.createEl("button", { cls: "knowledge-secondary", text: labels.geminiSave });
		pasteSave.addEventListener("click", () => void doCapture(paste.value, pasteSave, "gemini-paste"));

		const heading = content.createDiv("knowledge-section-heading");
		heading.createEl("h4", { text: labels.unreviewedHeading });
		const entries = content.createDiv("knowledge-entry-list");
		const sources = await collectInbox(view.app, config);
		if (generation !== renderGeneration) return;
		if (!sources.length) {
			entries.createEl("p", { cls: "knowledge-empty", text: labels.inboxEmpty });
			return;
		}
		for (const source of sources.slice(0, 12)) {
			const row = entries.createDiv("knowledge-entry");
			const open = row.createEl("button", { cls: "knowledge-entry-main" });
			open.createEl("strong", { text: source.title });
			open.createSpan({ text: shortText(source.content) });
			open.addEventListener("click", () => openSource(view, source.path));
			row.createSpan({ cls: "knowledge-status is-unreviewed", text: labels.unreviewed });
		}
	};

	const renderLogPage = async (messages: KnowledgeLogMessage[], transcript: HTMLElement, renderer: Component, prepend = false) => {
		const page = transcript.createDiv("knowledge-log-page");
		if (prepend) transcript.prepend(page);
		for (const message of messages) {
			const turn = page.createDiv(`knowledge-log-turn is-${message.role}`);
			turn.createEl("strong", { text: message.role === "user" ? labels.userRole : labels.assistantRole });
			const markdown = turn.createDiv("knowledge-log-markdown");
			await MarkdownRenderer.render(view.app, message.text, markdown, "", renderer);
		}
	};

	const showSummaryPreview = (entry: KnowledgeLogEntry, markdown: string) => {
		const modal = new Modal(view.app);
		modal.titleEl.setText(labels.summaryPreviewHeading);
		modal.contentEl.createEl("p", {
			cls: "knowledge-summary-preview-desc",
			text: labels.summaryPreviewDesc(providerLabel(entry.provider)),
		});
		const title = modal.contentEl.createEl("input", {
			cls: "knowledge-summary-title",
			attr: { type: "text", value: entry.title, placeholder: labels.summaryTitlePlaceholder },
		});
		const body = modal.contentEl.createEl("textarea", {
			cls: "knowledge-summary-body",
			attr: { rows: "18", placeholder: labels.summaryBodyPlaceholder },
		});
		body.value = markdown;
		const actions = modal.contentEl.createDiv("knowledge-summary-actions");
		const cancel = actions.createEl("button", { cls: "knowledge-secondary", text: labels.cancelSummary });
		cancel.addEventListener("click", () => modal.close());
		const save = actions.createEl("button", { cls: "knowledge-primary", text: labels.saveSummary });
		save.addEventListener("click", () => {
			save.disabled = true;
			save.setText(labels.savingSummary);
			void saveKnowledgeLogSummary(view.app, entry, title.value, body.value).then((file) => {
				modal.close();
				new Notice(labels.summarySaved(file.path));
			}).catch((error: unknown) => {
				save.disabled = false;
				save.setText(labels.saveSummary);
				new Notice(error instanceof Error ? error.message : String(error));
			});
		});
		modal.open();
	};

	const renderLogDetail = async (
		entry: KnowledgeLogEntry,
		detail: HTMLElement,
		isPending: boolean,
		onReviewed: () => void,
	) => {
		const generation = ++detailGeneration;
		disposeTranscriptComponent();
		detail.empty();
		detail.createEl("h4", { cls: "knowledge-log-title", text: entry.title });
		detail.createEl("p", { cls: "knowledge-log-meta", text: `${providerLabel(entry.provider)} · ${formatDate(entry.modifiedAt)}` });
		const sourcePath = detail.createEl("details", { cls: "knowledge-log-source" });
		sourcePath.createEl("summary", { text: labels.logFilePath });
		sourcePath.createEl("code", { text: entry.path });
		const page = readKnowledgeLogPage(entry);
		const actions = detail.createDiv("knowledge-log-actions");
		if (isPending) {
			const mark = actions.createEl("button", { cls: "knowledge-primary", text: labels.markLogReviewed });
			mark.addEventListener("click", onReviewed);
		} else if (page.messages.length) {
			const summarize = actions.createEl("button", { cls: "knowledge-secondary", text: labels.summarizeLog });
			summarize.addEventListener("click", () => {
				summarize.disabled = true;
				summarize.setText(labels.summarizingLog);
				new Notice(labels.summarizingWith(providerLabel(entry.provider)));
				void generateKnowledgeLogSummary(entry).then((markdown) => {
					if (generation === detailGeneration) showSummaryPreview(entry, markdown);
				}).catch((error: unknown) => {
					if (generation === detailGeneration) new Notice(error instanceof Error ? error.message : String(error));
				}).finally(() => {
					if (generation === detailGeneration) {
						summarize.disabled = false;
						summarize.setText(labels.summarizeLog);
					}
				});
			});
		}
		if (!page.messages.length) {
			detail.createEl("p", { cls: "knowledge-empty", text: labels.logUnreadable });
			return;
		}
		let previousOffset = page.previousOffset;
		const earlier = detail.createEl("button", { cls: "knowledge-secondary knowledge-load-earlier", text: labels.loadEarlierMessages });
		if (!previousOffset) earlier.hide();
		const transcript = detail.createDiv("knowledge-log-transcript");
		transcriptComponent = new Component();
		component.addChild(transcriptComponent);
		const renderer = transcriptComponent;
		await renderLogPage(page.messages, transcript, renderer);
		if (generation !== detailGeneration) return;
		detail.scrollTop = detail.scrollHeight;
		earlier.addEventListener("click", () => {
			if (!previousOffset) return;
			const endAt = previousOffset;
			earlier.disabled = true;
			earlier.setText(labels.loadingEarlierMessages);
			const priorHeight = detail.scrollHeight;
			const priorScrollTop = detail.scrollTop;
			try {
				const olderPage = readKnowledgeLogPage(entry, endAt);
				previousOffset = olderPage.previousOffset;
				void renderLogPage(olderPage.messages, transcript, renderer, true).then(() => {
					earlier.disabled = false;
					earlier.setText(labels.loadEarlierMessages);
					if (previousOffset) earlier.show();
					else earlier.hide();
					detail.scrollTop = priorScrollTop + detail.scrollHeight - priorHeight;
				}).catch((error: unknown) => {
					earlier.disabled = false;
					earlier.setText(error instanceof Error ? error.message : String(error));
				});
			} catch (error) {
				earlier.disabled = false;
				earlier.setText(error instanceof Error ? error.message : String(error));
			}
		});
	};

	const renderReview = async () => {
		const generation = ++renderGeneration;
		detailGeneration++;
		disposeTranscriptComponent();
		content.empty();
		const heading = content.createDiv("knowledge-intro");
		heading.createEl("h3", { text: labels.reviewHeading });
		heading.createEl("p", { text: labels.reviewDesc });
		const paths = content.createDiv("knowledge-log-paths");
		const codexRow = paths.createDiv("knowledge-log-path-row");
		const codexLabel = codexRow.createEl("label", { text: labels.codexLogPath });
		const codexInput = codexLabel.createEl("input", { attr: { type: "text", value: config.codexLogsPath } });
		codexInput.addEventListener("change", () => {
			config.codexLogsPath = codexInput.value.trim();
			void persistConfig().then(() => loadLogs());
		});
		const claudeRow = paths.createDiv("knowledge-log-path-row");
		const claudeLabel = claudeRow.createEl("label", { text: labels.claudeLogPath });
		const claudeInput = claudeLabel.createEl("input", { attr: { type: "text", value: config.claudeLogsPath } });
		claudeInput.addEventListener("change", () => {
			config.claudeLogsPath = claudeInput.value.trim();
			void persistConfig().then(() => loadLogs());
		});
		const toolbar = content.createDiv("knowledge-log-toolbar");
		const filter = toolbar.createEl("select", { cls: "knowledge-log-filter" });
		filter.createEl("option", { text: labels.allProviders, attr: { value: "all" } });
		filter.createEl("option", { text: labels.codexName, attr: { value: "codex" } });
		filter.createEl("option", { text: labels.claudeCodeName, attr: { value: "claude" } });
		filter.value = providerFilter;
		filter.addEventListener("change", () => {
			providerFilter = filter.value as typeof providerFilter;
			selectedLogPath = "";
			visibleLogLimit = 60;
			void loadLogs();
		});
		const refresh = toolbar.createEl("button", { cls: "knowledge-secondary", text: labels.refreshLogs });
		const summary = toolbar.createSpan({ cls: "knowledge-log-summary" });
		const split = content.createDiv("knowledge-log-split");
		const list = split.createDiv("knowledge-log-list");
		const detail = split.createDiv("knowledge-log-detail");
		const loadLogs = async () => {
			list.empty();
			detailGeneration++;
			disposeTranscriptComponent();
			detail.empty();
			if (Platform.isMobile) {
				summary.setText(labels.logsDesktopOnly);
				list.createEl("p", { cls: "knowledge-empty", text: labels.logsDesktopOnly });
				return;
			}
			refresh.disabled = true;
			refresh.setText(labels.loadingLogs);
			const allLogs = scanKnowledgeLogs(config, Number.MAX_SAFE_INTEGER, false);
			const matchingLogs = allLogs.filter((entry) => providerFilter === "all" || entry.provider === providerFilter);
			const logs = matchingLogs.slice(0, visibleLogLimit).map(summarizeKnowledgeLog);
			if (generation !== renderGeneration) return;
			const reviewed = view.plugin.settings.knowledgeReviewedLogs ?? {};
			const pending = matchingLogs.filter((entry) => isKnowledgeLogPending(entry, reviewed, view.plugin.settings.knowledgeLogBaselineAt ?? 0));
			summary.setText(labels.pendingLogCount(pending.length, matchingLogs.length));
			if (!matchingLogs.length) list.createEl("p", { cls: "knowledge-empty", text: labels.logsEmpty });
			const buttonsByPath = new Map<string, HTMLButtonElement>();
			for (const entry of logs) {
				const row = list.createDiv("knowledge-log-entry");
				const select = row.createEl("button", { cls: "knowledge-log-entry-main" });
				buttonsByPath.set(entry.path, select);
				select.toggleClass("is-active", selectedLogPath === entry.path);
				select.createSpan({ cls: "knowledge-log-entry-title", text: entry.title });
				select.createSpan({ cls: "knowledge-log-entry-meta", text: `${providerLabel(entry.provider)} · ${formatDate(entry.modifiedAt)}` });
				const isPending = isKnowledgeLogPending(entry, reviewed, view.plugin.settings.knowledgeLogBaselineAt ?? 0);
				row.createSpan({ cls: `knowledge-status ${isPending ? "is-unreviewed" : "is-reviewed"}`, text: isPending ? labels.unreviewed : labels.reviewed });
				select.addEventListener("click", () => {
					selectedLogPath = entry.path;
					for (const item of Array.from(list.querySelectorAll(".knowledge-log-entry-main"))) item.removeClass("is-active");
					select.addClass("is-active");
					void renderLogDetail(entry, detail, isPending, () => {
						void markKnowledgeLogReviewed(view.plugin, entry).then(() => loadLogs());
					});
				});
			}
			const selected = logs.find((entry) => entry.path === selectedLogPath) ?? logs[0];
			if (selected) {
				selectedLogPath = selected.path;
				buttonsByPath.get(selected.path)?.addClass("is-active");
				const selectedPending = isKnowledgeLogPending(selected, reviewed, view.plugin.settings.knowledgeLogBaselineAt ?? 0);
				void renderLogDetail(selected, detail, selectedPending, () => {
					void markKnowledgeLogReviewed(view.plugin, selected).then(() => loadLogs());
				});
			}
			if (matchingLogs.length > logs.length) {
				const more = list.createEl("button", { cls: "knowledge-secondary knowledge-load-more", text: labels.loadMoreLogs(matchingLogs.length - logs.length) });
				more.addEventListener("click", () => {
					visibleLogLimit += 60;
					void loadLogs();
				});
			}
			refresh.disabled = false;
			refresh.setText(labels.refreshLogs);
		};
		refresh.addEventListener("click", () => void loadLogs());
		await loadLogs();
	};

	const renderTab = async () => {
		const generation = ++renderGeneration;
		try {
			if (activeTab === "inbox") await renderInbox(generation);
			else await renderReview();
		} catch (error) {
			content.empty();
			content.createEl("p", { cls: "knowledge-error", text: error instanceof Error ? error.message : String(error) });
		}
	};

	component.register(() => {
		renderGeneration++;
		detailGeneration++;
		disposeTranscriptComponent();
	});
	renderTabBar();
	void renderTab();
}

export const knowledgeCard: CardDefinition<"knowledge"> = {
	kind: "knowledge",
	templates: [{
		id: "knowledge",
		name: "Knowledge Workbench",
		icon: "brain-circuit",
		build: () => ({ kind: "knowledge", title: t().templates.knowledge, w: 8, h: 7 }),
	}],
	render: (view, card, body, component) => renderKnowledge(view, card, body, component),
	cloneConfig: (source, copy) => {
		if (source.knowledge) copy.knowledge = { ...source.knowledge };
	},
	cardClass: "is-knowledge-card",
	liveness: { mode: "static" },
};
