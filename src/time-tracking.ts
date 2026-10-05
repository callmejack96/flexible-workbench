import { Notice, setIcon, type Component } from "obsidian";
import { localDayKey } from "./dates";
import { t } from "./i18n";
import { refreshTimerTimeReports } from "./todo-reports";
import type { HomeSettings, TimerRecord } from "./types";
import { promptForText } from "./ui";
import type { HomeView } from "./view";

type TimerSettings = Pick<HomeSettings, "timerRecords">;

export function getTimerRecords(settings: TimerSettings): TimerRecord[] {
	return Array.isArray(settings.timerRecords) ? settings.timerRecords : [];
}

export function getActiveTimer(settings: TimerSettings): TimerRecord | undefined {
	return getTimerRecords(settings).find((record) =>
		record.timerSource === "workbench" && !record.endedAt && !record.pendingStopOnly,
	);
}

export function sortTimerRecords(records: TimerRecord[]): TimerRecord[] {
	return [...records]
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
		.slice(0, 1000);
}

export function createTimerRecord(
	description: string,
	options: { todoId?: string; todoText?: string } = {},
	startedAt = new Date().toISOString(),
): TimerRecord {
	return {
		id: activeWindow.crypto?.randomUUID?.() ?? `timer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		description,
		startedAt,
		timerSource: "workbench",
		segments: [{ startedAt }],
		...(options.todoId ? { todoId: options.todoId } : {}),
		...(options.todoText ? { todoText: options.todoText } : {}),
	};
}

export function formatTimerElapsed(seconds: number): string {
	const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	return `${hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}` : minutes}:${String(secs).padStart(2, "0")}`;
}

function elapsedSince(startedAt: string, now = Date.now()): number {
	const started = Date.parse(startedAt);
	return Number.isFinite(started) ? Math.max(0, (now - started) / 1000) : 0;
}

/** Active work time, excluding every paused interval. Older records without
 * segment fields continue counting from their original start timestamp. */
export function timerElapsedSeconds(record: TimerRecord, now = Date.now()): number {
	const accumulated = Number.isFinite(record.pausedDurationSeconds)
		? Math.max(0, record.pausedDurationSeconds ?? 0)
		: 0;
	if (record.pausedAt) {
		return Number.isFinite(record.pausedDurationSeconds)
			? accumulated
			: elapsedSince(record.activeSince ?? record.startedAt, Date.parse(record.pausedAt));
	}
	return accumulated + elapsedSince(record.activeSince ?? record.startedAt, now);
}

/** Render Flexible Workbench's own timer. The clock derives from a persisted
 * start timestamp, so it continues accurately through redraws and restarts. */
export function renderTimeTracker(view: HomeView, body: HTMLElement, component: Component): void {
	const strings = t().cards.timer;
	const records = (): TimerRecord[] => getTimerRecords(view.plugin.settings);
	const saveRecords = async (next: TimerRecord[]): Promise<boolean> => {
		const previous = records();
		view.plugin.settings.timerRecords = sortTimerRecords(next);
		try {
			await view.plugin.saveData(view.plugin.settings);
			return true;
		} catch (error) {
			view.plugin.settings.timerRecords = previous;
			new Notice(strings.timerSaveFailed(String(error)));
			return false;
		}
	};
	const history = (): void => {
		const saved = records()
			.filter((entry) => typeof entry.description === "string" && Number.isFinite(Date.parse(entry.startedAt)))
			.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
		const list = body.createDiv("flexible-workbench-timer-history");
		list.createDiv({ cls: "flexible-workbench-timer-history-heading", text: strings.timerHistory });
		if (saved.length === 0) {
			list.createDiv({ cls: "flexible-workbench-timer-history-empty", text: strings.timerHistoryEmpty });
			return;
		}
		const today = localDayKey(Date.now());
		const yesterday = localDayKey(Date.now() - 24 * 60 * 60 * 1000);
		const groups = new Map<string, TimerRecord[]>();
		for (const entry of saved) {
			const day = localDayKey(Date.parse(entry.startedAt));
			const group = groups.get(day) ?? [];
			group.push(entry);
			groups.set(day, group);
		}
		for (const [day, entries] of groups) {
			const dayLabel = day === today
				? strings.timerToday
				: day === yesterday
					? strings.timerYesterday
					: new Date(`${day}T12:00:00`).toLocaleDateString();
			list.createDiv({ cls: "flexible-workbench-timer-day", text: dayLabel });
			for (const entry of entries) {
				const running = entry.timerSource === "workbench" && !entry.endedAt && !entry.pendingStopOnly;
				const paused = running && Boolean(entry.pausedAt);
				const row = list.createDiv("flexible-workbench-timer-entry");
				row.createDiv({ cls: "flexible-workbench-timer-entry-description", text: entry.description });
				const startTime = new Date(entry.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
				const endTime = entry.endedAt
					? new Date(entry.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
					: paused ? strings.timerPaused : running ? strings.timerRunning : strings.timerIncomplete;
				const elapsed = typeof entry.durationSeconds === "number"
					? formatTimerElapsed(entry.durationSeconds)
					: running ? formatTimerElapsed(timerElapsedSeconds(entry)) : "";
				row.createDiv({
					cls: "flexible-workbench-timer-entry-time",
					text: [startTime && `${startTime} – ${endTime}`, elapsed].filter(Boolean).join(" · "),
				});
				row.createDiv({
					cls: `flexible-workbench-timer-entry-summary${entry.summary || entry.pendingSummary ? "" : " is-empty"}`,
					text: entry.summary || entry.pendingSummary || strings.timerNoSummary,
				});
				if (entry.todoText) {
					row.createDiv({ cls: "flexible-workbench-timer-entry-todo", text: strings.timerTodo(entry.todoText) });
				}
				const actions = row.createDiv("flexible-workbench-timer-entry-actions");
				const addEditButton = (label: string, field: "description" | "summary"): void => {
					const button = actions.createEl("button", {
						text: label,
						attr: { type: "button", "aria-label": `${label}: ${entry.description}`, title: label },
					});
					button.addEventListener("click", (event) => {
						event.stopPropagation();
						void editRecordField(entry, field);
					});
				};
				addEditButton(strings.timerEditDescription, "description");
				addEditButton(strings.timerEditSummary, "summary");
			}
		}
	};

	const panel = body.createDiv("flexible-workbench-timer");
	let busy = false;
	let prompting = false;
	const actionButtons: HTMLButtonElement[] = [];
	const setBusy = (value: boolean, label?: string): void => {
		busy = value;
		for (const button of actionButtons) {
			button.disabled = value;
			if (label) button.setText(label);
		}
	};
	const appendAction = (label: string, callback: () => void, cta = false): HTMLButtonElement => {
		const button = panel.createEl("button", { text: label, cls: "flexible-workbench-timer-action" });
		if (cta) button.addClass("mod-cta");
		button.addEventListener("click", callback);
		actionButtons.push(button);
		return button;
	};

	const editRecordField = async (record: TimerRecord, field: "description" | "summary"): Promise<void> => {
		if (busy || prompting) return;
		const isDescription = field === "description";
		prompting = true;
		const value = await promptForText(view.app, {
			title: isDescription ? strings.timerEditDescriptionTitle : strings.timerEditSummaryTitle,
			label: isDescription ? strings.timerDescriptionLabel : strings.timerSummaryLabel,
			placeholder: isDescription ? strings.timerDescriptionPlaceholder : strings.timerSummaryPlaceholder,
			initial: isDescription ? record.description : record.summary || record.pendingSummary || "",
			multiline: !isDescription,
		});
		prompting = false;
		if (value === null) return;
		const cleanValue = value.trim();
		if (isDescription && !cleanValue) {
			new Notice(strings.timerDescriptionRequired);
			return;
		}
		const currentRecords = records();
		const current = currentRecords.find((entry) => entry.id === record.id);
		if (!current) {
			new Notice(strings.timerChangedWhilePrompting);
			view.render();
			return;
		}
		const updated: TimerRecord = isDescription
			? { ...current, description: cleanValue }
			: { ...current, summary: cleanValue || undefined, pendingSummary: undefined };
		const next = currentRecords.map((entry) => entry.id === current.id ? updated : entry);
		if (await saveRecords(next)) {
			if (updated.endedAt) {
				try {
					await refreshTimerTimeReports(view, updated);
				} catch (error) {
					new Notice(t().cards.timeReports.reportSaveFailed(String(error)));
				}
			}
			view.render();
		}
	};

	const startTimer = async (): Promise<void> => {
		if (busy || prompting) return;
		if (getActiveTimer(view.plugin.settings)) {
			new Notice(strings.timerAlreadyRunning);
			return;
		}
		prompting = true;
		const description = await promptForText(view.app, {
			title: strings.timerStartTitle,
			label: strings.timerDescriptionLabel,
			placeholder: strings.timerDescriptionPlaceholder,
		});
		prompting = false;
		if (description === null) return;
		const cleanDescription = description.trim();
		if (!cleanDescription) {
			new Notice(strings.timerDescriptionRequired);
			return;
		}
		if (getActiveTimer(view.plugin.settings)) {
			new Notice(strings.timerAlreadyRunning);
			view.render();
			return;
		}
		setBusy(true, strings.timerStarting);
		try {
			const entry = createTimerRecord(cleanDescription);
			if (await saveRecords([entry, ...records()])) view.render();
		} finally {
			setBusy(false);
		}
	};

	const stopTimer = async (record: TimerRecord): Promise<void> => {
		if (busy || prompting) return;
		prompting = true;
		const summary = await promptForText(view.app, {
			title: strings.timerStopTitle,
			label: strings.timerSummaryLabel,
			placeholder: strings.timerSummaryPlaceholder,
			initial: record.summary || record.pendingSummary,
			multiline: true,
		});
		prompting = false;
		if (summary === null) return;
		const cleanSummary = summary.trim();
		if (!cleanSummary) {
			new Notice(strings.timerSummaryRequired);
			return;
		}
		const current = getActiveTimer(view.plugin.settings);
		if (!current || current.id !== record.id) {
			new Notice(strings.timerChangedWhilePrompting);
			view.render();
			return;
		}
		setBusy(true, strings.timerStopping);
		try {
			const pending = { ...current, pendingSummary: cleanSummary };
			const pendingRecords = records().map((entry) => entry.id === current.id ? pending : entry);
			if (!(await saveRecords(pendingRecords))) return;
			const endedMs = Date.now();
			const completed: TimerRecord = {
				...pending,
				endedAt: new Date(endedMs).toISOString(),
				durationSeconds: timerElapsedSeconds(current, endedMs),
				segments: closeOpenSegment(current, new Date(endedMs).toISOString()),
				segmentsHistoryIncomplete: current.segmentsHistoryIncomplete ?? !current.segments,
				summary: cleanSummary,
				pendingSummary: undefined,
				activeSince: undefined,
				pausedAt: undefined,
			};
			const completedRecords = records().map((entry) => entry.id === current.id ? completed : entry);
			if (await saveRecords(completedRecords)) {
				try {
					await refreshTimerTimeReports(view, completed);
				} catch (error) {
					new Notice(t().cards.timeReports.reportSaveFailed(String(error)));
				}
				view.render();
			}
		} finally {
			setBusy(false);
		}
	};

	const togglePause = async (record: TimerRecord): Promise<void> => {
		if (busy || prompting) return;
		const current = getActiveTimer(view.plugin.settings);
		if (!current || current.id !== record.id) {
			new Notice(strings.timerChangedWhilePrompting);
			view.render();
			return;
		}
		setBusy(true);
		try {
			const now = Date.now();
			const timestamp = new Date(now).toISOString();
			const updated: TimerRecord = current.pausedAt
				? {
					...current,
					activeSince: timestamp,
					pausedAt: undefined,
					segments: [...(current.segments ?? []), { startedAt: timestamp }],
				}
				: {
					...current,
					activeSince: undefined,
					pausedAt: timestamp,
					pausedDurationSeconds: timerElapsedSeconds(current, now),
					segments: closeOpenSegment(current, timestamp),
					segmentsHistoryIncomplete: current.segmentsHistoryIncomplete ?? !current.segments,
				};
			const next = records().map((entry) => entry.id === current.id ? updated : entry);
			if (await saveRecords(next)) view.render();
		} finally {
			setBusy(false);
		}
	};

	const active = getActiveTimer(view.plugin.settings);
	if (!active) {
		const idle = panel.createDiv("flexible-workbench-timer-idle");
		setIcon(idle.createDiv("flexible-workbench-timer-icon"), "timer-off");
		idle.createDiv({ cls: "flexible-workbench-timer-label", text: strings.timerIdle });
		const start = panel.createEl("button", { text: strings.timerStart, cls: "flexible-workbench-timer-action mod-cta" });
		start.addEventListener("click", () => void startTimer());
		actionButtons.push(start);
	} else {
		setIcon(panel.createDiv(`flexible-workbench-timer-icon${active.pausedAt ? " is-paused" : " is-running"}`), active.pausedAt ? "pause" : "timer");
		const clock = panel.createDiv({
			cls: "flexible-workbench-timer-clock",
			text: formatTimerElapsed(timerElapsedSeconds(active)),
		});
		panel.createDiv({ cls: "flexible-workbench-timer-label", text: active.description });
		if (active.todoText) panel.createDiv({ cls: "flexible-workbench-timer-note", text: strings.timerTodo(active.todoText) });
		if (active.pausedAt) {
			panel.createDiv({ cls: "flexible-workbench-timer-note", text: strings.timerPaused });
		} else {
			component.registerInterval(window.setInterval(() => {
				clock.setText(formatTimerElapsed(timerElapsedSeconds(active)));
			}, 1000));
		}
		appendAction(active.pausedAt ? strings.timerResume : strings.timerPause, () => void togglePause(active));
		appendAction(strings.timerStop, () => void stopTimer(active), true);
	}
	const actions = panel.createDiv("flexible-workbench-timer-actions");
	// Move controls into a stable row without rebuilding the history below them.
	for (const button of actionButtons) actions.appendChild(button);
	history();
}

function closeOpenSegment(record: TimerRecord, endedAt: string): NonNullable<TimerRecord["segments"]> {
	const segments = [...(record.segments ?? [{ startedAt: record.activeSince ?? record.startedAt }])];
	const last = segments[segments.length - 1];
	if (last && !last.endedAt) segments[segments.length - 1] = { ...last, endedAt };
	return segments;
}
