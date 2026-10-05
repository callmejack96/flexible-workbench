import { MarkdownRenderer, normalizePath, Notice, TFile, TFolder, type Component } from "obsidian";
import { localDayKey } from "./dates";
import { wireMarkdownLinks } from "./cardbodies";
import { t } from "./i18n";
import type { DashboardCard, TimerRecord } from "./types";
import { openFile } from "./opener";
import type { HomeView } from "./view";

export type ReportGranularity = "day" | "week" | "month" | "year";

const REPORT_FOLDER = "Reports/Time";
const REPORT_START = "<!-- flexible-workbench:time-report:start -->";
const REPORT_END = "<!-- flexible-workbench:time-report:end -->";

export interface CompletedTodo {
	todoId: string;
	text: string;
	completedAt: string;
	archivePath?: string;
}

interface ReportBounds {
	start: Date;
	end: Date;
	key: string;
}

interface SessionSlice {
	day: string;
	seconds: number;
	startMs: number;
	endMs: number;
	approximate: boolean;
}

interface ReportSession {
	record: TimerRecord;
	seconds: number;
	slices: SessionSlice[];
}

interface ReportModel {
	granularity: ReportGranularity;
	anchor: Date;
	bounds: ReportBounds;
	todos: CompletedTodo[];
	sessions: ReportSession[];
	totalFocusSeconds: number;
	byBucket: Map<string, { seconds: number; completed: number }>;
}

interface TimeReportsState {
	granularity: ReportGranularity;
	anchor: Date;
	request: number;
}

const states = new WeakMap<DashboardCard, TimeReportsState>();

function validDate(value: unknown): string | null {
	if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const localNoon = new Date(`${value}T12:00:00`);
		return Number.isFinite(localNoon.getTime()) ? localNoon.toISOString() : null;
	}
	const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function frontmatterString(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

function readCompletedTodos(view: HomeView, additional?: CompletedTodo): CompletedTodo[] {
	const todos = new Map<string, CompletedTodo>();
	for (const file of view.app.vault.getMarkdownFiles()) {
		const fm = view.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !("todo_id" in fm)) continue;
		const todoId = frontmatterString(fm.todo_id);
		const completedAt = validDate(fm.completed_at);
		if (!todoId || !completedAt) continue;
		const text = frontmatterString(fm.todo_text) ?? file.basename;
		todos.set(todoId, { todoId, text, completedAt, archivePath: file.path });
	}
	for (const value of view.plugin.settings.todoCompletions ?? []) {
		const todoId = typeof value?.todoId === "string" ? value.todoId : "";
		const completedAt = validDate(value?.completedAt);
		const text = typeof value?.text === "string" ? value.text : "";
		if (!todoId || !completedAt || !text) continue;
		todos.set(todoId, {
			todoId,
			text,
			completedAt,
			...(typeof value.archivePath === "string" ? { archivePath: value.archivePath } : {}),
		});
	}
	if (additional && !todos.has(additional.todoId)) todos.set(additional.todoId, additional);
	return [...todos.values()].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
}

function mondayFor(date: Date): Date {
	const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	const offset = (start.getDay() + 6) % 7;
	start.setDate(start.getDate() - offset);
	return start;
}

function isoWeekKey(date: Date): string {
	const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	const day = thursday.getDay() || 7;
	thursday.setDate(thursday.getDate() + 4 - day);
	const year = thursday.getFullYear();
	const yearStart = new Date(year, 0, 1);
	const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${year}-W${String(week).padStart(2, "0")}`;
}

function boundsFor(granularity: ReportGranularity, anchor: Date): ReportBounds {
	const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
	let end: Date;
	let key: string;
	switch (granularity) {
		case "day":
			end = new Date(start);
			end.setDate(end.getDate() + 1);
			key = localDayKey(start.getTime());
			break;
		case "week":
			start.setTime(mondayFor(start).getTime());
			end = new Date(start);
			end.setDate(end.getDate() + 7);
			key = isoWeekKey(start);
			break;
		case "month":
			start.setDate(1);
			end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
			key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
			break;
		case "year":
			start.setMonth(0, 1);
			end = new Date(start.getFullYear() + 1, 0, 1);
			key = String(start.getFullYear());
			break;
	}
	return { start, end, key };
}

function bucketKey(granularity: ReportGranularity, day: string): string {
	const date = new Date(`${day}T12:00:00`);
	if (granularity === "day") return day;
	if (granularity === "week") return isoWeekKey(date);
	if (granularity === "month") return day.slice(0, 7);
	return day.slice(0, 4);
}

function effectiveSegments(record: TimerRecord): { startMs: number; endMs: number }[] {
	const segments = record.segments ?? [];
	const result: { startMs: number; endMs: number }[] = [];
	for (const segment of segments) {
		const startMs = Date.parse(segment.startedAt);
		const endMs = Date.parse(segment.endedAt ?? record.endedAt ?? "");
		if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) result.push({ startMs, endMs });
	}
	return result;
}

function splitSessionByLocalDay(record: TimerRecord): SessionSlice[] {
	const duration = typeof record.durationSeconds === "number" && Number.isFinite(record.durationSeconds)
		? Math.max(0, record.durationSeconds)
		: 0;
	if (!record.endedAt) return [];
	const exact = effectiveSegments(record);
	if (!exact.length) {
		const started = Date.parse(record.startedAt);
		return Number.isFinite(started) && duration > 0
			? [{ day: localDayKey(started), seconds: duration, startMs: started, endMs: Date.parse(record.endedAt), approximate: true }]
			: [];
	}

	const slices: SessionSlice[] = [];
	for (const segment of exact) {
		let cursor = segment.startMs;
		while (cursor < segment.endMs) {
			const date = new Date(cursor);
			const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
			const endMs = Math.min(midnight, segment.endMs);
			slices.push({
				day: localDayKey(cursor),
				seconds: (endMs - cursor) / 1000,
				startMs: cursor,
				endMs,
				approximate: false,
			});
			cursor = endMs;
		}
	}
	if (record.segmentsHistoryIncomplete) {
		const recordedSeconds = exact.reduce((sum, segment) => sum + (segment.endMs - segment.startMs) / 1000, 0);
		const remainder = Math.max(0, duration - recordedSeconds);
		const started = Date.parse(record.startedAt);
		if (remainder > 0 && Number.isFinite(started)) {
			slices.push({ day: localDayKey(started), seconds: remainder, startMs: started, endMs: started, approximate: true });
		}
	}
	return slices;
}

function buildModel(
	view: HomeView,
	granularity: ReportGranularity,
	anchor: Date,
	additional?: CompletedTodo,
): ReportModel {
	const bounds = boundsFor(granularity, anchor);
	const allTodos = readCompletedTodos(view, additional);
	const todos = allTodos.filter((todo) => {
		const timestamp = Date.parse(todo.completedAt);
		return timestamp >= bounds.start.getTime() && timestamp < bounds.end.getTime();
	});
	const sessions: ReportSession[] = [];
	const byBucket = new Map<string, { seconds: number; completed: number }>();
	for (const todo of todos) {
		const day = localDayKey(Date.parse(todo.completedAt));
		const bucket = bucketKey(granularity, day);
		const cell = byBucket.get(bucket) ?? { seconds: 0, completed: 0 };
		cell.completed++;
		byBucket.set(bucket, cell);
	}
	for (const record of view.plugin.settings.timerRecords ?? []) {
		if (!record.endedAt) continue;
		const slices = splitSessionByLocalDay(record).filter((slice) => {
			const noon = new Date(`${slice.day}T12:00:00`).getTime();
			return noon >= bounds.start.getTime() && noon < bounds.end.getTime();
		});
		if (!slices.length) continue;
		sessions.push({ record, seconds: slices.reduce((sum, slice) => sum + slice.seconds, 0), slices });
		for (const slice of slices) {
			const bucket = bucketKey(granularity, slice.day);
			const cell = byBucket.get(bucket) ?? { seconds: 0, completed: 0 };
			cell.seconds += slice.seconds;
			byBucket.set(bucket, cell);
		}
	}
	sessions.sort((a, b) => Math.min(...a.slices.map((slice) => slice.startMs)) - Math.min(...b.slices.map((slice) => slice.startMs)));
	const totalFocusSeconds = sessions.reduce((sum, session) => sum + session.seconds, 0);
	return { granularity, anchor, bounds, todos, sessions, totalFocusSeconds, byBucket };
}

function dateLabel(date: Date): string {
	return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDuration(seconds: number): string {
	const totalSeconds = Math.floor(Math.max(0, seconds));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (!hours) return `${minutes}m`;
	return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function escapeMarkdown(value: string): string {
	return value.replace(/[|\r\n]+/g, " ").replace(/\\/g, "\\\\");
}

function timeLabel(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function titleForPeriod(model: ReportModel): string {
	const strings = t().cards.timeReports;
	if (model.granularity === "day") return `${strings.periods.day} · ${model.bounds.key}`;
	if (model.granularity === "week") return `${strings.periods.week} · ${model.bounds.key}`;
	if (model.granularity === "month") return `${strings.periods.month} · ${model.bounds.key}`;
	return `${strings.periods.year} · ${model.bounds.key}`;
}

function reportMarkdown(model: ReportModel): string {
	const strings = t().cards.timeReports;
	const lines = [
		`# ${titleForPeriod(model)}`,
		"",
		`> ${strings.completedCount(model.todos.length)} · ${strings.totalFocus(formatDuration(model.totalFocusSeconds))} · ${strings.sessionCount(model.sessions.length)}`,
		"",
	];
	if (model.granularity === "day") {
		lines.push(`## ${strings.timeline}`, "");
		const events: { at: number; text: string }[] = [];
		for (const session of model.sessions) {
			const slices = session.slices;
			const selectedDay = model.bounds.key;
			const daySlices = slices.filter((slice) => slice.day === selectedDay);
			if (!daySlices.length) continue;
			const spans = daySlices
				.filter((slice) => slice.endMs > slice.startMs)
				.map((slice) => `${timeLabel(slice.startMs)}–${timeLabel(slice.endMs)}`);
			const task = session.record.todoText
				? ` · ${escapeMarkdown(session.record.todoText)}${session.record.description && session.record.description !== session.record.todoText ? ` / ${escapeMarkdown(session.record.description)}` : ""}`
				: ` · ${escapeMarkdown(session.record.description || strings.standaloneTimer)}`;
			const approx = daySlices.some((slice) => slice.approximate) ? ` (${strings.estimated})` : "";
			const summary = session.record.summary?.trim() ? ` — ${escapeMarkdown(session.record.summary.trim())}` : "";
			const range = spans.length ? `${spans.join(", ")} · ` : "";
			events.push({
				at: Math.min(...daySlices.map((slice) => slice.startMs)),
				text: `- **${range}${formatDuration(daySlices.reduce((sum, slice) => sum + slice.seconds, 0))}**${task}${approx}${summary}`,
			});
		}
		for (const todo of model.todos) {
			const timestamp = Date.parse(todo.completedAt);
			events.push({ at: timestamp, text: `- **${timeLabel(timestamp)}** · ${strings.todoCompleted(escapeMarkdown(todo.text))}` });
		}
		events.sort((a, b) => a.at - b.at);
		if (events.length) lines.push(...events.map((event) => event.text), "");
		else lines.push(`_${strings.emptyTimeline}_`, "");
		lines.push(`## ${strings.completedTasks}`, "");
		if (model.todos.length) {
			for (const todo of model.todos) {
				const time = timeLabel(Date.parse(todo.completedAt));
				lines.push(`- ${escapeMarkdown(todo.text)} — ${time}`);
			}
		} else {
			lines.push(`_${strings.noCompletedTasks}_`);
		}
	} else {
		const heading = model.granularity === "week" ? strings.byDay : model.granularity === "month" ? strings.byWeek : strings.byMonth;
		lines.push(
			`## ${heading}`,
			"",
			`| ${strings.periodColumn} | ${strings.totalFocusLabel} | ${strings.completedLabel} |`,
			"| --- | ---: | ---: |",
			"",
		);
		for (const [key, values] of [...model.byBucket.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			lines.push(`| ${key} | ${formatDuration(values.seconds)} | ${values.completed} |`);
		}
		if (!model.byBucket.size) lines.push(`| ${strings.noActivity} | ${formatDuration(0)} | 0 |`);
		lines.push("");
		lines.push(`## ${strings.completedTasks}`, "");
		if (model.todos.length) {
			for (const todo of model.todos) lines.push(`- ${dateLabel(new Date(todo.completedAt))} · ${escapeMarkdown(todo.text)}`);
		} else {
			lines.push(`_${strings.noCompletedTasks}_`);
		}
	}
	return lines.join("\n").trimEnd();
}

function periodPath(granularity: ReportGranularity, anchor: Date): string {
	const key = boundsFor(granularity, anchor).key;
	const folder = granularity === "day" ? "Daily" : granularity === "week" ? "Weekly" : granularity === "month" ? "Monthly" : "Yearly";
	return normalizePath(`${REPORT_FOLDER}/${folder}/${key}.md`);
}

async function ensureReportFolder(view: HomeView, folder: string): Promise<void> {
	let current = "";
	for (const part of normalizePath(folder).split("/").filter(Boolean)) {
		current = current ? `${current}/${part}` : part;
		const existing = view.app.vault.getAbstractFileByPath(current);
		if (!existing) {
			try {
				await view.app.vault.createFolder(current);
			} catch (error) {
				if (!view.app.vault.getAbstractFileByPath(current)) throw error;
			}
		} else if (!(existing instanceof TFolder)) {
			throw new Error(`A file already exists at ${current}`);
		}
	}
}

function mergeReportBlock(existing: string, generated: string): string {
	const start = existing.indexOf(REPORT_START);
	const end = existing.indexOf(REPORT_END);
	const block = `${REPORT_START}\n${generated}\n${REPORT_END}`;
	if (start >= 0 && end > start) {
		return `${existing.slice(0, start)}${block}${existing.slice(end + REPORT_END.length)}`;
	}
	return existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

function hasReportData(model: ReportModel): boolean {
	return model.todos.length > 0 || model.sessions.length > 0;
}

export async function writeTimeReport(
	view: HomeView,
	granularity: ReportGranularity,
	anchor: Date,
	additional?: CompletedTodo,
): Promise<TFile | null> {
	const model = buildModel(view, granularity, anchor, additional);
	if (!hasReportData(model)) return null;
	const path = periodPath(granularity, anchor);
	const pathParts = path.split("/");
	await ensureReportFolder(view, `${REPORT_FOLDER}/${pathParts[pathParts.length - 2]}`);
	const existing = view.app.vault.getAbstractFileByPath(path);
	const previous = existing instanceof TFile ? await view.app.vault.read(existing) : "";
	const content = mergeReportBlock(previous, reportMarkdown(model));
	if (existing instanceof TFile) await view.app.vault.modify(existing, content);
	else await view.app.vault.create(path, content);
	const created = view.app.vault.getAbstractFileByPath(path);
	return created instanceof TFile ? created : null;
}

function touchedDaysForTodo(view: HomeView, todo: CompletedTodo): string[] {
	const days = new Set([localDayKey(Date.parse(todo.completedAt))]);
	for (const record of view.plugin.settings.timerRecords ?? []) {
		if (record.todoId !== todo.todoId || !record.endedAt) continue;
		for (const slice of splitSessionByLocalDay(record)) days.add(slice.day);
	}
	return [...days];
}

export async function refreshTodoTimeReports(view: HomeView, todo: CompletedTodo): Promise<void> {
	const periods = new Map<string, { granularity: ReportGranularity; anchor: Date }>();
	for (const day of touchedDaysForTodo(view, todo)) {
		const anchor = new Date(`${day}T12:00:00`);
		for (const granularity of ["day", "week", "month", "year"] as const) {
			const key = `${granularity}:${boundsFor(granularity, anchor).key}`;
			periods.set(key, { granularity, anchor });
		}
	}
	for (const period of periods.values()) await writeTimeReport(view, period.granularity, period.anchor, todo);
}

export async function refreshTimerTimeReports(view: HomeView, record: TimerRecord): Promise<void> {
	if (!record.endedAt) return;
	const periods = new Map<string, { granularity: ReportGranularity; anchor: Date }>();
	for (const slice of splitSessionByLocalDay(record)) {
		const anchor = new Date(`${slice.day}T12:00:00`);
		for (const granularity of ["day", "week", "month", "year"] as const) {
			periods.set(`${granularity}:${boundsFor(granularity, anchor).key}`, { granularity, anchor });
		}
	}
	for (const period of periods.values()) await writeTimeReport(view, period.granularity, period.anchor);
}

function periodLabel(granularity: ReportGranularity, anchor: Date): string {
	const bounds = boundsFor(granularity, anchor);
	if (granularity === "day") return dateLabel(bounds.start);
	if (granularity === "week") {
		const lastDay = new Date(bounds.end);
		lastDay.setDate(lastDay.getDate() - 1);
		return `${dateLabel(bounds.start)} – ${dateLabel(lastDay)}`;
	}
	if (granularity === "month") return bounds.start.toLocaleDateString(undefined, { year: "numeric", month: "long" });
	return String(bounds.start.getFullYear());
}

function shiftPeriod(date: Date, granularity: ReportGranularity, amount: number): Date {
	const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	if (granularity === "day") next.setDate(next.getDate() + amount);
	else if (granularity === "week") next.setDate(next.getDate() + amount * 7);
	else if (granularity === "month") {
		next.setDate(1);
		next.setMonth(next.getMonth() + amount);
	} else {
		next.setMonth(0, 1);
		next.setFullYear(next.getFullYear() + amount);
	}
	return next;
}

export function renderTimeReports(view: HomeView, card: DashboardCard, body: HTMLElement, component: Component): void {
	let state = states.get(card);
	if (!state) {
		state = { granularity: "day", anchor: new Date(), request: 0 };
		states.set(card, state);
	}
	const request = ++state.request;
	body.empty();
	const wrap = body.createDiv("flexible-workbench-time-reports");
	const strings = t().cards.timeReports;
	const controls = wrap.createDiv("flexible-workbench-time-reports-controls");
	const tabs = controls.createDiv("flexible-workbench-time-reports-tabs");
	for (const granularity of ["day", "week", "month", "year"] as const) {
		const button = tabs.createEl("button", { text: strings.periods[granularity], attr: { type: "button" } });
		button.toggleClass("is-active", state.granularity === granularity);
		button.addEventListener("click", () => {
			state.granularity = granularity;
			void renderTimeReports(view, card, body, component);
		});
	}
	const navigation = controls.createDiv("flexible-workbench-time-reports-navigation");
	const previous = navigation.createEl("button", { text: "‹", attr: { type: "button", "aria-label": strings.previous } });
	previous.addEventListener("click", () => {
		state.anchor = shiftPeriod(state.anchor, state.granularity, -1);
		void renderTimeReports(view, card, body, component);
	});
	navigation.createSpan({ cls: "flexible-workbench-time-reports-period", text: periodLabel(state.granularity, state.anchor) });
	const next = navigation.createEl("button", { text: "›", attr: { type: "button", "aria-label": strings.next } });
	next.addEventListener("click", () => {
		state.anchor = shiftPeriod(state.anchor, state.granularity, 1);
		void renderTimeReports(view, card, body, component);
	});

	const report = buildModel(view, state.granularity, state.anchor);
	const open = controls.createEl("button", { text: strings.openReport, attr: { type: "button" } });
	open.addEventListener("click", () => {
		void writeTimeReport(view, state.granularity, state.anchor).then((file) => {
			if (file) void openFile(view, file, "card");
			else new Notice(strings.noReportToOpen);
		}).catch((error) => new Notice(strings.reportSaveFailed(String(error))));
	});
	const preview = wrap.createDiv("flexible-workbench-time-reports-preview markdown-rendered");
	if (!hasReportData(report)) {
		preview.createDiv({ cls: "flexible-workbench-time-reports-empty", text: strings.emptyReport });
		return;
	}
	wireMarkdownLinks(view, preview, "");
	void MarkdownRenderer.render(view.app, reportMarkdown(report), preview, "", component).catch((error: unknown) => {
		if (request === state.request) preview.setText(strings.reportRenderFailed(String(error)));
	});
}
