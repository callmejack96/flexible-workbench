import { Notice, normalizePath, setIcon, Setting, TFile } from "obsidian";
import { localDayKey } from "../dates";
import { t } from "../i18n";
import { type DashboardCard, type DashboardTodo } from "../types";
import { createTimerRecord, formatTimerElapsed, getActiveTimer, getTimerRecords, sortTimerRecords } from "../time-tracking";
import { refreshTodoTimeReports, type CompletedTodo } from "../todo-reports";
import { promptForText } from "../ui";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";

export const DEFAULT_TODO_ARCHIVE_FOLDER = "archive/todos";

function todoId(): string {
	return activeWindow.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function archiveFolder(card: DashboardCard): string {
	const normalized = normalizePath(card.dailyArchiveFolder?.trim() || DEFAULT_TODO_ARCHIVE_FOLDER).replace(/^\/+|\/+$/g, "");
	return normalized || DEFAULT_TODO_ARCHIVE_FOLDER;
}

async function ensureFolder(view: HomeView, folder: string): Promise<void> {
	const parts = normalizePath(folder).split("/").filter(Boolean);
	if (parts.includes("..")) throw new Error("Archive folder must be inside the vault");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const existing = view.app.vault.getAbstractFileByPath(current);
		if (!existing) {
			try {
				await view.app.vault.createFolder(current);
			} catch (error) {
				if (!view.app.vault.getAbstractFileByPath(current)) throw error;
			}
		} else if (!("children" in existing)) {
			throw new Error(`A file already exists at ${current}`);
		}
	}
}

async function writeTodoArchive(
	view: HomeView,
	card: DashboardCard,
	todo: DashboardTodo,
	completedAt = new Date().toISOString(),
): Promise<CompletedTodo> {
	const folder = archiveFolder(card);
	await ensureFolder(view, folder);
	const day = localDayKey(Date.parse(completedAt));
	const suffix = todo.id.replace(/[^a-z0-9_-]/gi, "") || todoId();
	const title = todo.text
		.replace(/[\\/:*?"<>|#^]/g, "")
		.split("[").join("")
		.split("]").join("")
		.replace(/\s+/g, "-")
		.slice(0, 64) || "todo";
	const path = normalizePath(`${folder}/${day}-${title}-${suffix}.md`);
	const existing = view.app.vault.getAbstractFileByPath(path);
	if (existing) {
		if (!(existing instanceof TFile)) throw new Error(`A folder already exists at ${path}`);
		const frontmatter = view.app.metadataCache.getFileCache(existing)?.frontmatter;
		const archivedAt = typeof frontmatter?.completed_at === "string" ? frontmatter.completed_at : completedAt;
		return { todoId: todo.id, text: todo.text, completedAt: archivedAt, archivePath: path };
	}

	const linked = getTimerRecords(view.plugin.settings)
		.filter((entry) => entry.todoId === todo.id)
		.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	const strings = t().cards.todoList;
	const sections = linked.map((entry) => {
		const started = Number.isFinite(Date.parse(entry.startedAt)) ? new Date(entry.startedAt).toLocaleString() : entry.startedAt;
		const ended = entry.endedAt && Number.isFinite(Date.parse(entry.endedAt)) ? new Date(entry.endedAt).toLocaleString() : strings.archiveTimeIncomplete;
		const duration = typeof entry.durationSeconds === "number" ? formatTimerElapsed(entry.durationSeconds) : strings.archiveTimeIncomplete;
		return [
			`### ${entry.description}`,
			`- ${strings.archiveStarted}: ${started}`,
			`- ${strings.archiveEnded}: ${ended}`,
			`- ${strings.archiveDuration}: ${duration}`,
			entry.summary || entry.pendingSummary
				? `- ${strings.archiveSummary}: ${entry.summary || entry.pendingSummary}`
				: `- ${strings.archiveSummary}: ${strings.archiveTimeIncomplete}`,
		].join("\n");
	});
	const content = [
		"---",
		`todo_id: ${JSON.stringify(todo.id)}`,
		`todo_text: ${JSON.stringify(todo.text)}`,
		`completed_at: ${JSON.stringify(completedAt)}`,
		"---",
		"",
		`# ${todo.text}`,
		"",
		...(sections.length ? [`## ${strings.archiveTimeEntries}`, "", ...sections.flatMap((section) => [section, ""])] : []),
	].join("\n");
	await view.app.vault.create(path, content);
	return { todoId: todo.id, text: todo.text, completedAt, archivePath: path };
}

async function startTodoTimer(view: HomeView, todo: DashboardTodo): Promise<void> {
	const strings = t().cards.todoList;
	const timerStrings = t().cards.timer;
	const settings = view.plugin.settings;
	if (getActiveTimer(settings)) {
		new Notice(strings.timerAlreadyRunning);
		return;
	}
	const description = await promptForText(view.app, {
		title: timerStrings.timerStartTitle,
		label: timerStrings.timerDescriptionLabel,
		placeholder: timerStrings.timerDescriptionPlaceholder,
		initial: todo.text,
	});
	if (description === null) return;
	const cleanDescription = description.trim();
	if (!cleanDescription) {
		new Notice(timerStrings.timerDescriptionRequired);
		return;
	}
	if (getActiveTimer(settings)) {
		new Notice(strings.timerAlreadyRunning);
		return;
	}
	const record = createTimerRecord(cleanDescription, { todoId: todo.id, todoText: todo.text });
	const previousRecords = getTimerRecords(settings);
	settings.timerRecords = sortTimerRecords([record, ...previousRecords]);
	try {
		await view.plugin.saveData(settings);
	} catch (error) {
		settings.timerRecords = previousRecords;
		new Notice(timerStrings.timerSaveFailed(String(error)));
		return;
	}
	view.render();
}

/**
 * A lightweight Todo List stored directly on the dashboard. Completing a row
 * writes a durable note into its archive folder and removes it from the active list.
 */
export function renderDaily(view: HomeView, card: DashboardCard, body: HTMLElement): void {
	const todos = card.dailyTodos ?? (card.dailyTodos = []);
	const strings = t().cards.todoList;
	const save = () => void view.plugin.saveData(view.plugin.settings);
	const redraw = () => {
		body.empty();
		renderDaily(view, card, body);
	};
	const list = body.createDiv("flexible-workbench-dashboard-todos");
	for (const todo of todos) renderTodo(view, card, todo, todos, list, save, redraw);

	const add = body.createEl("form", { cls: "flexible-workbench-dashboard-todo-add" });
	const input = add.createEl("input", { attr: { type: "text", placeholder: strings.addPlaceholder, "aria-label": strings.addPlaceholder } });
	const button = add.createEl("button", { attr: { type: "submit", "aria-label": strings.addButton } });
	setIcon(button, "plus");
	add.addEventListener("submit", (event) => {
		event.preventDefault();
		const text = input.value.trim();
		if (!text) return;
		todos.push({ id: todoId(), text });
		save();
		redraw();
	});
}

function renderTodo(
	view: HomeView,
	card: DashboardCard,
	todo: DashboardTodo,
	todos: DashboardTodo[],
	list: HTMLElement,
	save: () => void,
	redraw: () => void,
): void {
	const strings = t().cards.todoList;
	const row = list.createDiv("flexible-workbench-dashboard-todo");
	row.toggleClass("is-done", todo.done === true);
	const check = row.createEl("input", { attr: { type: "checkbox", "aria-label": todo.text } });
	check.checked = todo.done === true;
	let archiving = false;
	check.addEventListener("change", () => {
		if (!check.checked) {
			todo.done = undefined;
			row.toggleClass("is-done", false);
			save();
			return;
		}
		if (archiving) return;
		archiving = true;
		check.disabled = true;
		void (async () => {
			let removedIndex = -1;
			try {
				const active = getActiveTimer(view.plugin.settings);
				if (active?.todoId === todo.id) {
					new Notice(strings.finishTimerFirst);
					check.checked = false;
					return;
				}
				const completion = await writeTodoArchive(view, card, todo);
				removedIndex = todos.indexOf(todo);
				if (removedIndex >= 0) todos.splice(removedIndex, 1);
				const previousCompletions = view.plugin.settings.todoCompletions;
				view.plugin.settings.todoCompletions = [
					...(previousCompletions ?? []).filter((entry) => entry.todoId !== completion.todoId),
					completion,
				];
				try {
					await view.plugin.saveData(view.plugin.settings);
				} catch (error) {
					view.plugin.settings.todoCompletions = previousCompletions ?? [];
					throw error;
				}
				try {
					await refreshTodoTimeReports(view, completion);
				} catch (reportError) {
					new Notice(strings.reportUpdateFailed(String(reportError)));
				}
				view.render();
			} catch (error) {
				if (removedIndex >= 0 && !todos.includes(todo)) todos.splice(Math.min(removedIndex, todos.length), 0, todo);
				console.error("Flexible Workbench: todo archive failed", error);
				new Notice(strings.archiveFailed(String(error)));
				check.checked = false;
			} finally {
				check.disabled = false;
				archiving = false;
			}
		})();
	});
	row.createSpan({ cls: "flexible-workbench-dashboard-todo-text", text: todo.text });
	const timer = row.createEl("button", {
		attr: { type: "button", "aria-label": strings.startTimer(todo.text), title: strings.startTimer(todo.text) },
	});
	setIcon(timer, "play");
	timer.addEventListener("click", () => void startTodoTimer(view, todo));
	const remove = row.createEl("button", { attr: { type: "button", "aria-label": strings.remove(todo.text) } });
	setIcon(remove, "x");
	remove.addEventListener("click", () => {
		const index = todos.indexOf(todo);
		if (index >= 0) todos.splice(index, 1);
		save();
		redraw();
	});
}

export function dailyTodoEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const strings = t().editors.dailyTodo;
	new Setting(containerEl)
		.setName(strings.archiveFolder)
		.setDesc(strings.archiveFolderDesc)
		.addText((text) => text
			.setPlaceholder(DEFAULT_TODO_ARCHIVE_FOLDER)
			.setValue(ctx.card.dailyArchiveFolder ?? "")
			.onChange((value) => {
				ctx.card.dailyArchiveFolder = value.trim() || undefined;
				ctx.opts.save();
				ctx.requestRender();
			}));
}

/** Dashboard-local Todo List. `daily` remains the persisted kind for backwards compatibility. */
export const dailyCard: CardDefinition<"daily"> = {
	kind: "daily",
	templates: [
		{ id: "daily", name: "Todo List", icon: "list-todo", build: () => ({ kind: "daily", title: "Todo List", dailyTodos: [], w: 6, h: 4 }) },
	],
	render: (view, card, body) => renderDaily(view, card, body),
	renderEditor: (container, ctx) => dailyTodoEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.dailyTodos) copy.dailyTodos = source.dailyTodos.map((todo) => ({ ...todo, id: todoId() }));
	},
	liveness: { mode: "static" },
};
