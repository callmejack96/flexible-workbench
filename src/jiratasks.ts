/** Read-only index of TaskNotes tasks associated with Jira issues. Kept apart
 * from both the Jira REST client and task creation to avoid a runtime import
 * cycle between those two entry points. */
import { type App, type TFile } from "obsidian";
import { readTaskNotesTask, readTaskNotesSetup } from "./tasknotes";

const JIRA_KEY_FIELD = "jira_key";

export interface JiraLinkedTaskNote {
	file: TFile;
	title: string;
	done: boolean;
}

/** All Jira → local-task associations in the vault. Read freshly before a
 * Jira completion transition, so checking off a Todo in another tab is never
 * blocked by a stale dashboard render. */
export function linkedTaskNotesByJiraKey(app: App): Map<string, JiraLinkedTaskNote[]> {
	const setup = readTaskNotesSetup(app);
	const out = new Map<string, JiraLinkedTaskNote[]>();
	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		const key = typeof frontmatter?.[JIRA_KEY_FIELD] === "string"
			? frontmatter[JIRA_KEY_FIELD].trim()
			: "";
		if (!key) continue;
		const tags = [
			...(cache?.tags ?? []).map((tag) => tag.tag.replace(/^#/, "")),
			...(Array.isArray(frontmatter?.tags)
				? frontmatter.tags.filter((tag): tag is string => typeof tag === "string")
				: typeof frontmatter?.tags === "string"
					? [frontmatter.tags]
					: []),
		].map((tag) => tag.replace(/^#/, ""));
		const task = readTaskNotesTask(setup, file.path, frontmatter, tags);
		if (!task) continue;
		const linked = out.get(key) ?? [];
		linked.push({ file, title: task.title, done: task.done });
		out.set(key, linked);
	}
	return out;
}
