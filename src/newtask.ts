/**
 * Dashboard's Jira-aware TaskNotes quick-create flow. TaskNotes has no stable
 * create API, but its task format is frontmatter; create the minimal task note
 * using its live field mapping and leave Jira entirely read-only.
 */
import { Modal, Notice, Setting, TFolder, type App, type TFile } from "obsidian";
import { t } from "./i18n";
import { loadMyOpenJiraSubtasks, type JiraIssue } from "./jira";
import { openFile, type OpenFrom } from "./opener";
import {
	openStatusValue,
	readTaskNotesSetup,
	taskNotesEnabled,
	type TaskNotesSetup,
} from "./tasknotes";
import type { HomeSettings, JiraConfig } from "./types";

const JIRA_KEY_FIELD = "jira_key";
const JIRA_URL_FIELD = "jira_url";
const JIRA_LINKED_AT_FIELD = "jira_linked_at";
const TODO_SCOPE_FIELD = "todo_scope";
const TODO_PROJECT_FIELD = "todo_project";

/** Find the first configured Jira card. A quick-create task needs the same
 * connection settings as the dashboard, not a second token configuration. */
function jiraConnection(settings: HomeSettings): JiraConfig | null {
	for (const dashboard of settings.dashboards) {
		for (const card of dashboard.cards) {
			if (card.jira?.host?.trim() && card.jira.pat?.trim()) return card.jira;
		}
	}
	return null;
}

function jiraUrl(config: JiraConfig, key: string): string {
	return `${config.host!.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}

/** Make a TaskNotes-recognised note while respecting every remapped field. */
async function createTaskNote(
	app: App,
	setup: TaskNotesSetup,
	title: string,
	issue: JiraIssue | null,
	config: JiraConfig | null,
	project: string,
	projectLevel: boolean,
): Promise<TFile> {
	const parent = app.fileManager.getNewFileParent("");
	const folder = parent instanceof TFolder ? parent : app.vault.getRoot();
	const file = await app.fileManager.createNewMarkdownFile(folder, title);
	const fields = setup.fields;
	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		frontmatter[fields.title] = title;
		frontmatter[fields.status] = openStatusValue(setup);
		if (project) frontmatter[TODO_PROJECT_FIELD] = project;
		if (projectLevel) frontmatter[TODO_SCOPE_FIELD] = "project";
		if (setup.identify.method === "property" && setup.identify.property) {
			frontmatter[setup.identify.property] = setup.identify.value || true;
		} else {
			frontmatter.tags = [setup.identify.tag];
		}
		if (issue && config) {
			frontmatter[JIRA_KEY_FIELD] = issue.key;
			frontmatter[JIRA_URL_FIELD] = jiraUrl(config, issue.key);
			frontmatter[JIRA_LINKED_AT_FIELD] = new Date().toISOString();
		}
	});
	return file;
}

class JiraTaskCreateModal extends Modal {
	private title = "";
	private issues: JiraIssue[] = [];
	private selectedKey = "";
	private project = "";
	private projectLevel = false;
	private select: HTMLSelectElement | null = null;
	private readonly config: JiraConfig | null;

	constructor(
		app: App,
		private readonly settings: HomeSettings,
		private readonly from: OpenFrom,
		private readonly onProjectTodoCreated?: () => Promise<void> | void,
	) {
		super(app);
		this.config = jiraConnection(settings);
	}

	onOpen(): void {
		const strings = t().cards.tasks;
		this.titleEl.setText(strings.quickCreateTitle);
		const error = this.contentEl.createDiv("flexible-workbench-task-create-error");

		new Setting(this.contentEl).setName(strings.title).addText((text) =>
			text
				.setPlaceholder(strings.addCardPlaceholder)
				.onChange((value) => (this.title = value.trim())),
		);
		new Setting(this.contentEl).setName(strings.projectLevel).addToggle((toggle) =>
			toggle.setValue(false).onChange((value) => (this.projectLevel = value)),
		);
		new Setting(this.contentEl).setName(strings.project).addText((text) =>
			text.setPlaceholder(strings.projectPlaceholder).onChange((value) => (this.project = value.trim())),
		);

		const jira = new Setting(this.contentEl)
			.setName(strings.jiraLink)
			.setDesc(this.config ? strings.jiraLinkDesc : strings.jiraNotConfigured);
		jira.addDropdown((dropdown) => {
			this.select = dropdown.selectEl;
			this.renderIssues();
			dropdown.onChange((key) => (this.selectedKey = key));
		});
		jira.addExtraButton((button) =>
			button
				.setIcon("refresh-cw")
				.setTooltip(strings.jiraRefresh)
				.setDisabled(!this.config)
				.onClick(async () => {
					if (!this.config) return;
					button.setDisabled(true);
					error.setText("");
					try {
						this.issues = await loadMyOpenJiraSubtasks(this.config);
						this.renderIssues();
					} catch {
						error.setText(strings.jiraLoadFailed);
					} finally {
						button.setDisabled(false);
					}
				}),
		);

		const submit = async (): Promise<void> => {
			if (!this.title) {
				error.setText(strings.taskTitleRequired);
				return;
			}
			if (this.projectLevel && !this.project) {
				error.setText(strings.projectRequired);
				return;
			}
			try {
				const issue = this.issues.find((item) => item.key === this.selectedKey) ?? null;
				const file = await createTaskNote(this.app, readTaskNotesSetup(this.app), this.title, issue, this.config, this.project, this.projectLevel);
				if (this.projectLevel) await this.onProjectTodoCreated?.();
				this.close();
				await openFile(this.from, file, "newNote");
			} catch (cause) {
				console.error("Flexible Workbench task creation error", cause);
				error.setText(strings.taskCreateFailed);
			}
		};
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t().confirm.cancel).onClick(() => this.close()))
			.addButton((button) => button.setButtonText(strings.quickCreate).setCta().onClick(() => void submit()));

		if (this.config) void this.refreshIssues(error);
	}

	private async refreshIssues(error: HTMLElement): Promise<void> {
		try {
			this.issues = await loadMyOpenJiraSubtasks(this.config!);
			this.renderIssues();
		} catch {
			error.setText(t().cards.tasks.jiraLoadFailed);
		}
	}

	private renderIssues(): void {
		if (!this.select) return;
		this.select.empty();
		this.select.createEl("option", { value: "", text: t().cards.tasks.jiraNoLink });
		for (const issue of this.issues) {
			const due = issue.fields.duedate ? ` · ${issue.fields.duedate}` : "";
			this.select.createEl("option", {
				value: issue.key,
				text: `${issue.key} · ${issue.fields.summary} (${issue.fields.status.name}${due})`,
			});
		}
		this.select.value = this.selectedKey;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Open the Dashboard-owned task creator. It only stores a Jira reference;
 * Jira transitions stay behind deliberate, future sync actions. */
export function createJiraLinkedTask(app: App, settings: HomeSettings, from: OpenFrom, onProjectTodoCreated?: () => Promise<void> | void): void {
	if (!taskNotesEnabled(app)) {
		new Notice(t().notices.taskNotesCreateFailed);
		return;
	}
	new JiraTaskCreateModal(app, settings, from, onProjectTodoCreated).open();
}
