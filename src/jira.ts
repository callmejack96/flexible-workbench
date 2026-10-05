import {
	type App,
	type Component,
	Modal,
	Notice,
	requestUrl,
	type RequestUrlParam,
	setIcon,
	Setting,
} from "obsidian";
import type { HomeView } from "./view";
import {
	type DashboardCard,
	effectiveAutoRefreshMinutes,
	type JiraConfig,
	type JiraControl,
	type JiraSelections,
} from "./types";
import { t } from "./i18n";
import { linkedTaskNotesByJiraKey } from "./jiratasks";
import { openFile } from "./opener";

export const JIRA_CONTROLS: JiraControl[] = [
	"status",
	"assignee",
	"startDate",
	"dueDate",
	"priority",
	"issueType",
	"fixVersion",
];

export const JIRA_DATE_OPTION_THIS_WEEK = "thisWeek";

/** Add new date filters to cards saved before those controls existed. */
export function effectiveJiraControls(config: JiraConfig): JiraControl[] {
	const configured = config.controls ?? JIRA_CONTROLS;
	if (config.dateControlsConfigured) return [...configured];
	const enabled = new Set<JiraControl>([...configured, "startDate", "dueDate"]);
	return JIRA_CONTROLS.filter((control) => enabled.has(control));
}

export const JIRA_ASSIGNED_TO_ME_JQL =
	"assignee = currentUser() ORDER BY duedate ASC, updated DESC";
export const JIRA_ASSIGNED_TEAM_JQL =
	'(assignee = currentUser() OR assignee = "zenan.wu@npt.sg") ORDER BY duedate DESC, updated DESC';

/** The picker behind Dashboard → New task. Restricting it to the current
 * user's unfinished sub-tasks keeps a potentially huge Jira project list
 * useful as a one-click association control. */
export const JIRA_MY_OPEN_SUBTASKS_JQL =
	"assignee = currentUser() AND issuetype in subTaskIssueTypes() AND statusCategory != Done " +
	"ORDER BY duedate ASC, priority DESC, updated DESC";

/** Upgrade the original Assigned-to-me preset without changing custom JQL. */
export function upgradeAssignedJiraJql(jql: string): string {
	const trimmed = jql.trim();
	const previousTeamJql =
		'(assignee = currentUser() OR assignee = "zenan.wu@npt.sg") ORDER BY duedate ASC, updated DESC';
	return trimmed === JIRA_ASSIGNED_TO_ME_JQL || trimmed === previousTeamJql
		? JIRA_ASSIGNED_TEAM_JQL
		: jql;
}

const JIRA_BASE_FIELDS = [
	"summary",
	"status",
	"priority",
	"issuetype",
	"assignee",
	"fixVersions",
	"components",
	"duedate",
];

export interface JiraFilter {
	id: string;
	name: string;
}

interface JiraNamedValue {
	id?: string;
	name: string;
}

export interface JiraIssue {
	key: string;
	fields: {
		summary: string;
		status: {
			name: string;
			statusCategory?: { key?: string };
		};
		priority?: JiraNamedValue | null;
		issuetype: JiraNamedValue;
		assignee?: { displayName?: string; name?: string } | null;
		duedate?: string | null;
		fixVersions?: JiraNamedValue[];
		components?: JiraNamedValue[];
		[field: string]: unknown;
	};
}

export type JiraOptions = Record<JiraControl, string[]>;

export interface JiraField {
	id?: string;
	name?: string;
	schema?: { custom?: string };
}

export type JiraSubtaskCategory = "spec" | "cr" | "test";
export type JiraSubtaskType = "feature" | "tech" | "testing" | "others";

export const JIRA_SUBTASK_TYPES = [
	{ value: "feature", label: "Feature", id: "37003" },
	{ value: "tech", label: "Tech", id: "37004" },
	{ value: "testing", label: "Testing techniques", id: "37005" },
	{ value: "others", label: "Others", id: "37006" },
] as const;

export const JIRA_SUBTASK_ASSIGNEES = [
	"shengjie.lin@npt.sg",
	"zenan.wu@npt.sg",
] as const;

export interface JiraSubtaskDraft {
	category: JiraSubtaskCategory;
	subtaskType: JiraSubtaskType;
	summary: string;
	assignee: string;
	startDate: string;
	dueDate: string;
	storyPoints: number;
}

export interface JiraCapacityConflict {
	date: string;
	existing: number;
	requested: number;
	total: number;
}

export interface JiraCapacityShortage {
	date: string;
	missing: number;
}

export interface JiraAssigneeWeeklySchedule {
	assignee: string;
	shortages: JiraCapacityShortage[];
}

interface JiraSearchResponse {
	issues?: JiraIssue[];
}

interface JiraCreateIssueResponse {
	key?: string;
}

interface JiraCreateMetaResponse {
	projects?: {
		issuetypes?: { fields?: Record<string, unknown> }[];
	}[];
}

export interface JiraTransition {
	id?: string;
	name?: string;
	to?: {
		name?: string;
		statusCategory?: { key?: string };
	};
}

interface JiraTransitionsResponse {
	transitions?: JiraTransition[];
}

class JiraPartialSubtaskError extends Error {
	constructor(
		readonly issueKey: string,
		readonly detail: string,
	) {
		super("partial-subtask");
	}
}

interface JiraFilterResponse {
	id?: string | number;
	name?: string;
	jql?: string;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

const jiraCache = new WeakMap<JiraConfig, Map<string, CacheEntry<unknown>>>();

export interface JiraLoadCoordinator<T> {
	request(value: T): void;
	destroy(): void;
	idle(): Promise<void>;
}

/** Serialize loads while retaining the latest request that arrives in flight. */
export function createJiraLoadCoordinator<T>(
	execute: (value: T) => Promise<void>,
): JiraLoadCoordinator<T> {
	let active = false;
	let destroyed = false;
	let pending: T | undefined;
	let idlePromise = Promise.resolve();

	const drain = async (initial: T): Promise<void> => {
		try {
			let next: T | undefined = initial;
			while (next !== undefined && !destroyed) {
				await execute(next);
				if (destroyed) break;
				next = pending;
				pending = undefined;
			}
		} finally {
			active = false;
		}
	};

	return {
		request(value: T): void {
			if (destroyed) return;
			if (active) {
				pending = value;
				return;
			}
			pending = undefined;
			active = true;
			idlePromise = drain(value);
		},
		destroy(): void {
			destroyed = true;
			pending = undefined;
		},
		idle(): Promise<void> {
			return idlePromise;
		},
	};
}

/** Escape a string for use inside a quoted JQL string literal. */
export function escapeJqlString(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n");
}

/** Convert Jira REST custom-field ids to their supported JQL reference form. */
export function jiraJqlFieldReference(fieldId: string | null, fallbackName: string): string {
	const match = /^customfield_(\d+)$/i.exec(fieldId ?? "");
	if (match?.[1]) return `cf[${match[1]}]`;
	if (fieldId && /^[a-z][a-z0-9_]*$/i.test(fieldId)) return fieldId;
	return `"${escapeJqlString(fallbackName)}"`;
}

function splitOrderBy(jql: string): { query: string; order: string } {
	const trimmed = jql.trim();
	if (/^ORDER\s+BY\s+/i.test(trimmed)) return { query: "", order: trimmed };
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < jql.length; index++) {
		const char = jql[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quoted) {
			escaped = true;
			continue;
		}
		if (char === '"') {
			quoted = !quoted;
			continue;
		}
		if (quoted || !/\s/.test(char)) continue;
		const tail = jql.slice(index);
		const match = /^\s+ORDER\s+BY\s+/i.exec(tail);
		if (!match) continue;
		return {
			query: jql.slice(0, index).trim(),
			order: jql.slice(index).trim(),
		};
	}
	return { query: trimmed, order: "" };
}

/** Replace any existing query sort with Due date descending. */
export function orderJiraByDueDateDesc(jql: string): string {
	const { query } = splitOrderBy(jql);
	return [query, "ORDER BY duedate DESC, updated DESC"].filter(Boolean).join(" ");
}

/** Compose persisted multi-select refinements without allowing JQL injection. */
export function composeJiraJql(
	baseJql: string,
	selections: JiraSelections,
	startDateFieldId: string | null = null,
): string {
	const { query, order } = splitOrderBy(baseJql);
	const fieldByControl: Record<JiraControl, string> = {
		status: "status",
		assignee: "assignee",
		startDate: "",
		dueDate: "",
		priority: "priority",
		issueType: "issuetype",
		fixVersion: "fixVersion",
	};
	const clauses: string[] = query ? [`(${query})`] : [];
	for (const control of JIRA_CONTROLS) {
		const values = selections[control]?.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		if (!values?.length) continue;
		if (control === "startDate") {
			if (values.includes(JIRA_DATE_OPTION_THIS_WEEK)) {
				const field = jiraJqlFieldReference(startDateFieldId, "Start Date");
				clauses.push(`(${field} >= startOfWeek() AND ${field} <= endOfWeek())`);
			}
			continue;
		}
		if (control === "dueDate") {
			if (values.includes(JIRA_DATE_OPTION_THIS_WEEK)) {
				clauses.push("(duedate >= startOfWeek() AND duedate <= endOfWeek())");
			}
			continue;
		}
		const quoted = values.map((value) => `"${escapeJqlString(value)}"`).join(", ");
		clauses.push(`${fieldByControl[control]} IN (${quoted})`);
	}
	return [clauses.join(" AND "), order].filter(Boolean).join(" ");
}

function addNames(target: Set<string>, raw: unknown): void {
	const values = Array.isArray(raw) ? raw : [raw];
	for (const value of values) {
		if (!value || typeof value !== "object") continue;
		const name = (value as Record<string, unknown>).name;
		if (typeof name === "string" && name.trim()) target.add(name.trim());
	}
}

/** Find the Jira field used for an issue's planned start date. */
export function discoverStartDateFieldId(fields: JiraField[]): string | null {
	const canonical = fields.find(
		(item) => item.id === "customfield_11200" && item.name?.trim().toLowerCase() === "start date",
	);
	if (canonical?.id) return canonical.id;
	const field = fields.find(
		(item) => item.id && item.name?.trim().toLowerCase() === "start date",
	);
	return field?.id ?? null;
}

/** Find an explicit End date field; Due date remains the display fallback. */
export function discoverEndDateFieldId(fields: JiraField[]): string | null {
	const field = fields.find(
		(item) => item.id && item.name?.trim().toLowerCase() === "end date",
	);
	return field?.id ?? null;
}

/** Find Jira's numeric Story Points field used as daily work capacity. */
export function discoverStoryPointsFieldIds(fields: JiraField[]): string[] {
	const names = new Set([
		"story points",
		"story point",
		"story point estimate",
		"estimated story points",
	]);
	const candidates = fields.filter(
		(item) => item.id && item.name && names.has(item.name.trim().toLowerCase()),
	);
	return candidates
		.sort((left, right) => {
			const leftSchema = left.schema?.custom?.toLowerCase().includes("story-point") ? 0 : 1;
			const rightSchema = right.schema?.custom?.toLowerCase().includes("story-point") ? 0 : 1;
			return leftSchema - rightSchema;
		})
		.map((item) => item.id as string);
}

export function discoverStoryPointsFieldId(fields: JiraField[]): string | null {
	return discoverStoryPointsFieldIds(fields)[0] ?? null;
}

/** Search fields, adding discovered planning-date custom fields. */
export function jiraSearchFields(
	startDateFieldId: string | null = null,
	endDateFieldId: string | null = null,
	storyPointsFieldId: string | string[] | null = null,
): string {
	const storyPointFields = Array.isArray(storyPointsFieldId)
		? storyPointsFieldId
		: storyPointsFieldId
			? [storyPointsFieldId]
			: [];
	return [
		...JIRA_BASE_FIELDS,
		...(startDateFieldId ? [startDateFieldId] : []),
		...(endDateFieldId ? [endDateFieldId] : []),
		...storyPointFields,
	].join(",");
}

/** Read normalized YYYY-MM-DD planning dates from a Jira issue. */
export function jiraIssueDates(
	issue: JiraIssue,
	startDateFieldId: string | null,
	endDateFieldId: string | null = null,
): { startDate: string | null; endDate: string | null } {
	const start = startDateFieldId ? issue.fields[startDateFieldId] : null;
	const explicitEnd = endDateFieldId ? issue.fields[endDateFieldId] : null;
	return {
		startDate: typeof start === "string" && start.trim() ? start.slice(0, 10) : null,
		endDate:
			typeof explicitEnd === "string" && explicitEnd.trim()
				? explicitEnd.slice(0, 10)
				: typeof issue.fields.duedate === "string" && issue.fields.duedate.trim()
				? issue.fields.duedate.slice(0, 10)
				: null,
	};
}

/** Derive control options from unrefined issues, retaining persisted selections. */
export function deriveJiraOptions(
	issues: JiraIssue[],
	selections: JiraSelections,
): JiraOptions {
	const sets: Record<JiraControl, Set<string>> = {
		status: new Set(selections.status ?? []),
		assignee: new Set(selections.assignee ?? []),
		startDate: new Set([JIRA_DATE_OPTION_THIS_WEEK]),
		dueDate: new Set([JIRA_DATE_OPTION_THIS_WEEK]),
		priority: new Set(selections.priority ?? []),
		issueType: new Set(selections.issueType ?? []),
		fixVersion: new Set(selections.fixVersion ?? []),
	};
	for (const issue of issues) {
		const fields = issue.fields;
		addNames(sets.status, fields.status);
		addNames(sets.priority, fields.priority);
		addNames(sets.issueType, fields.issuetype);
		addNames(sets.fixVersion, fields.fixVersions);
		const assignee = fields.assignee;
		const assigneeName = assignee?.name ?? assignee?.displayName;
		if (assigneeName?.trim()) sets.assignee.add(assigneeName.trim());
	}
	return Object.fromEntries(
		JIRA_CONTROLS.map((control) => [
			control,
			Array.from(sets[control]).sort((a, b) => a.localeCompare(b)),
		]),
	) as JiraOptions;
}

/** Narrow Jira control options with a case-insensitive substring query. */
export function filterJiraOptions(
	values: string[],
	query: string,
	label: (value: string) => string = (value) => value,
): string[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return [...values];
	return values.filter((value) => label(value).toLocaleLowerCase().includes(needle));
}

function validatedHost(host: string): URL {
	const parsed = new URL(host);
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error("invalid-host");
	}
	return parsed;
}

function relativePath(path: string, fallback: string): string {
	const value = path.trim() || fallback;
	if (
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\") ||
		value.includes("?") ||
		value.includes("#") ||
		/^[a-z][a-z0-9+.-]*:/i.test(value)
	) {
		throw new Error("invalid-api-path");
	}
	return value.replace(/\/+$/, "");
}

/** Build a Jira REST URL that cannot escape the explicitly configured host. */
export function buildJiraUrl(
	host: string,
	apiBasePath: string,
	endpoint: string,
	query?: Record<string, string>,
): URL {
	const parsedHost = validatedHost(host);
	const basePath = relativePath(apiBasePath, "/rest/api/latest");
	const endpointPath = relativePath(endpoint, "/");
	const hostPath = parsedHost.pathname.replace(/\/+$/, "");
	const url = new URL(parsedHost.origin);
	url.pathname = `${hostPath}${basePath}${endpointPath}`;
	for (const [key, value] of Object.entries(query ?? {})) {
		url.searchParams.set(key, value);
	}
	if (url.origin !== parsedHost.origin) throw new Error("cross-origin-request");
	return url;
}

function ttlMs(config: JiraConfig): number {
	return Math.max(0, config.cacheMin ?? 5) * 60_000;
}

function cacheGet<T>(config: JiraConfig, key: string): T | null {
	const cache = jiraCache.get(config);
	const entry = cache?.get(key) as CacheEntry<T> | undefined;
	if (!entry || entry.expiresAt <= Date.now()) {
		if (entry) cache?.delete(key);
		return null;
	}
	return entry.value;
}

function cacheSet<T>(key: string, value: T, config: JiraConfig): void {
	const ttl = ttlMs(config);
	if (ttl <= 0) return;
	let cache = jiraCache.get(config);
	if (!cache) {
		cache = new Map<string, CacheEntry<unknown>>();
		jiraCache.set(config, cache);
	}
	cache.set(key, { value, expiresAt: Date.now() + ttl });
}

/** Drop every cached response associated with this card's connection object. */
export function clearJiraCache(config: JiraConfig): void {
	jiraCache.delete(config);
}

function authHeader(config: JiraConfig): string {
	// SECURITY-REVIEW: The bearer PAT is read from per-card plugin data and sent
	// only to the validated Jira origin. It is never logged or included in errors.
	return `Bearer ${config.pat ?? ""}`;
}

async function requestJira<T>(
	config: JiraConfig,
	endpoint: string,
	query?: Record<string, string>,
	force = false,
): Promise<T> {
	const url = buildJiraUrl(
		config.host ?? "",
		config.apiBasePath ?? "/rest/api/latest",
		endpoint,
		query,
	);
	const key = url.toString();
	if (!force) {
		const cached = cacheGet<T>(config, key);
		if (cached !== null) return cached;
	}
	const params: RequestUrlParam = {
		url: key,
		method: "GET",
		throw: false,
		headers: {
			Authorization: authHeader(config),
			Accept: "application/json",
		},
	};
	// SECURITY-REVIEW: External request target is constructed by buildJiraUrl,
	// restricted to the configured HTTPS origin and relative REST paths.
	const response = await requestUrl(params);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`jira-http-${response.status}`);
	}
	if (!response.json || typeof response.json !== "object") {
		throw new Error("jira-invalid-response");
	}
	const value = response.json as T;
	cacheSet(key, value, config);
	return value;
}

/** Build the minimal Jira fields needed to create a child of an existing task. */
export function buildJiraSubtaskFields(
	parentKey: string,
	summary: string,
	options?: {
		category: JiraSubtaskCategory;
		startDate: string;
		dueDate: string;
		storyPoints: number;
		startDateFieldId: string;
		storyPointsFieldId: string;
		fixVersions?: JiraNamedValue[];
		components?: JiraNamedValue[];
		assignee: string;
	},
): Record<string, unknown> {
	const normalizedParent = parentKey.trim();
	const projectKey = normalizedParent.replace(/-\d+$/, "");
	if (!normalizedParent || projectKey === normalizedParent || !summary.trim()) {
		throw new Error("invalid-subtask");
	}
	const fields: Record<string, unknown> = {
		project: { key: projectKey },
		parent: { key: normalizedParent },
		summary: options
			? formatJiraSubtaskSummary(options.category, summary)
			: summary.trim(),
		issuetype: { name: "Sub-task" },
	};
	if (!options) return fields;
	fields.assignee = { name: options.assignee };
	fields.duedate = options.dueDate;
	fields[options.startDateFieldId] = options.startDate;
	fields[options.storyPointsFieldId] = options.storyPoints;
	if (options.fixVersions?.length) {
		fields.fixVersions = options.fixVersions.map((version) =>
			version.id ? { id: version.id } : { name: version.name },
		);
	}
	if (options.components?.length) {
		fields.components = options.components.map((component) =>
			component.id ? { id: component.id } : { name: component.name },
		);
	}
	return fields;
}

/** Keep create-screen fields separate from values Jira only accepts through Edit Issue. */
export function splitJiraSubtaskFields(fields: Record<string, unknown>): {
	createFields: Record<string, unknown>;
	updateFields: Record<string, unknown>;
} {
	const createFieldNames = new Set(["project", "parent", "summary", "issuetype", "components"]);
	const createFields: Record<string, unknown> = {};
	const updateFields: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(fields)) {
		(createFieldNames.has(name) ? createFields : updateFields)[name] = value;
	}
	return { createFields, updateFields };
}

const JIRA_SUBTASK_TYPE_FIELD_ID = "customfield_23500";
const JIRA_ESTIMATED_STORY_POINTS_FIELD_ID = "customfield_27662";
export type JiraSubtaskPlanningMode = "deferred" | "storyPointsCreate" | "estimated";

/** Build the common create/edit split used by every Jira sub-task context. */
export function buildJiraSubtaskWritePlan(
	fields: Record<string, unknown>,
	draft: JiraSubtaskDraft,
	storyPointsFieldId: string,
	planningMode: JiraSubtaskPlanningMode = "estimated",
	startDateFieldId = "customfield_11200",
): {
	createFields: Record<string, unknown>;
	updateFields: Record<string, unknown>;
	assignee: string;
} {
	const plan = splitJiraSubtaskFields(fields);
	// Jira's dedicated assignee endpoint is more reliable than Edit Issue for
	// Support sub-tasks. Keep it separate for every parent type so one failed
	// assignee change cannot roll back otherwise valid schedule fields.
	delete plan.updateFields.assignee;
	const result = { ...plan, assignee: draft.assignee.trim() };
	if (planningMode === "deferred") return result;
	const selectedType = JIRA_SUBTASK_TYPES.find((item) => item.value === draft.subtaskType);
	if (!selectedType) throw new Error("invalid-subtask");
	if (planningMode === "storyPointsCreate") {
		plan.createFields.duedate = draft.dueDate;
		plan.createFields[startDateFieldId] = draft.startDate;
		plan.createFields[storyPointsFieldId] = draft.storyPoints;
		plan.createFields[JIRA_SUBTASK_TYPE_FIELD_ID] = { id: selectedType.id };
		delete plan.updateFields.duedate;
		delete plan.updateFields[startDateFieldId];
		delete plan.updateFields[storyPointsFieldId];
		return result;
	}

	plan.createFields.duedate = draft.dueDate;
	plan.createFields[startDateFieldId] = draft.startDate;
	plan.createFields[JIRA_ESTIMATED_STORY_POINTS_FIELD_ID] = draft.storyPoints;
	plan.createFields[JIRA_SUBTASK_TYPE_FIELD_ID] = { id: selectedType.id };
	delete plan.updateFields.duedate;
	delete plan.updateFields[startDateFieldId];
	delete plan.updateFields[storyPointsFieldId];
	return result;
}

/** Select the planning schema exposed by the project's real Sub-task Create screen. */
export function selectJiraSubtaskPlanningMode(
	createFieldIds: string[],
	storyPointsFieldId: string | string[],
): JiraSubtaskPlanningMode {
	const fields = new Set(createFieldIds);
	const storyPointFields = Array.isArray(storyPointsFieldId)
		? storyPointsFieldId
		: [storyPointsFieldId];
	if (
		storyPointFields.some(
			(fieldId) =>
				fieldId !== JIRA_ESTIMATED_STORY_POINTS_FIELD_ID && fields.has(fieldId),
		)
	) {
		return "storyPointsCreate";
	}
	if (fields.has(JIRA_ESTIMATED_STORY_POINTS_FIELD_ID)) return "estimated";
	return "deferred";
}

const JIRA_SUBTASK_PREFIX: Record<JiraSubtaskCategory, string> = {
	spec: "[DE] [SPEC]",
	cr: "[DE] [CR]",
	test: "[DE] [自测]",
};

export function formatJiraSubtaskSummary(
	category: JiraSubtaskCategory,
	summary: string,
): string {
	const text = summary.trim();
	if (!text) throw new Error("invalid-subtask");
	return `${JIRA_SUBTASK_PREFIX[category]} ${text}`;
}

function isoDayNumber(value: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(timestamp) ? Math.floor(timestamp / 86_400_000) : null;
}

function isoDateFromDay(day: number): string {
	return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

function isWeekday(day: number): boolean {
	const weekday = new Date(day * 86_400_000).getUTCDay();
	return weekday >= 1 && weekday <= 5;
}

function workdayCount(first: number, last: number): number {
	let count = 0;
	for (let day = first; day <= last; day++) {
		if (isWeekday(day)) count++;
	}
	return count;
}

/** Allocate total Story Points from the start date, one point per weekday. */
function allocateStoryPoints(first: number, last: number, points: number): Map<number, number> {
	const allocations = new Map<number, number>();
	let remaining = points;
	for (let day = first; day <= last && remaining > Number.EPSILON; day++) {
		if (!isWeekday(day)) continue;
		const allocated = Math.min(1, remaining);
		allocations.set(day, allocated);
		remaining -= allocated;
	}
	return allocations;
}

/** Return Monday through Friday for the calendar week containing the date. */
export function jiraWorkWeekRange(value: string): { startDate: string; dueDate: string } | null {
	const day = isoDayNumber(value);
	if (day === null) return null;
	const weekday = new Date(day * 86_400_000).getUTCDay();
	const monday = day - ((weekday + 6) % 7);
	return { startDate: isoDateFromDay(monday), dueDate: isoDateFromDay(monday + 4) };
}

export type JiraSubtaskDraftError =
	| "summary"
	| "subtaskType"
	| "assignee"
	| "startDate"
	| "dueDate"
	| "dateOrder"
	| "storyPoints";

export function validateJiraSubtaskDraft(
	draft: JiraSubtaskDraft,
): JiraSubtaskDraftError | null {
	if (!draft.summary.trim()) return "summary";
	if (!JIRA_SUBTASK_TYPES.some((item) => item.value === draft.subtaskType)) {
		return "subtaskType";
	}
	if (!(JIRA_SUBTASK_ASSIGNEES as readonly string[]).includes(draft.assignee)) {
		return "assignee";
	}
	const start = isoDayNumber(draft.startDate);
	if (start === null) return "startDate";
	const due = isoDayNumber(draft.dueDate);
	if (due === null) return "dueDate";
	if (start > due) return "dateOrder";
	const availableWorkdays = workdayCount(start, due);
	if (
		!Number.isFinite(draft.storyPoints) ||
		draft.storyPoints <= 0 ||
		availableWorkdays === 0 ||
		draft.storyPoints > availableWorkdays
	) {
		return "storyPoints";
	}
	return null;
}

export function buildJiraCapacityJql(
	assignee: string,
	startDate: string,
	dueDate: string,
	startDateFieldId: string,
): string {
	if (!assignee.trim() || isoDayNumber(startDate) === null || isoDayNumber(dueDate) === null) {
		throw new Error("invalid-capacity-query");
	}
	const startField = jiraJqlFieldReference(startDateFieldId, "Start Date");
	return (
		`assignee = "${escapeJqlString(assignee.trim())}" AND ` +
		"issuetype IN subTaskIssueTypes() AND " +
		"status != Closed AND " +
		`${startField} <= "${dueDate}" AND duedate >= "${startDate}"`
	);
}

function isClosedJiraIssue(issue: JiraIssue): boolean {
	return issue.fields.status.name.trim().toLowerCase() === "closed";
}

/** Choose only a transition whose name or target status is exactly Done. */
export function selectJiraDoneTransition(
	transitions: JiraTransition[],
): JiraTransition | null {
	return (
		transitions.find(
			(transition) =>
				transition.id &&
				[transition.name, transition.to?.name].some(
					(value) => value?.trim().toLowerCase() === "done",
				),
		) ?? null
	);
}

/** Choose only a transition whose name or target status is exactly Doing. */
export function selectJiraDoingTransition(
	transitions: JiraTransition[],
): JiraTransition | null {
	return (
		transitions.find(
			(transition) =>
				transition.id &&
				[transition.name, transition.to?.name].some(
					(value) => value?.trim().toLowerCase() === "doing",
				),
		) ?? null
	);
}

/** Find every day whose existing work plus the requested work exceeds 1. */
export function findJiraCapacityConflicts(
	issues: JiraIssue[],
	startDateFieldId: string,
	storyPointsFieldId: string | string[],
	startDate: string,
	dueDate: string,
	requested: number,
): JiraCapacityConflict[] {
	const first = isoDayNumber(startDate);
	const last = isoDayNumber(dueDate);
	if (first === null || last === null || first > last || requested <= 0) return [];
	const totals = new Map<number, number>();
	for (const issue of issues) {
		if (isClosedJiraIssue(issue)) continue;
		const issueStartRaw = issue.fields[startDateFieldId];
		const issueStart =
			typeof issueStartRaw === "string" ? isoDayNumber(issueStartRaw.slice(0, 10)) : null;
		const issueDue =
			typeof issue.fields.duedate === "string"
				? isoDayNumber(issue.fields.duedate.slice(0, 10))
				: null;
		const storyPointFields = Array.isArray(storyPointsFieldId)
			? storyPointsFieldId
			: [storyPointsFieldId];
		const pointsRaw = storyPointFields
			.map((fieldId) => issue.fields[fieldId])
			.find((value) =>
				typeof value === "number"
					? Number.isFinite(value)
					: typeof value === "string" && Number.isFinite(Number(value)),
			);
		const points =
			typeof pointsRaw === "number"
				? pointsRaw
				: typeof pointsRaw === "string"
				? Number(pointsRaw)
				: Number.NaN;
		if (issueStart === null || issueDue === null || !Number.isFinite(points) || points <= 0) {
			continue;
		}
		for (const [day, allocated] of allocateStoryPoints(issueStart, issueDue, points)) {
			if (day >= first && day <= last) {
				totals.set(day, (totals.get(day) ?? 0) + allocated);
			}
		}
	}
	const requestedWorkdays = workdayCount(first, last);
	if (requestedWorkdays === 0) return [];
	const requestedAllocations = allocateStoryPoints(first, last, requested);
	const conflicts: JiraCapacityConflict[] = [];
	for (let day = first; day <= last; day++) {
		if (!isWeekday(day)) continue;
		const existing = totals.get(day) ?? 0;
		const requestedOnDay = requestedAllocations.get(day) ?? 0;
		const total = existing + requestedOnDay;
		if (total > 1 + Number.EPSILON) {
			conflicts.push({
				date: new Date(day * 86_400_000).toISOString().slice(0, 10),
				existing,
				requested: requestedOnDay,
				total,
			});
		}
	}
	return conflicts;
}

/** Find under-booked weekdays after including the requested sub-task. */
export function findJiraWeeklyCapacityShortages(
	issues: JiraIssue[],
	startDateFieldId: string,
	storyPointsFieldId: string | string[],
	weekDate: string,
	requestedStartDate: string,
	requestedDueDate: string,
	requested: number,
): JiraCapacityShortage[] {
	const week = jiraWorkWeekRange(weekDate);
	const requestedFirst = isoDayNumber(requestedStartDate);
	const requestedLast = isoDayNumber(requestedDueDate);
	if (
		!week ||
		requestedFirst === null ||
		requestedLast === null ||
		!Number.isFinite(requested) ||
		requested < 0
	) {
		return [];
	}
	const first = isoDayNumber(week.startDate);
	const last = isoDayNumber(week.dueDate);
	if (first === null || last === null) return [];
	const totals = new Map<number, number>();
	for (const issue of issues) {
		if (isClosedJiraIssue(issue)) continue;
		const rawStart = issue.fields[startDateFieldId];
		const issueStart =
			typeof rawStart === "string" ? isoDayNumber(rawStart.slice(0, 10)) : null;
		const issueDue =
			typeof issue.fields.duedate === "string"
				? isoDayNumber(issue.fields.duedate.slice(0, 10))
				: null;
		const storyPointFields = Array.isArray(storyPointsFieldId)
			? storyPointsFieldId
			: [storyPointsFieldId];
		const rawPoints = storyPointFields
			.map((fieldId) => issue.fields[fieldId])
			.find((value) =>
				typeof value === "number"
					? Number.isFinite(value)
					: typeof value === "string" && Number.isFinite(Number(value)),
			);
		const points =
			typeof rawPoints === "number"
				? rawPoints
				: typeof rawPoints === "string"
					? Number(rawPoints)
					: Number.NaN;
		if (issueStart === null || issueDue === null || !Number.isFinite(points) || points <= 0) {
			continue;
		}
		for (const [day, allocated] of allocateStoryPoints(issueStart, issueDue, points)) {
			if (day >= first && day <= last) {
				totals.set(day, (totals.get(day) ?? 0) + allocated);
			}
		}
	}
	const requestedAllocations = allocateStoryPoints(
		requestedFirst,
		requestedLast,
		requested,
	);
	const shortages: JiraCapacityShortage[] = [];
	for (let day = first; day <= last; day++) {
		const requestedOnDay = requestedAllocations.get(day) ?? 0;
		const total = (totals.get(day) ?? 0) + requestedOnDay;
		if (total < 1 - Number.EPSILON) {
			shortages.push({
				date: isoDateFromDay(day),
				missing: Math.round((1 - total) * 1000) / 1000,
			});
		}
	}
	return shortages;
}

function jiraWriteFailure(status: number, text: string): string {
	let json: { errorMessages?: unknown; errors?: unknown; message?: unknown } | undefined;
	try {
		json = JSON.parse(text) as typeof json;
	} catch {
		json = undefined;
	}
	const details = [
		...(Array.isArray(json?.errorMessages)
			? json.errorMessages.filter((item): item is string => typeof item === "string")
			: []),
		...(json?.errors && typeof json.errors === "object"
			? Object.values(json.errors).filter((item): item is string => typeof item === "string")
			: []),
		typeof json?.message === "string" ? json.message : "",
		!json && text.trim() ? text.trim().slice(0, 500) : "",
	].filter(Boolean);
	return details.length ? `Jira ${status}: ${details.join("; ")}` : `Jira ${status}`;
}

/** Detect Jira's create-screen rejection so creation can safely retry with regular fields. */
export function isJiraCreateFieldUnavailable(
	status: number,
	text: string,
	fieldId: string,
): boolean {
	if (status !== 400) return false;
	const detail = text.toLowerCase();
	return (
		detail.includes(fieldId.toLowerCase()) &&
		(detail.includes("cannot be set") ||
			detail.includes("not on the appropriate screen") ||
			detail.includes("unknown"))
	);
}

/** Detect a validator that requires Jira's Estimated Story Points create schema. */
export function isJiraEstimatedStoryPointsRequired(status: number, text: string): boolean {
	if (status !== 400) return false;
	const detail = text.toLowerCase();
	return (
		detail.includes("required") &&
		(detail.includes("estimated story points") ||
			detail.includes(JIRA_ESTIMATED_STORY_POINTS_FIELD_ID))
	);
}

/** Detect projects that require regular planning fields on the Create screen. */
export function isJiraRegularPlanningFieldsRequired(status: number, text: string): boolean {
	if (status !== 400) return false;
	const detail = text.toLowerCase();
	return (
		!detail.includes("estimated story points") &&
		detail.includes("story points") &&
		detail.includes("start date") &&
		detail.includes("due date") &&
		(detail.includes("required") || detail.includes("please fill in"))
	);
}

/** Create a Jira Sub-task, then apply fields excluded from its Create screen. */
export async function createJiraSubtask(
	config: JiraConfig,
	parent: JiraIssue,
	draft: JiraSubtaskDraft,
	fieldIds: { startDate: string; storyPoints: string | string[] },
): Promise<string> {
	const storyPointsFieldIds = Array.isArray(fieldIds.storyPoints)
		? fieldIds.storyPoints
		: [fieldIds.storyPoints];
	const regularStoryPointsFieldId =
		storyPointsFieldIds.find(
			(fieldId) => fieldId !== JIRA_ESTIMATED_STORY_POINTS_FIELD_ID,
		) ?? storyPointsFieldIds[0];
	if (!regularStoryPointsFieldId) throw new Error("missing-story-points-field");
	const allFields = buildJiraSubtaskFields(parent.key, draft.summary, {
		...draft,
		startDateFieldId: fieldIds.startDate,
		storyPointsFieldId: regularStoryPointsFieldId,
		fixVersions: parent.fields.fixVersions,
		components: parent.fields.components,
		assignee: draft.assignee.trim(),
	});
	const projectKey = parent.key.trim().replace(/-\d+$/, "");
	let planningMode: JiraSubtaskPlanningMode = "deferred";
	try {
		const createMeta = await requestJira<JiraCreateMetaResponse>(
			config,
			"/issue/createmeta",
			{
				projectKeys: projectKey,
				issuetypeNames: "Sub-task",
				expand: "projects.issuetypes.fields",
			},
			true,
		);
		const createFieldIds = (createMeta.projects ?? []).flatMap((project) =>
			(project.issuetypes ?? []).flatMap((issueType) => Object.keys(issueType.fields ?? {})),
		);
		planningMode = selectJiraSubtaskPlanningMode(createFieldIds, storyPointsFieldIds);
	} catch {
		// Older Jira deployments may disable createmeta; validation-based fallback below remains.
	}
	let writePlan = buildJiraSubtaskWritePlan(
		allFields,
		draft,
		regularStoryPointsFieldId,
		planningMode,
		fieldIds.startDate,
	);
	const url = buildJiraUrl(
		config.host ?? "",
		config.apiBasePath ?? "/rest/api/latest",
		"/issue",
	);
	const params: RequestUrlParam = {
		url: url.toString(),
		method: "POST",
		throw: false,
		headers: {
			Authorization: authHeader(config),
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Atlassian-Token": "no-check",
			"User-Agent": "Flexible-Workbench/2.2.0",
		},
		body: JSON.stringify({ fields: writePlan.createFields }),
	};
	let response = await requestUrl(params);
	const requiredMode = isJiraEstimatedStoryPointsRequired(response.status, response.text)
		? "estimated"
		: isJiraRegularPlanningFieldsRequired(response.status, response.text)
			? "storyPointsCreate"
			: null;
	if (requiredMode) {
		writePlan = buildJiraSubtaskWritePlan(
			allFields,
			draft,
			regularStoryPointsFieldId,
			requiredMode,
			fieldIds.startDate,
		);
		response = await requestUrl({
			...params,
			body: JSON.stringify({ fields: writePlan.createFields }),
		});
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(jiraWriteFailure(response.status, response.text));
	}
	const created = response.json as JiraCreateIssueResponse | undefined;
	if (!created?.key) throw new Error("jira-invalid-response");
	const { updateFields, assignee } = writePlan;
	const updateFailures: string[] = [];
	if (Object.keys(updateFields).length) {
		const updateUrl = buildJiraUrl(
			config.host ?? "",
			config.apiBasePath ?? "/rest/api/latest",
			`/issue/${encodeURIComponent(created.key)}`,
		);
		const updateResponse = await requestUrl({
			url: updateUrl.toString(),
			method: "PUT",
			throw: false,
			headers: params.headers,
			body: JSON.stringify({ fields: updateFields }),
		});
		if (updateResponse.status < 200 || updateResponse.status >= 300) {
			updateFailures.push(
				`schedule fields: ${jiraWriteFailure(updateResponse.status, updateResponse.text)}`,
			);
		}
	}
	const assigneeUrl = buildJiraUrl(
		config.host ?? "",
		config.apiBasePath ?? "/rest/api/latest",
		`/issue/${encodeURIComponent(created.key)}/assignee`,
	);
	const assigneeResponse = await requestUrl({
		url: assigneeUrl.toString(),
		method: "PUT",
		throw: false,
		headers: params.headers,
		body: JSON.stringify({ name: assignee }),
	});
	if (assigneeResponse.status < 200 || assigneeResponse.status >= 300) {
		updateFailures.push(
			`assignee: ${jiraWriteFailure(assigneeResponse.status, assigneeResponse.text)}`,
		);
	}
	clearJiraCache(config);
	if (updateFailures.length) {
		throw new JiraPartialSubtaskError(created.key, updateFailures.join("; "));
	}
	return created.key;
}

async function postJiraTransition(
	config: JiraConfig,
	issueKey: string,
	transitionId: string,
): Promise<void> {
	const url = buildJiraUrl(
		config.host ?? "",
		config.apiBasePath ?? "/rest/api/latest",
		`/issue/${encodeURIComponent(issueKey)}/transitions`,
	);
	const response = await requestUrl({
		url: url.toString(),
		method: "POST",
		throw: false,
		headers: {
			Authorization: authHeader(config),
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Atlassian-Token": "no-check",
			"User-Agent": "Flexible-Workbench/2.2.0",
		},
		body: JSON.stringify({ transition: { id: transitionId } }),
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Jira ${response.status}: ${response.text.trim().slice(0, 500)}`);
	}
}

/** Move an issue through TO DO -> DOING -> DONE when no direct Done transition exists. */
export async function markJiraIssueDone(
	config: JiraConfig,
	issueKey: string,
): Promise<string> {
	const endpoint = `/issue/${encodeURIComponent(issueKey)}/transitions`;
	let transitions = await requestJira<JiraTransitionsResponse>(
		config,
		endpoint,
		undefined,
		true,
	);
	let done = selectJiraDoneTransition(transitions.transitions ?? []);
	if (!done?.id) {
		const doing = selectJiraDoingTransition(transitions.transitions ?? []);
		if (!doing?.id) throw new Error("no-done-transition");
		await postJiraTransition(config, issueKey, doing.id);
		transitions = await requestJira<JiraTransitionsResponse>(
			config,
			endpoint,
			undefined,
			true,
		);
		done = selectJiraDoneTransition(transitions.transitions ?? []);
		if (!done?.id) throw new Error("doing-without-done-transition");
	}
	await postJiraTransition(config, issueKey, done.id);
	clearJiraCache(config);
	return "Done";
}

/** Load favorite saved filters for the card editor. */
export async function listJiraFilters(config: JiraConfig): Promise<JiraFilter[]> {
	const response = await requestJira<unknown>(config, "/filter/favourite", undefined, true);
	if (!Array.isArray(response)) return [];
	return response
		.map((raw): JiraFilter | null => {
			if (!raw || typeof raw !== "object") return null;
			const item = raw as JiraFilterResponse;
			if ((typeof item.id !== "string" && typeof item.id !== "number") || !item.name)
				return null;
			return { id: String(item.id), name: item.name };
		})
		.filter((filter): filter is JiraFilter => filter !== null);
}

async function loadFilterJql(config: JiraConfig, force: boolean): Promise<string> {
	const directJql = config.jql?.trim();
	if (directJql) {
		const upgraded = upgradeAssignedJiraJql(directJql);
		return config.sortDueDateDesc !== false ? orderJiraByDueDateDesc(upgraded) : upgraded;
	}
	const id = config.filterId?.trim();
	if (!id) throw new Error("missing-filter");
	const filter = await requestJira<JiraFilterResponse>(
		config,
		`/filter/${encodeURIComponent(id)}`,
		undefined,
		force,
	);
	if (typeof filter.jql !== "string" || !filter.jql.trim())
		throw new Error("missing-jql");
	const filterJql = filter.jql.trim();
	return config.sortDueDateDesc !== false
		? orderJiraByDueDateDesc(filterJql)
		: filterJql;
}

async function loadJiraFieldIds(
	config: JiraConfig,
): Promise<{ startDate: string | null; endDate: string | null; storyPoints: string[] }> {
	const fields = await requestJira<unknown>(config, "/field");
	if (!Array.isArray(fields)) return { startDate: null, endDate: null, storyPoints: [] };
	const jiraFields = fields as JiraField[];
	return {
		startDate: discoverStartDateFieldId(jiraFields),
		endDate: discoverEndDateFieldId(jiraFields),
		storyPoints: discoverStoryPointsFieldIds(jiraFields),
	};
}

async function searchJira(
	config: JiraConfig,
	jql: string,
	maxResults: number,
	startDateFieldId: string | null,
	endDateFieldId: string | null,
	storyPointsFieldId: string | string[] | null,
	force: boolean,
): Promise<JiraIssue[]> {
	const response = await requestJira<JiraSearchResponse>(
		config,
		"/search",
		{
			jql,
			fields: jiraSearchFields(startDateFieldId, endDateFieldId, storyPointsFieldId),
			maxResults: String(maxResults),
		},
		force,
	);
	return Array.isArray(response.issues)
		? response.issues.filter(
				(issue) =>
					typeof issue?.key === "string" &&
					typeof issue.fields?.summary === "string" &&
					typeof issue.fields?.status?.name === "string" &&
					typeof issue.fields?.issuetype?.name === "string",
			)
		: [];
}

/** Load the small, purpose-built list used while creating a local Todo. This
 * is deliberately separate from a card's saved-filter query. */
export async function loadMyOpenJiraSubtasks(config: JiraConfig): Promise<JiraIssue[]> {
	return searchJira(config, JIRA_MY_OPEN_SUBTASKS_JQL, 50, null, null, null, true);
}

async function loadJiraCapacityIssues(
	config: JiraConfig,
	assignee: string,
	startDate: string,
	dueDate: string,
	startDateFieldId: string,
	storyPointsFieldId: string | string[],
): Promise<JiraIssue[]> {
	return searchJira(
		config,
		buildJiraCapacityJql(assignee, startDate, dueDate, startDateFieldId),
		200,
		startDateFieldId,
		null,
		storyPointsFieldId,
		true,
	);
}

function statusClass(key: string | undefined): string {
	switch (key) {
		case "done":
			return "is-done";
		case "new":
			return "is-new";
		case "indeterminate":
		case undefined:
			return "is-progress";
		default:
			return "is-progress";
	}
}

function controlLabel(control: JiraControl): string {
	return t().cards.jira.controls[control];
}

function controlOptionLabel(control: JiraControl, value: string): string {
	if (
		(control === "startDate" || control === "dueDate") &&
		value === JIRA_DATE_OPTION_THIS_WEEK
	) {
		return t().cards.jira.thisWeek;
	}
	return value;
}

class JiraSubtaskWorkflowModal extends Modal {
	private settled = false;
	private draft: JiraSubtaskDraft;

	constructor(
		app: App,
		private readonly parentKey: string,
		private readonly onDone: (draft: JiraSubtaskDraft | null) => void,
	) {
		super(app);
		const today = new Date();
		const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60_000)
			.toISOString()
			.slice(0, 10);
		this.draft = {
			category: "spec",
			subtaskType: "others",
			summary: "",
			assignee: JIRA_SUBTASK_ASSIGNEES[0],
			startDate: localToday,
			dueDate: localToday,
			storyPoints: 1,
		};
	}

	onOpen(): void {
		const strings = t().cards.jira;
		this.titleEl.setText(strings.createSubtaskFor(this.parentKey));
		const error = this.contentEl.createDiv("flexible-workbench-jira-subtask-error");

		new Setting(this.contentEl)
			.setName(strings.subtaskCategory)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("spec", "[DE] [SPEC]")
					.addOption("cr", "[DE] [CR]")
					.addOption("test", "[DE] [自测]")
					.setValue(this.draft.category)
					.onChange((value) => {
						this.draft.category = value as JiraSubtaskCategory;
					}),
			);
		new Setting(this.contentEl)
			.setName(strings.jiraSubtaskType)
			.addDropdown((dropdown) => {
				for (const option of JIRA_SUBTASK_TYPES) {
					dropdown.addOption(option.value, option.label);
				}
				dropdown
					.setValue(this.draft.subtaskType)
					.onChange((value) => (this.draft.subtaskType = value as JiraSubtaskType));
			});
		new Setting(this.contentEl).setName(strings.subtaskName).addText((text) =>
			text
				.setPlaceholder(strings.subtaskPlaceholder)
				.onChange((value) => (this.draft.summary = value)),
		);
		new Setting(this.contentEl).setName(strings.subtaskAssignee).addDropdown((dropdown) => {
			for (const assignee of JIRA_SUBTASK_ASSIGNEES) {
				dropdown.addOption(assignee, assignee);
			}
			dropdown
				.setValue(this.draft.assignee)
				.onChange((value) => (this.draft.assignee = value));
		});
		const addDate = (
			label: string,
			value: string,
			update: (next: string) => void,
		): void => {
			let input: HTMLInputElement | null = null;
			const setting = new Setting(this.contentEl).setName(label).addText((text) => {
				text.setValue(value).onChange(update);
				text.inputEl.type = "date";
				input = text.inputEl;
			});
			setting.addExtraButton((button) =>
				button
					.setIcon("calendar-days")
					.setTooltip(strings.chooseDate)
					.onClick(() => {
						input?.focus();
						input?.showPicker();
					}),
			);
		};
		addDate(strings.startDate, this.draft.startDate, (value) => (this.draft.startDate = value));
		addDate(strings.endDate, this.draft.dueDate, (value) => (this.draft.dueDate = value));
		new Setting(this.contentEl).setName(strings.subtaskStoryPoints).addText((text) => {
			text.setValue(String(this.draft.storyPoints)).onChange((value) => {
				this.draft.storyPoints = Number(value);
			});
			text.inputEl.type = "number";
			text.inputEl.min = "0.1";
			text.inputEl.step = "0.1";
		});

		const submit = (): void => {
			const validation = validateJiraSubtaskDraft(this.draft);
			if (validation) {
				error.setText(strings.subtaskValidation[validation]);
				return;
			}
			this.settled = true;
			this.close();
			this.onDone({ ...this.draft });
		};
		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText(t().confirm.cancel).onClick(() => this.close()),
			)
			.addButton((button) =>
				button.setButtonText(strings.createSubtask).setCta().onClick(submit),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.onDone(null);
		}
	}
}

function promptForJiraSubtask(
	app: App,
	parentKey: string,
): Promise<JiraSubtaskDraft | null> {
	return new Promise((resolve) => {
		new JiraSubtaskWorkflowModal(app, parentKey, resolve).open();
	});
}

/** Render a Jira saved-filter card, with unrefined option discovery. */
export function renderJiraCard(
	view: HomeView,
	card: DashboardCard,
	body: HTMLElement,
	component: Component,
): void {
	const config = card.jira ?? {};
	const strings = t().cards.jira;
	const wrap = body.createDiv("flexible-workbench-jira");
	if (view.plugin.settings.disableExternalCalls) {
		wrap.createDiv({ cls: "flexible-workbench-jira-state", text: strings.disabled });
		return;
	}
	if (
		!config.host?.trim() ||
		!config.pat?.trim() ||
		(!config.jql?.trim() && !config.filterId?.trim())
	) {
		wrap.createDiv({ cls: "flexible-workbench-jira-state", text: strings.notConfigured });
		return;
	}

	let destroyed = false;
	let loading = false;
	let issues: JiraIssue[] = [];
	let startDateFieldId: string | null = null;
	let endDateFieldId: string | null = null;
	let storyPointsFieldIds: string[] = [];
	let weeklySchedules: JiraAssigneeWeeklySchedule[] | null = null;
	let weeklyScheduleUnavailable = false;
	let options: JiraOptions = {
		status: [],
		assignee: [],
		startDate: [JIRA_DATE_OPTION_THIS_WEEK],
		dueDate: [JIRA_DATE_OPTION_THIS_WEEK],
		priority: [],
		issueType: [],
		fixVersion: [],
	};
	let error = false;
	let saveTimer = 0;

	const selections = (config.selections ??= {});
	const persistSelections = (): void => {
		window.clearTimeout(saveTimer);
		saveTimer = window.setTimeout(() => {
			if (!destroyed) void view.plugin.saveData(view.plugin.settings);
		}, 300);
	};

	const openIssue = (key: string): void => {
		const host = validatedHost(config.host ?? "");
		const hostPath = host.pathname.replace(/\/+$/, "");
		const url = new URL(`${hostPath}/browse/${encodeURIComponent(key)}`, host.origin);
		window.open(url.toString(), "_blank", "noopener");
	};

	const toolbar = wrap.createDiv("flexible-workbench-jira-toolbar");
	const content = wrap.createDiv("flexible-workbench-jira-issues");
	let refreshButton: HTMLButtonElement | null = null;
	let coordinator: JiraLoadCoordinator<{ force: boolean; refinedOnly: boolean }>;

	const paintLoading = (): void => {
		refreshButton?.toggleClass("is-loading", loading);
	};

	const paintToolbar = (): void => {
		if (destroyed) return;
		toolbar.empty();
		const enabled = effectiveJiraControls(config);
		for (const control of enabled) {
			const details = toolbar.createEl("details", { cls: "flexible-workbench-jira-filter" });
			const selected = selections[control] ?? [];
			const summary = details.createEl("summary");
			summary.setText(
				selected.length
					? strings.controlCount(controlLabel(control), selected.length)
					: controlLabel(control),
			);
			const menu = details.createDiv("flexible-workbench-jira-filter-menu");
			const values = options[control];
			const searchWrap = menu.createDiv("flexible-workbench-jira-filter-search");
			const search = searchWrap.createEl("input", {
				attr: {
					"aria-label": strings.searchAria(controlLabel(control)),
					autocomplete: "off",
					spellcheck: "false",
				},
			});
			search.type = "search";
			search.placeholder = strings.searchPlaceholder;
			const optionList = menu.createDiv("flexible-workbench-jira-filter-options");
			const paintOptions = (): void => {
				optionList.empty();
				const filtered = filterJiraOptions(
					values,
					search.value,
					(value) => controlOptionLabel(control, value),
				);
				if (!filtered.length) {
					optionList.createDiv({
						cls: "flexible-workbench-jira-filter-empty",
						text: values.length ? strings.noMatchingOptions : strings.noOptions,
						attr: { role: "status" },
					});
					return;
				}
				for (const value of filtered) {
					const label = optionList.createEl("label", {
						cls: "flexible-workbench-jira-filter-option",
					});
					const input = label.createEl("input");
					input.type = "checkbox";
					input.checked = (selections[control] ?? []).includes(value);
					label.createSpan({ text: controlOptionLabel(control, value) });
					input.addEventListener("change", () => {
						const next = new Set(selections[control] ?? []);
						if (input.checked) next.add(value);
						else next.delete(value);
						selections[control] = Array.from(next);
						summary.setText(
							next.size
								? strings.controlCount(controlLabel(control), next.size)
								: controlLabel(control),
						);
						persistSelections();
						coordinator.request({ force: false, refinedOnly: true });
					});
				}
			};
			search.addEventListener("input", paintOptions);
			details.addEventListener("toggle", () => {
				if (details.open) {
					window.requestAnimationFrame(() => {
						if (!destroyed && search.isConnected) search.focus();
					});
					return;
				}
				search.value = "";
				paintOptions();
			});
			paintOptions();
		}
		const schedule = toolbar.createSpan("flexible-workbench-jira-weekly-schedule");
		if (weeklyScheduleUnavailable) {
			schedule.addClass("is-unavailable");
			schedule.setText(strings.weeklyScheduleUnavailable);
		} else if (!weeklySchedules) {
			schedule.setText(strings.weeklyScheduleLoading);
		} else if (weeklySchedules.every((item) => item.shortages.length === 0)) {
			schedule.addClass("is-complete");
			schedule.setText(strings.weeklyScheduleComplete);
		} else {
			schedule.addClass("is-missing");
			schedule.setText(strings.weeklyScheduleMissing(weeklySchedules));
		}
		refreshButton = toolbar.createEl("button", {
			cls: "flexible-workbench-jira-refresh",
			attr: { "aria-label": strings.refresh },
		});
		setIcon(refreshButton, "refresh-cw");
		paintLoading();
		refreshButton.addEventListener("click", () =>
			coordinator.request({ force: true, refinedOnly: false }),
		);
	};

	const paintIssues = (): void => {
		if (destroyed) return;
		content.empty();
		if (loading && !issues.length) {
			content.createDiv({ cls: "flexible-workbench-jira-state", text: strings.loading });
			return;
		}
		if (error && !issues.length) {
			content.createDiv({ cls: "flexible-workbench-jira-state", text: strings.error });
			return;
		}
		if (!issues.length) {
			content.createDiv({ cls: "flexible-workbench-jira-state", text: strings.empty });
			return;
		}
		const linkedTasks = linkedTaskNotesByJiraKey(view.app);
		for (const issue of issues) {
			const todos = linkedTasks.get(issue.key) ?? [];
			const dates = jiraIssueDates(issue, startDateFieldId, endDateFieldId);
			const row = content.createDiv("flexible-workbench-jira-issue");
			const open = row.createEl("button", {
				cls: "flexible-workbench-jira-open",
				attr: { "aria-label": strings.openIssue(issue.key) },
			});
			open.addEventListener("click", () => openIssue(issue.key));
			const type = open.createDiv("flexible-workbench-jira-type");
			setIcon(type, "square-dashed");
			type.setAttribute("aria-label", issue.fields.issuetype.name);
			const main = open.createDiv("flexible-workbench-jira-main");
			const meta = main.createDiv("flexible-workbench-jira-meta");
			meta.createSpan({ cls: "flexible-workbench-jira-key", text: issue.key });
			const summaryRow = main.createDiv("flexible-workbench-jira-summary-row");
			summaryRow.createSpan({ cls: "flexible-workbench-jira-summary", text: issue.fields.summary });
			summaryRow.createSpan({
				cls: "flexible-workbench-jira-issue-type",
				text: issue.fields.issuetype.name,
			});
			const fixVersions = (issue.fields.fixVersions ?? [])
				.map((version) => version.name)
				.filter(Boolean)
				.join(", ");
			summaryRow.createSpan({
				cls: "flexible-workbench-jira-fix-version",
				text: `${strings.controls.fixVersion}: ${fixVersions || strings.noDate}`,
			});
			if (config.showStartDate !== false || config.showEndDate !== false) {
				if (config.showStartDate !== false) {
					summaryRow.createSpan({
						cls: "flexible-workbench-jira-date",
						text: `${strings.startDate}: ${dates.startDate ?? strings.noDate}`,
					});
				}
				if (config.showEndDate !== false) {
					summaryRow.createSpan({
						cls: "flexible-workbench-jira-date",
						text: `${strings.endDate}: ${dates.endDate ?? strings.noDate}`,
					});
				}
			}
			open.createSpan({
				cls: `flexible-workbench-jira-status ${statusClass(
					issue.fields.status.statusCategory?.key,
				)}`,
				text: issue.fields.status.name,
			});
			const markDone = row.createEl("button", {
				cls: "flexible-workbench-jira-done",
				attr: {
					"aria-label": strings.markDoneFor(issue.key),
					title: strings.markDone,
				},
			});
			setIcon(markDone, "circle-check-big");
			const completedStatus = issue.fields.status.name.trim().toLowerCase() === "done";
			markDone.disabled = completedStatus;
			markDone.addEventListener("click", () => {
				if (completedStatus || markDone.disabled) return;
				// Re-read rather than trust the render-time snapshot: the linked note
				// may have been checked off in another tab a moment ago.
				const remaining = (linkedTaskNotesByJiraKey(view.app).get(issue.key) ?? []).filter(
					(todo) => !todo.done,
				);
				if (remaining.length) {
					new Notice(strings.markDoneBlocked(issue.key, remaining.length));
					return;
				}
				markDone.disabled = true;
				void markJiraIssueDone(config, issue.key)
					.then((status) => {
						if (!destroyed) {
							new Notice(strings.markedDone(issue.key, status));
							coordinator.request({ force: true, refinedOnly: false });
						}
					})
					.catch((cause: unknown) => {
						if (!destroyed) {
							const detail = cause instanceof Error ? cause.message : "";
							new Notice(strings.markDoneFailed(detail), 10_000);
							if (markDone.isConnected) markDone.disabled = false;
						}
					});
			});
			const createSubtask = row.createEl("button", {
				cls: "flexible-workbench-jira-subtask",
				attr: {
					"aria-label": strings.createSubtaskFor(issue.key),
					title: strings.createSubtask,
				},
			});
			setIcon(createSubtask, "list-plus");
			const createSubtaskForIssue = async (): Promise<void> => {
				if (!startDateFieldId || !storyPointsFieldIds.length) {
					new Notice(strings.subtaskFieldsMissing);
					return;
				}
				const draft = await promptForJiraSubtask(view.app, issue.key);
				if (!draft || destroyed) return;
				createSubtask.disabled = true;
				try {
					const workWeek = jiraWorkWeekRange(draft.startDate);
					if (!workWeek) throw new Error("invalid-work-week");
					const capacityStart =
						draft.startDate < workWeek.startDate ? draft.startDate : workWeek.startDate;
					const capacityDue = draft.dueDate > workWeek.dueDate ? draft.dueDate : workWeek.dueDate;
					const capacityIssues = await loadJiraCapacityIssues(
						config,
						draft.assignee,
						capacityStart,
						capacityDue,
						startDateFieldId,
						storyPointsFieldIds,
					);
					const conflicts = findJiraCapacityConflicts(
						capacityIssues,
						startDateFieldId,
						storyPointsFieldIds,
						draft.startDate,
						draft.dueDate,
						draft.storyPoints,
					);
					if (conflicts.length) {
						new Notice(strings.subtaskCapacityExceeded(conflicts.map((item) => item.date)));
						return;
					}
					const key = await createJiraSubtask(config, issue, draft, {
						startDate: startDateFieldId,
						storyPoints: storyPointsFieldIds,
					});
					if (!destroyed) {
						new Notice(strings.subtaskCreated(key));
						coordinator.request({ force: true, refinedOnly: false });
					}
				} catch (cause) {
					if (!destroyed) {
						if (cause instanceof JiraPartialSubtaskError) {
							new Notice(
								strings.subtaskPartiallyCreated(cause.issueKey, cause.detail),
								15_000,
							);
							coordinator.request({ force: true, refinedOnly: false });
						} else {
							const detail = cause instanceof Error ? cause.message : "";
							new Notice(strings.subtaskCreateFailed(detail), 10_000);
						}
					}
				} finally {
					if (!destroyed && createSubtask.isConnected) createSubtask.disabled = false;
				}
			};
			createSubtask.addEventListener("click", () => void createSubtaskForIssue());
			if (todos.length) {
				const linked = row.createDiv("flexible-workbench-jira-linked-todos");
				linked.createSpan({
					cls: "flexible-workbench-jira-linked-label",
					text: strings.linkedTodos(todos.length),
				});
				for (const todo of todos) {
					const link = linked.createEl("button", {
						cls: "flexible-workbench-jira-linked-todo",
						text: todo.title,
						attr: { title: todo.file.path },
					});
					link.toggleClass("is-done", todo.done);
					link.addEventListener("click", () => void openFile(view, todo.file, "card"));
				}
			}
		}
	};

	coordinator = createJiraLoadCoordinator(
		async ({ force, refinedOnly }): Promise<void> => {
			if (destroyed) return;
			loading = true;
			error = false;
			paintLoading();
			paintIssues();
			try {
				const [baseJql, discoveredFields] = await Promise.all([
					loadFilterJql(config, force),
					loadJiraFieldIds(config),
				]);
				if (destroyed) return;
				startDateFieldId = discoveredFields.startDate;
				endDateFieldId = discoveredFields.endDate;
				storyPointsFieldIds = discoveredFields.storyPoints;
				if (!refinedOnly) {
					const now = new Date();
					const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
						.toISOString()
						.slice(0, 10);
					const workWeek = jiraWorkWeekRange(today);
					const scheduleStartFieldId = startDateFieldId;
					const scheduleStoryPointsFieldIds = storyPointsFieldIds;
					const schedulePromise =
						scheduleStartFieldId && scheduleStoryPointsFieldIds.length && workWeek
							? Promise.all(
									JIRA_SUBTASK_ASSIGNEES.map(async (assignee) => ({
										assignee,
										issues: await loadJiraCapacityIssues(
											config,
											assignee,
											workWeek.startDate,
											workWeek.dueDate,
											scheduleStartFieldId,
											scheduleStoryPointsFieldIds,
										),
									})),
								).catch(() => null)
							: Promise.resolve(null);
					const [sample, scheduleIssues] = await Promise.all([
						searchJira(
							config,
							baseJql,
							200,
							startDateFieldId,
							endDateFieldId,
							storyPointsFieldIds,
							force,
						),
						schedulePromise,
					]);
					if (destroyed) return;
					weeklyScheduleUnavailable = scheduleIssues === null;
					weeklySchedules = scheduleIssues
						? scheduleIssues.map(({ assignee, issues: assigneeIssues }) => ({
								assignee,
								shortages: findJiraWeeklyCapacityShortages(
									assigneeIssues,
									scheduleStartFieldId as string,
									scheduleStoryPointsFieldIds,
									today,
									today,
									today,
									0,
								),
							}))
						: null;
					options = deriveJiraOptions(sample, selections);
					paintToolbar();
				}
				const loadedIssues = await searchJira(
					config,
					composeJiraJql(baseJql, selections, startDateFieldId),
					Math.max(1, Math.min(200, config.maxResults ?? 50)),
					startDateFieldId,
					endDateFieldId,
					storyPointsFieldIds,
					force,
				);
				if (destroyed) return;
				issues = loadedIssues;
			} catch {
				if (destroyed) return;
				error = true;
			} finally {
				if (!destroyed) {
					loading = false;
					paintLoading();
					paintIssues();
				}
			}
		},
	);

	component.register(() => {
		destroyed = true;
		coordinator.destroy();
		window.clearTimeout(saveTimer);
	});

	paintToolbar();
	paintIssues();
	coordinator.request({ force: false, refinedOnly: false });
	// The minimal tier reports 0 here, so Jira is fetched on render and on the
	// manual refresh only — never on a timer.
	const refreshMin = effectiveAutoRefreshMinutes(
		view.plugin.settings,
		Math.max(0, config.refreshMin ?? 0),
	);
	if (refreshMin > 0) {
		component.registerInterval(
			window.setInterval(
				() => coordinator.request({ force: true, refinedOnly: false }),
				refreshMin * 60_000,
			),
		);
	}
}
