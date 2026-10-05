import { describe, expect, it } from "vitest";
import { cleanVaultFolder, isKnowledgeLogPending, parseKnowledgeTranscript } from "../src/knowledge";

describe("Knowledge Workbench helpers", () => {
	it("normalizes vault folders without allowing parent traversal", () => {
		expect(cleanVaultFolder(" /Notes\\Inbox/../Capture/ ")).toBe("Notes/Inbox/Capture");
	});

	it("reads Codex JSONL messages and ignores tool operation payloads", () => {
		const transcript = [
			JSON.stringify({ type: "session_meta", payload: { id: "session-1" } }),
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review the capture flow" }] } }),
			JSON.stringify({ type: "response_item", payload: { type: "command_execution", command: "npm test" } }),
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The capture flow saves Markdown." }] } }),
		].join("\n");

		expect(parseKnowledgeTranscript(transcript)).toEqual([
			{ role: "user", text: "Review the capture flow" },
			{ role: "assistant", text: "The capture flow saves Markdown." },
		]);
	});

	it("reads Claude Code user and assistant messages while skipping tool results", () => {
		const transcript = [
			JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Summarize this change" }] } }),
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }, { type: "text", text: "The change adds log review." }] } }),
			"not json",
		].join("\n");

		expect(parseKnowledgeTranscript(transcript)).toEqual([
			{ role: "user", text: "Summarize this change" },
			{ role: "assistant", text: "The change adds log review." },
		]);
	});

	it("treats pre-baseline logs as historical and later edits as pending", () => {
		const entry = {
			path: "/logs/session.jsonl",
			provider: "codex" as const,
			modifiedAt: 250,
			size: 100,
			title: "Session",
			preview: "",
		};
		expect(isKnowledgeLogPending({ ...entry, modifiedAt: 150 }, {}, 200)).toBe(false);
		expect(isKnowledgeLogPending(entry, {}, 200)).toBe(true);
		expect(isKnowledgeLogPending(entry, { [entry.path]: 250 }, 200)).toBe(false);
		expect(isKnowledgeLogPending({ ...entry, modifiedAt: 300 }, { [entry.path]: 250 }, 200)).toBe(true);
	});

	it("treats every existing log as pending when the review baseline is reset", () => {
		const entry = {
			path: "/logs/old-session.jsonl",
			provider: "codex" as const,
			modifiedAt: 1,
			size: 100,
			title: "Older session",
			preview: "",
		};
		expect(isKnowledgeLogPending(entry, {}, 0)).toBe(true);
	});
});
