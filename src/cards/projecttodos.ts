import { setIcon, TFile } from "obsidian";
import { openFile } from "../opener";
import { readTaskNotesTask, readTaskNotesSetup } from "../tasknotes";
import type { CardDefinition } from "./definition";

export const projectTodosCard: CardDefinition<"projecttodos"> = {
	kind: "projecttodos",
	templates: [{ id: "projecttodos", name: "Project Todos", icon: "folders", build: () => ({ kind: "projecttodos", title: "Project Todos", w: 12, h: 3 }) }],
	render(view, _card, body) {
		const groups = new Map<string, { file: TFile; title: string; done: boolean }[]>();
		const setup = readTaskNotesSetup(view.app);
		for (const file of view.app.vault.getMarkdownFiles()) {
			const cache = view.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (fm?.todo_scope !== "project" || typeof fm.todo_project !== "string") continue;
			const task = readTaskNotesTask(setup, file.path, fm, (cache?.tags ?? []).map((tag) => tag.tag.replace(/^#/, "")));
			if (!task) continue;
			const group = groups.get(fm.todo_project) ?? [];
			group.push({ file, title: task.title, done: task.done });
			groups.set(fm.todo_project, group);
		}
		const wrap = body.createDiv("flexible-workbench-projecttodos");
		for (const [project, todos] of groups) {
			const done = todos.filter((todo) => todo.done).length;
			const group = wrap.createDiv("flexible-workbench-projecttodo-group");
			group.createSpan({ cls: "flexible-workbench-projecttodo-name", text: project });
			group.createSpan({ cls: "flexible-workbench-projecttodo-progress", text: `${done}/${todos.length} done · ${todos.length - done} open` });
			for (const todo of todos) {
				const link = group.createEl("button", { cls: "flexible-workbench-projecttodo-link", text: todo.title });
				link.toggleClass("is-done", todo.done);
				setIcon(link.createSpan(), todo.done ? "circle-check" : "circle");
				link.addEventListener("click", () => void openFile(view, todo.file, "card"));
			}
		}
	},
	liveness: { mode: "vault" },
};
