import { describe, expect, it } from "vitest";
import { pickKnowledgeBase, splitImaCredential } from "../src/ima-favorites";

describe("splitImaCredential", () => {
	it("splits clientId:apiKey", () => {
		expect(splitImaCredential("cid123:key456")).toEqual({
			clientId: "cid123",
			apiKey: "key456",
			kbSelector: "",
		});
	});

	it("accepts an optional KB selector as the third part, keeping ':' inside it", () => {
		expect(splitImaCredential("cid:key:My KB")).toEqual({
			clientId: "cid",
			apiKey: "key",
			kbSelector: "My KB",
		});
		expect(splitImaCredential("cid:key:a:b").kbSelector).toBe("a:b");
	});

	it("trims and tolerates missing parts", () => {
		expect(splitImaCredential("  cid  ")).toEqual({ clientId: "cid", apiKey: "", kbSelector: "" });
		expect(splitImaCredential("")).toEqual({ clientId: "", apiKey: "", kbSelector: "" });
	});
});

describe("pickKnowledgeBase", () => {
	const bases = [
		{ id: "kb1", name: "公众号收藏" },
		{ id: "kb2", name: "工作资料" },
	];

	it("matches an exact id first", () => {
		expect(pickKnowledgeBase(bases, "kb2")?.id).toBe("kb2");
	});

	it("matches an exact name, then a name substring", () => {
		expect(pickKnowledgeBase(bases, "工作资料")?.id).toBe("kb2");
		expect(pickKnowledgeBase(bases, "公众号")?.id).toBe("kb1");
	});

	it("defaults to the first base when no selector is given", () => {
		expect(pickKnowledgeBase(bases, "")?.id).toBe("kb1");
	});

	it("returns undefined for an empty list", () => {
		expect(pickKnowledgeBase([], "anything")).toBeUndefined();
	});
});
