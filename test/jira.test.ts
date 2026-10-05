import { describe, expect, it } from "vitest";
import {
	buildJiraCapacityJql,
	buildJiraSubtaskFields,
	buildJiraSubtaskWritePlan,
	buildJiraUrl,
	composeJiraJql,
	createJiraLoadCoordinator,
	deriveJiraOptions,
	discoverEndDateFieldId,
	discoverStartDateFieldId,
	discoverStoryPointsFieldId,
	discoverStoryPointsFieldIds,
	effectiveJiraControls,
	escapeJqlString,
	filterJiraOptions,
	findJiraCapacityConflicts,
	findJiraWeeklyCapacityShortages,
	formatJiraSubtaskSummary,
	JIRA_ASSIGNED_TEAM_JQL,
	JIRA_SUBTASK_ASSIGNEES,
	isJiraCreateFieldUnavailable,
	isJiraEstimatedStoryPointsRequired,
	isJiraRegularPlanningFieldsRequired,
	jiraIssueDates,
	jiraJqlFieldReference,
	jiraWorkWeekRange,
	orderJiraByDueDateDesc,
	selectJiraDoneTransition,
	selectJiraDoingTransition,
	selectJiraSubtaskPlanningMode,
	splitJiraSubtaskFields,
	upgradeAssignedJiraJql,
	validateJiraSubtaskDraft,
} from "../src/jira";
import {
	exportLayout,
	exportSettings,
	sanitizeJira,
} from "../src/layout";
import {
	DEFAULT_SETTINGS,
	type DashboardCard,
	type HomeSettings,
	type JiraSelections,
} from "../src/types";

describe("escapeJqlString", () => {
	it("escapes quotes, backslashes, and line breaks", () => {
		expect(escapeJqlString('QA "ready" \\ blocked\nnext')).toBe(
			'QA \\"ready\\" \\\\ blocked\\nnext',
		);
	});
});

describe("composeJiraJql", () => {
	it("parenthesizes the saved filter JQL and combines multi-select clauses", () => {
		const selections: JiraSelections = {
			status: ["In Progress", 'Ready "QA"'],
			assignee: ["Jane Doe"],
			priority: [],
			issueType: ["Story", "Bug"],
			fixVersion: ["Release 1"],
		};

		expect(composeJiraJql("project = APP ORDER BY updated DESC", selections)).toBe(
			'(project = APP) AND status IN ("In Progress", "Ready \\"QA\\"")' +
				' AND assignee IN ("Jane Doe") AND issuetype IN ("Story", "Bug")' +
				' AND fixVersion IN ("Release 1") ORDER BY updated DESC',
		);
	});

	it("returns only a parenthesized base query when selections are empty", () => {
		expect(composeJiraJql("project = APP", {})).toBe("(project = APP)");
	});

	it("does not treat ORDER BY text inside a quoted value as the sort clause", () => {
		expect(
			composeJiraJql(
				'summary ~ "please order by request" ORDER BY updated DESC',
				{ status: ["Open"] },
			),
		).toBe(
			'(summary ~ "please order by request") AND status IN ("Open") ORDER BY updated DESC',
		);
	});

	it("never emits empty parentheses for empty or order-only base JQL", () => {
		expect(composeJiraJql("", {})).toBe("");
		expect(composeJiraJql("ORDER BY updated DESC", {})).toBe(
			"ORDER BY updated DESC",
		);
		expect(composeJiraJql("", { status: ["Open"] })).toBe(
			'status IN ("Open")',
		);
	});

	it("adds this-week ranges for Start date and Due date", () => {
		expect(
			composeJiraJql(
				"project = APP ORDER BY updated DESC",
				{ startDate: ["thisWeek"], dueDate: ["thisWeek"] },
				"customfield_10015",
			),
		).toBe(
			"(project = APP) AND " +
				"(cf[10015] >= startOfWeek() AND cf[10015] <= endOfWeek()) AND " +
				"(duedate >= startOfWeek() AND duedate <= endOfWeek()) ORDER BY updated DESC",
		);
	});
});

describe("jiraJqlFieldReference", () => {
	it("converts REST custom field ids to cf[id] JQL syntax", () => {
		expect(jiraJqlFieldReference("customfield_10015", "Start Date")).toBe(
			"cf[10015]",
		);
	});

	it("falls back to the quoted display name", () => {
		expect(jiraJqlFieldReference(null, "Start Date")).toBe('"Start Date"');
	});
});

describe("orderJiraByDueDateDesc", () => {
	it("replaces an existing sort and keeps the query", () => {
		expect(
			orderJiraByDueDateDesc(
				'project = APP AND summary ~ "order by" ORDER BY "Start Date" DESC',
			),
		).toBe(
			'project = APP AND summary ~ "order by" ORDER BY duedate DESC, updated DESC',
		);
	});
});

describe("upgradeAssignedJiraJql", () => {
	it("adds the requested teammate to the original preset", () => {
		expect(
			upgradeAssignedJiraJql(
				"assignee = currentUser() ORDER BY duedate ASC, updated DESC",
			),
		).toBe(JIRA_ASSIGNED_TEAM_JQL);
	});

	it("leaves custom JQL untouched", () => {
		const custom = "project = APP ORDER BY updated DESC";
		expect(upgradeAssignedJiraJql(custom)).toBe(custom);
	});
});

describe("effectiveJiraControls", () => {
	it("adds date filters to cards created before those controls existed", () => {
		expect(effectiveJiraControls({ controls: ["status", "assignee"] })).toEqual([
			"status",
			"assignee",
			"startDate",
			"dueDate",
		]);
	});

	it("respects explicitly disabled date filters", () => {
		expect(
			effectiveJiraControls({
				controls: ["status", "dueDate"],
				dateControlsConfigured: true,
			}),
		).toEqual(["status", "dueDate"]);
	});
});

describe("deriveJiraOptions", () => {
	it("derives sorted unique options while retaining selected missing values", () => {
		const options = deriveJiraOptions(
			[
				{
					key: "APP-1",
					fields: {
						summary: "One",
						status: { name: "Done", statusCategory: { key: "done" } },
						priority: { name: "High" },
						issuetype: { name: "Bug" },
						assignee: { name: "jdoe", displayName: "Jane Doe" },
						fixVersions: [{ name: "Release 1" }],
					},
				},
				{
					key: "APP-2",
					fields: {
						summary: "Two",
						status: { name: "Open", statusCategory: { key: "new" } },
						priority: { name: "High" },
						issuetype: { name: "Story" },
						assignee: null,
						fixVersions: [],
					},
				},
			],
			{ status: ["Archived"] },
		);

		expect(options.status).toEqual(["Archived", "Done", "Open"]);
		expect(options.priority).toEqual(["High"]);
		expect(options.issueType).toEqual(["Bug", "Story"]);
		expect(options.assignee).toEqual(["jdoe"]);
		expect(options.startDate).toEqual(["thisWeek"]);
		expect(options.dueDate).toEqual(["thisWeek"]);
		expect(options.fixVersion).toEqual(["Release 1"]);
	});
});

describe("filterJiraOptions", () => {
	const options = ["Release 10", "Platform release", "Delivery train"];

	it("returns every option for an empty or whitespace-only query", () => {
		const unfiltered = filterJiraOptions(options, "");
		expect(unfiltered).toEqual(options);
		expect(unfiltered).not.toBe(options);
		expect(filterJiraOptions(options, "   ")).toEqual(options);
	});

	it("matches case-insensitive substrings after trimming the query", () => {
		expect(filterJiraOptions(options, "  RELEASE  ")).toEqual([
			"Release 10",
			"Platform release",
		]);
	});

	it("returns an empty list when no options match without mutating the input", () => {
		expect(filterJiraOptions(options, "missing")).toEqual([]);
		expect(options).toEqual(["Release 10", "Platform release", "Delivery train"]);
	});
});

describe("Jira planning dates", () => {
	it("discovers the Start date field by its Jira display name", () => {
		expect(
			discoverStartDateFieldId([
				{ id: "summary", name: "Summary" },
				{ id: "customfield_10015", name: "Start date" },
			]),
		).toBe("customfield_10015");
	});

	it("prefers Shopee Jira's canonical Start Date field over its empty duplicate", () => {
		expect(
			discoverStartDateFieldId([
				{ id: "customfield_12604", name: "Start date" },
				{ id: "customfield_11200", name: "Start Date" },
			]),
		).toBe("customfield_11200");
	});

	it("discovers an explicit End date field", () => {
		expect(
			discoverEndDateFieldId([{ id: "customfield_10016", name: "End Date" }]),
		).toBe("customfield_10016");
	});

	it("normalizes start and due dates for display", () => {
		expect(
			jiraIssueDates(
				{
					key: "APP-1",
					fields: {
						summary: "Ship dashboard",
						status: { name: "In Progress" },
						issuetype: { name: "Task" },
						duedate: "2026-09-05",
						customfield_10015: "2026-08-30T00:00:00.000+0800",
					},
				},
				"customfield_10015",
			),
		).toEqual({ startDate: "2026-08-30", endDate: "2026-09-05" });
	});

	it("prefers an explicit End date over Due date", () => {
		const issue = {
			key: "APP-2",
			fields: {
				summary: "Plan release",
				status: { name: "Open" },
				issuetype: { name: "Task" },
				duedate: "2026-09-10",
				customfield_10016: "2026-09-08",
			},
		};
		expect(jiraIssueDates(issue, null, "customfield_10016").endDate).toBe(
			"2026-09-08",
		);
	});
});

describe("Jira sub-task creation payload", () => {
	it("offers only the two configured assignees", () => {
		expect(JIRA_SUBTASK_ASSIGNEES).toEqual([
			"shengjie.lin@npt.sg",
			"zenan.wu@npt.sg",
		]);
	});

	it("adds the selected workflow prefix", () => {
		expect(formatJiraSubtaskSummary("spec", "Design schema")).toBe(
			"[DE] [SPEC] Design schema",
		);
		expect(formatJiraSubtaskSummary("cr", "Review changes")).toBe(
			"[DE] [CR] Review changes",
		);
		expect(formatJiraSubtaskSummary("test", "Run regression")).toBe(
			"[DE] [自测] Run regression",
		);
	});

	it("derives the project and parent from the selected task", () => {
		expect(buildJiraSubtaskFields("APP-123", "  Write tests  ")).toEqual({
			project: { key: "APP" },
			parent: { key: "APP-123" },
			summary: "Write tests",
			issuetype: { name: "Sub-task" },
		});
	});

	it("sets selected assignee, dates, points, and inherited fix versions", () => {
		const fields = buildJiraSubtaskFields("APP-123", "Review changes", {
				category: "cr",
				assignee: "zenan.wu@npt.sg",
				startDate: "2026-09-01",
				dueDate: "2026-09-02",
				storyPoints: 0.5,
				startDateFieldId: "customfield_10015",
				storyPointsFieldId: "customfield_10016",
				fixVersions: [{ id: "123", name: "Release 1" }, { name: "Release 2" }],
				components: [{ id: "456", name: "Data Platform" }, { name: "Analytics" }],
			});
		expect(fields).toEqual({
			project: { key: "APP" },
			parent: { key: "APP-123" },
			summary: "[DE] [CR] Review changes",
			issuetype: { name: "Sub-task" },
			assignee: { name: "zenan.wu@npt.sg" },
			duedate: "2026-09-02",
			customfield_10015: "2026-09-01",
			customfield_10016: 0.5,
			fixVersions: [{ id: "123" }, { name: "Release 2" }],
			components: [{ id: "456" }, { name: "Analytics" }],
		});
		expect(splitJiraSubtaskFields(fields)).toEqual({
			createFields: {
				project: { key: "APP" },
				parent: { key: "APP-123" },
				summary: "[DE] [CR] Review changes",
				issuetype: { name: "Sub-task" },
				components: [{ id: "456" }, { name: "Analytics" }],
			},
			updateFields: {
				assignee: { name: "zenan.wu@npt.sg" },
				duedate: "2026-09-02",
				customfield_10015: "2026-09-01",
				customfield_10016: 0.5,
				fixVersions: [{ id: "123" }, { name: "Release 2" }],
			},
		});
	});

	it("uses Support's required create fields independently of the title prefix", () => {
		const draft = {
			category: "cr" as const,
			subtaskType: "others" as const,
			summary: "Handle support request",
			assignee: "shengjie.lin@npt.sg",
			startDate: "2026-09-01",
			dueDate: "2026-09-01",
			storyPoints: 0.5,
		};
		const fields = buildJiraSubtaskFields("SGDB-1", draft.summary, {
			...draft,
			startDateFieldId: "customfield_11200",
			storyPointsFieldId: "customfield_10100",
		});
		const plan = buildJiraSubtaskWritePlan(
			fields,
			draft,
			"customfield_10100",
		);
		expect(plan.createFields).toMatchObject({
			summary: "[DE] [CR] Handle support request",
			duedate: "2026-09-01",
			customfield_11200: "2026-09-01",
			customfield_27662: 0.5,
			customfield_23500: { id: "37006" },
		});
		expect(plan.assignee).toBe("shengjie.lin@npt.sg");
		expect(plan.updateFields).not.toHaveProperty("assignee");
		expect(plan.updateFields).not.toHaveProperty("duedate");
		expect(plan.updateFields).not.toHaveProperty("customfield_11200");
		expect(plan.updateFields).not.toHaveProperty("customfield_10100");
	});

	it("can fall back to regular Story Points when Estimated Story Points is unavailable", () => {
		const draft = {
			category: "spec" as const,
			subtaskType: "tech" as const,
			summary: "Normal task",
			assignee: "zenan.wu@npt.sg",
			startDate: "2026-09-01",
			dueDate: "2026-09-02",
			storyPoints: 1,
		};
		const fields = buildJiraSubtaskFields("SPDBK-123", draft.summary, {
			...draft,
			startDateFieldId: "customfield_11200",
			storyPointsFieldId: "customfield_10100",
		});
		const plan = buildJiraSubtaskWritePlan(
			fields,
			draft,
			"customfield_10100",
		);
		expect(plan.createFields).toMatchObject({
			duedate: "2026-09-02",
			customfield_27662: 1,
			customfield_23500: { id: "37004" },
		});
		expect(plan.updateFields).not.toHaveProperty("duedate");
		expect(plan.updateFields).not.toHaveProperty("customfield_10100");

		const fallback = buildJiraSubtaskWritePlan(
			fields,
			draft,
			"customfield_10100",
			"deferred",
		);
		expect(fallback.createFields).not.toHaveProperty("customfield_27662");
		expect(fallback.createFields).not.toHaveProperty("customfield_23500");
		expect(fallback.updateFields).toMatchObject({
			duedate: "2026-09-02",
			customfield_11200: "2026-09-01",
			customfield_10100: 1,
		});

		const requiredOnCreate = buildJiraSubtaskWritePlan(
			fields,
			draft,
			"customfield_10100",
			"storyPointsCreate",
			"customfield_11200",
		);
		expect(requiredOnCreate.createFields).toMatchObject({
			duedate: "2026-09-02",
			customfield_11200: "2026-09-01",
			customfield_10100: 1,
		});
		expect(requiredOnCreate.updateFields).not.toHaveProperty("duedate");
		expect(requiredOnCreate.updateFields).not.toHaveProperty("customfield_11200");
		expect(requiredOnCreate.updateFields).not.toHaveProperty("customfield_10100");
	});

	it("recognizes only explicit create-screen field rejection errors", () => {
		expect(
			isJiraCreateFieldUnavailable(
				400,
				`{"errors":{"customfield_27662":"Field 'customfield_27662' cannot be set. It is not on the appropriate screen, or unknown."}}`,
				"customfield_27662",
			),
		).toBe(true);
		expect(isJiraCreateFieldUnavailable(401, "Login Required", "customfield_27662")).toBe(
			false,
		);
		expect(isJiraCreateFieldUnavailable(400, "Due Date is required", "customfield_27662")).toBe(
			false,
		);
	});

	it("distinguishes Estimated and regular create-time planning requirements", () => {
		expect(
			isJiraEstimatedStoryPointsRequired(
				400,
				"Estimated Story Points is required; Due Date is required; Sub-task Type is required",
			),
		).toBe(true);
		expect(
			isJiraRegularPlanningFieldsRequired(
				400,
				"Please fill in Story Points.; Please fill in Start Date.; Please fill in Due Date.",
			),
		).toBe(true);
		expect(
			isJiraRegularPlanningFieldsRequired(
				400,
				"Estimated Story Points is required; Start Date is required; Due Date is required",
			),
		).toBe(false);
	});

	it("selects the planning mode from Jira's real Sub-task Create screen", () => {
		expect(
			selectJiraSubtaskPlanningMode(
				["customfield_10100", "customfield_11200", "duedate"],
				"customfield_10100",
			),
		).toBe("storyPointsCreate");
		expect(
			selectJiraSubtaskPlanningMode(
				["customfield_27662", "customfield_11200", "duedate"],
				"customfield_10100",
			),
		).toBe("estimated");
		expect(selectJiraSubtaskPlanningMode(["summary"], "customfield_10100")).toBe(
			"deferred",
		);
		expect(
			selectJiraSubtaskPlanningMode(
				["customfield_10100", "customfield_11200", "duedate"],
				["customfield_27662", "customfield_10100"],
			),
		).toBe("storyPointsCreate");
	});

	it("rejects an invalid parent or blank summary", () => {
		expect(() => buildJiraSubtaskFields("APP", "Work")).toThrow();
		expect(() => buildJiraSubtaskFields("APP-1", "   ")).toThrow();
	});
});

describe("Jira sub-task capacity", () => {
	it("uses Monday through Friday for the selected date's week", () => {
		expect(jiraWorkWeekRange("2026-09-02")).toEqual({
			startDate: "2026-08-31",
			dueDate: "2026-09-04",
		});
		expect(jiraWorkWeekRange("2026-09-06")).toEqual({
			startDate: "2026-08-31",
			dueDate: "2026-09-04",
		});
	});

	it("discovers the Story Points field", () => {
		expect(
			discoverStoryPointsFieldId([
				{ id: "summary", name: "Summary" },
				{ id: "customfield_10016", name: "Story Points" },
			]),
		).toBe("customfield_10016");
		expect(
			discoverStoryPointsFieldId([
				{ id: "customfield_1", name: "Story Points" },
				{
					id: "customfield_2",
					name: "Story Point",
					schema: { custom: "com.example:story-points" },
				},
			]),
		).toBe("customfield_2");
		expect(
			discoverStoryPointsFieldIds([
				{ id: "customfield_1", name: "Story Points" },
				{
					id: "customfield_2",
					name: "Story Points",
					schema: { custom: "com.pyxis.greenhopper.jira:jsw-story-points" },
				},
			]),
		).toEqual(["customfield_2", "customfield_1"]);
		expect(
			discoverStoryPointsFieldIds([
				{ id: "customfield_10100", name: "Story Points" },
				{ id: "customfield_27662", name: "Estimated Story Points" },
			]),
		).toContain("customfield_27662");
	});

	it("validates dates and daily story points", () => {
		const valid = {
			category: "test" as const,
			subtaskType: "feature" as const,
			summary: "Regression",
			assignee: "shengjie.lin@npt.sg",
			startDate: "2026-09-01",
			dueDate: "2026-09-01",
			storyPoints: 1,
		};
		expect(validateJiraSubtaskDraft(valid)).toBeNull();
		expect(validateJiraSubtaskDraft({ ...valid, dueDate: "2026-08-31" })).toBe(
			"dateOrder",
		);
		expect(validateJiraSubtaskDraft({ ...valid, storyPoints: 1.5 })).toBe(
			"storyPoints",
		);
		expect(
			validateJiraSubtaskDraft({
				...valid,
				dueDate: "2026-09-02",
				storyPoints: 2,
			}),
		).toBeNull();
		expect(
			validateJiraSubtaskDraft({ ...valid, assignee: "someone.else@npt.sg" }),
		).toBe("assignee");
		expect(
			validateJiraSubtaskDraft({
				...valid,
				startDate: "2026-09-04",
				dueDate: "2026-09-07",
				storyPoints: 2,
			}),
		).toBeNull();
		expect(
			validateJiraSubtaskDraft({
				...valid,
				startDate: "2026-09-04",
				dueDate: "2026-09-06",
				storyPoints: 2,
			}),
		).toBe("storyPoints");
	});

	it("queries overlapping sub-tasks for the selected assignee", () => {
		expect(
			buildJiraCapacityJql(
				"zenan.wu@npt.sg",
				"2026-09-01",
				"2026-09-02",
				"customfield_10015",
			),
		).toBe(
			'assignee = "zenan.wu@npt.sg" AND issuetype IN subTaskIssueTypes() AND status != Closed AND ' +
				'cf[10015] <= "2026-09-02" AND duedate >= "2026-09-01"',
		);
	});

	it("excludes Closed issues from conflict and weekly shortage calculations", () => {
		const closedIssue = {
			key: "APP-closed",
			fields: {
				summary: "Closed work",
				status: { name: "Closed" },
				issuetype: { name: "Sub-task" },
				duedate: "2026-09-07",
				customfield_10015: "2026-09-07",
				customfield_10016: 1,
			},
		};
		expect(
			findJiraCapacityConflicts(
				[closedIssue],
				"customfield_10015",
				"customfield_10016",
				"2026-09-07",
				"2026-09-07",
				1,
			),
		).toEqual([]);
		expect(
			findJiraWeeklyCapacityShortages(
				[closedIssue],
				"customfield_10015",
				"customfield_10016",
				"2026-09-07",
				"2026-09-07",
				"2026-09-07",
				0,
			),
		).toContainEqual({ date: "2026-09-07", missing: 1 });
	});

	it("blocks when existing plus requested capacity exceeds one on a day", () => {
		const issues = [
			{
				key: "APP-2",
				fields: {
					summary: "Existing",
					status: { name: "Open" },
					issuetype: { name: "Sub-task" },
					duedate: "2026-09-01",
					customfield_10015: "2026-09-01",
					customfield_10016: 1,
				},
			},
		];
		expect(
			findJiraCapacityConflicts(
				issues,
				"customfield_10015",
				"customfield_10016",
				"2026-09-01",
				"2026-09-01",
				0.5,
			),
		).toEqual([{ date: "2026-09-01", existing: 1, requested: 0.5, total: 1.5 }]);
		expect(
			findJiraCapacityConflicts(
				issues,
				"customfield_10015",
				"customfield_10016",
				"2026-09-02",
				"2026-09-02",
				1,
			),
		).toEqual([]);
	});

	it("reports under-booked weekdays and excludes Saturday and Sunday", () => {
		const issues = [
			{
				key: "APP-10",
				fields: {
					summary: "Monday",
					status: { name: "Open" },
					issuetype: { name: "Sub-task" },
					duedate: "2026-08-31",
					customfield_10015: "2026-08-31",
					customfield_10016: 1,
				},
			},
			{
				key: "APP-11",
				fields: {
					summary: "Tuesday",
					status: { name: "Open" },
					issuetype: { name: "Sub-task" },
					duedate: "2026-09-01",
					customfield_10015: "2026-09-01",
					customfield_10016: 0.5,
				},
			},
		];
		expect(
			findJiraWeeklyCapacityShortages(
				issues,
				"customfield_10015",
				"customfield_10016",
				"2026-09-02",
				"2026-09-02",
				"2026-09-02",
				1,
			),
		).toEqual([
			{ date: "2026-09-01", missing: 0.5 },
			{ date: "2026-09-03", missing: 1 },
			{ date: "2026-09-04", missing: 1 },
		]);
		expect(
			findJiraWeeklyCapacityShortages(
				issues,
				"customfield_10015",
				"customfield_10016",
				"2026-09-02",
				"2026-09-02",
				"2026-09-02",
				0,
			),
		).toEqual([
			{ date: "2026-09-01", missing: 0.5 },
			{ date: "2026-09-02", missing: 1 },
			{ date: "2026-09-03", missing: 1 },
			{ date: "2026-09-04", missing: 1 },
		]);
	});

	it("distributes total Story Points across the issue's weekdays", () => {
		const issues = [
			{
				key: "APP-20",
				fields: {
					summary: "Monday and Tuesday",
					status: { name: "Done" },
					issuetype: { name: "Sub-task" },
					duedate: "2026-09-01",
					customfield_10015: "2026-08-31",
					customfield_10016: 2,
				},
			},
			{
				key: "APP-21",
				fields: {
					summary: "Wednesday and Thursday",
					status: { name: "Done" },
					issuetype: { name: "Sub-task" },
					duedate: "2026-09-03",
					customfield_10015: "2026-09-02",
					customfield_10016: 2,
				},
			},
		];
		expect(
			findJiraWeeklyCapacityShortages(
				issues,
				"customfield_10015",
				"customfield_10016",
				"2026-09-02",
				"2026-09-02",
				"2026-09-02",
				0,
			),
		).toEqual([{ date: "2026-09-04", missing: 1 }]);
	});

	it("allocates Friday work sequentially without dividing across the weekend", () => {
		const issues = [
			{
				key: "APP-30",
				fields: {
					summary: "Friday and Monday",
					status: { name: "Open" },
					issuetype: { name: "Sub-task" },
					duedate: "2026-09-08",
					customfield_10015: "2026-09-04",
					customfield_10016: 2,
				},
			},
		];
		const currentWeek = findJiraWeeklyCapacityShortages(
			issues,
			"customfield_10015",
			"customfield_10016",
			"2026-09-04",
			"2026-09-04",
			"2026-09-04",
			0,
		);
		expect(currentWeek).toEqual([
			{ date: "2026-08-31", missing: 1 },
			{ date: "2026-09-01", missing: 1 },
			{ date: "2026-09-02", missing: 1 },
			{ date: "2026-09-03", missing: 1 },
		]);
		expect(
			findJiraWeeklyCapacityShortages(
				issues,
				"customfield_10015",
				"customfield_10016",
				"2026-09-07",
				"2026-09-07",
				"2026-09-07",
				0,
			),
		).toEqual([
			{ date: "2026-09-08", missing: 1 },
			{ date: "2026-09-09", missing: 1 },
			{ date: "2026-09-10", missing: 1 },
			{ date: "2026-09-11", missing: 1 },
		]);
		expect(
			findJiraCapacityConflicts(
				[],
				"customfield_10015",
				"customfield_10016",
				"2026-09-04",
				"2026-09-08",
				2,
			),
		).toEqual([]);
	});
});

describe("Jira Done transition", () => {
	it("selects only an exact Done transition", () => {
		expect(
			selectJiraDoneTransition([
				{
					id: "121",
					name: "Icebox",
					to: { name: "Icebox", statusCategory: { key: "done" } },
				},
				{
					id: "111",
					name: "Closed",
					to: { name: "Closed", statusCategory: { key: "done" } },
				},
				{
					id: "31",
					name: "Done",
					to: { name: "Done", statusCategory: { key: "done" } },
				},
			]),
		).toMatchObject({ id: "31", name: "Done" });
	});

	it("does not fall back to Closed, Resolved, or Icebox", () => {
		expect(
			selectJiraDoneTransition([
				{ id: "11", name: "Closed", to: { name: "Closed" } },
				{ id: "21", name: "Resolved", to: { name: "Resolved" } },
				{ id: "31", name: "Icebox", to: { name: "Icebox" } },
			]),
		).toBeNull();
	});

	it("selects Doing as the only allowed intermediate state", () => {
		expect(
			selectJiraDoingTransition([
				{ id: "11", name: "Waiting", to: { name: "Waiting" } },
				{ id: "21", name: "Start work", to: { name: "Doing" } },
				{ id: "31", name: "Closed", to: { name: "Closed" } },
			]),
		).toMatchObject({ id: "21", to: { name: "Doing" } });
	});
});

describe("buildJiraUrl", () => {
	it("builds API URLs only beneath the configured host and relative API path", () => {
		expect(
			buildJiraUrl(
				"https://jira.example.com/",
				"/rest/api/latest",
				"/filter/favourite",
			).toString(),
		).toBe("https://jira.example.com/rest/api/latest/filter/favourite");
	});

	it("rejects unsupported hosts and absolute API paths", () => {
		expect(() => buildJiraUrl("file:///etc", "/rest/api/latest", "/search")).toThrow();
		expect(() =>
			buildJiraUrl("http://jira.example.com", "/rest/api/latest", "/search"),
		).toThrow();
		expect(() =>
			buildJiraUrl(
				"https://jira.example.com",
				"https://evil.example/api",
				"/search",
			),
		).toThrow();
		expect(() =>
			buildJiraUrl(
				"https://jira.example.com",
				"/rest/api/latest",
				"https://evil.example/search",
			),
		).toThrow();
	});
});

describe("Jira load coordinator", () => {
	it("runs one trailing request when a change arrives during an active load", async () => {
		const calls: string[] = [];
		let release: (() => void) | undefined;
		const first = new Promise<void>((resolve) => {
			release = resolve;
		});
		const coordinator = createJiraLoadCoordinator(async (kind: string) => {
			calls.push(kind);
			if (calls.length === 1) await first;
		});

		coordinator.request("full");
		coordinator.request("refined");
		expect(calls).toEqual(["full"]);
		release?.();
		await coordinator.idle();
		expect(calls).toEqual(["full", "refined"]);
	});

	it("drops queued work after destruction", async () => {
		let release: (() => void) | undefined;
		const first = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls: string[] = [];
		const coordinator = createJiraLoadCoordinator(async (kind: string) => {
			calls.push(kind);
			await first;
		});
		coordinator.request("full");
		coordinator.request("refined");
		coordinator.destroy();
		release?.();
		await coordinator.idle();
		expect(calls).toEqual(["full"]);
	});

	it("accepts a later request after a failed load", async () => {
		const calls: string[] = [];
		const coordinator = createJiraLoadCoordinator(async (kind: string) => {
			calls.push(kind);
			if (kind === "first") throw new Error("failed");
		});
		coordinator.request("first");
		await expect(coordinator.idle()).rejects.toThrow("failed");
		coordinator.request("second");
		await coordinator.idle();
		expect(calls).toEqual(["first", "second"]);
	});
});

function jiraCard(id: string, pat: string): DashboardCard {
	return {
		id,
		kind: "jira",
		x: 0,
		y: 0,
		w: 4,
		h: 4,
		jira: {
			host: "https://jira.example.com",
			pat,
			filterId: "10001",
			filterName: "Team work",
			maxResults: 25,
		},
	};
}

function settingsWithJira(pat: string): HomeSettings {
	return {
		...DEFAULT_SETTINGS,
		dashboards: [
			{ id: "dashboard", name: "Dashboard", cards: [jiraCard("card", pat)] },
		],
		activeDashboardId: "dashboard",
		pinnedCards: [jiraCard("pinned", pat)],
	};
}

describe("Jira export credential scrubbing", () => {
	it("excludes PATs from layout exports without mutating live settings", () => {
		const sentinel = "PAT_SENTINEL_LAYOUT";
		const settings = settingsWithJira(sentinel);
		const exported = exportLayout(settings);

		expect(exported).not.toContain(sentinel);
		expect(exported).toContain("https://jira.example.com");
		expect(exported).toContain("Team work");
		expect(settings.dashboards[0].cards[0].jira?.pat).toBe(sentinel);
		expect(settings.pinnedCards[0].jira?.pat).toBe(sentinel);
	});

	it("excludes PATs from full settings exports without mutating live settings", () => {
		const sentinel = "PAT_SENTINEL_SETTINGS";
		const settings = settingsWithJira(sentinel);
		const exported = exportSettings(settings);

		expect(exported).not.toContain(sentinel);
		expect(exported).toContain("https://jira.example.com");
		expect(exported).toContain("Team work");
		expect(settings.dashboards[0].cards[0].jira?.pat).toBe(sentinel);
		expect(settings.pinnedCards[0].jira?.pat).toBe(sentinel);
	});
});

describe("sanitizeJira", () => {
	it("allowlists and clamps a valid imported configuration", () => {
		expect(
			sanitizeJira({
				host: "https://jira.example.com/",
				pat: "secret",
				apiBasePath: "/rest/api/3",
				filterId: "10001",
				filterName: "My filter",
				showStartDate: false,
				showEndDate: true,
				sortDueDateDesc: false,
				controls: ["status", "removed-control", "invalid"],
				selections: {
					status: ["Open", 3],
					removedControl: ["Legacy value"],
					other: ["drop"],
				},
				maxResults: 9999,
				refreshMin: -4,
				cacheMin: 12,
				untrusted: "drop",
			}),
		).toEqual({
			host: "https://jira.example.com",
			pat: "secret",
			apiBasePath: "/rest/api/3",
			filterId: "10001",
			filterName: "My filter",
			showStartDate: false,
			showEndDate: true,
			sortDueDateDesc: false,
			controls: ["status"],
			selections: { status: ["Open"] },
			maxResults: 200,
			refreshMin: 0,
			cacheMin: 12,
		});
	});

	it("does not crash on malformed nested values", () => {
		expect(sanitizeJira(null)).toEqual({});
		expect(sanitizeJira({ controls: "status", selections: 42 })).toEqual({});
		expect(sanitizeJira({ selections: { status: null, removedControl: "bad" } })).toEqual({
			selections: {},
		});
	});
});
