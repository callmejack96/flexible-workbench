import { describe, expect, it } from "vitest";
import {
	emptyIndex,
	entryKey,
	isArchived,
	listEntries,
	normalizeIndex,
	removeEntry,
	setArchived,
	upsertEntry,
	type FavoriteSeed,
} from "../src/favorites-index";

function seed(overrides: Partial<FavoriteSeed> = {}): FavoriteSeed {
	return {
		source: "wechat",
		id: "abc",
		title: "标题",
		url: "https://mp.weixin.qq.com/s/abc",
		path: "raw/wechat/标题 - abc.md",
		syncedAt: "2026-09-06T00:00:00.000Z",
		...overrides,
	};
}

describe("entryKey", () => {
	it("joins source and id", () => {
		expect(entryKey("zhihu", "123")).toBe("zhihu:123");
	});
});

describe("upsertEntry", () => {
	it("adds a new entry as unarchived", () => {
		const data = emptyIndex();
		const entry = upsertEntry(data, seed());
		expect(entry.archived).toBe(false);
		expect(data.entries["wechat:abc"].title).toBe("标题");
	});

	it("preserves archived state on re-sync, refreshing only metadata", () => {
		const data = emptyIndex();
		upsertEntry(data, seed());
		setArchived(data, "wechat:abc", true);
		const before = data.entries["wechat:abc"].archivedAt;

		const refreshed = upsertEntry(data, seed({ title: "新标题", path: "raw/wechat/新标题 - abc.md" }));
		expect(refreshed.archived).toBe(true);
		expect(refreshed.archivedAt).toBe(before);
		expect(refreshed.title).toBe("新标题");
		expect(refreshed.path).toBe("raw/wechat/新标题 - abc.md");
	});
});

describe("setArchived / isArchived", () => {
	it("toggles the flag and stamps archivedAt only when archiving", () => {
		const data = emptyIndex();
		upsertEntry(data, seed());
		expect(isArchived(data, "wechat", "abc")).toBe(false);

		expect(setArchived(data, "wechat:abc", true)).toBe(true);
		expect(isArchived(data, "wechat", "abc")).toBe(true);
		expect(typeof data.entries["wechat:abc"].archivedAt).toBe("string");

		setArchived(data, "wechat:abc", false);
		expect(isArchived(data, "wechat", "abc")).toBe(false);
		expect(data.entries["wechat:abc"].archivedAt).toBeUndefined();
	});

	it("returns false for an unknown key", () => {
		expect(setArchived(emptyIndex(), "nope:1", true)).toBe(false);
	});

	it("isArchived defaults to false for unknown items", () => {
		expect(isArchived(emptyIndex(), "douyin", "x")).toBe(false);
	});
});

describe("listEntries", () => {
	const build = () => {
		const data = emptyIndex();
		upsertEntry(data, seed({ source: "wechat", id: "w1" }));
		upsertEntry(data, seed({ source: "wechat", id: "w2" }));
		upsertEntry(data, seed({ source: "zhihu", id: "z1" }));
		setArchived(data, "wechat:w1", true);
		return data;
	};

	it("filters by source", () => {
		expect(listEntries(build(), { source: "wechat" })).toHaveLength(2);
		expect(listEntries(build(), { source: "zhihu" })).toHaveLength(1);
	});

	it("filters by archived state", () => {
		expect(listEntries(build(), { archived: true })).toHaveLength(1);
		expect(listEntries(build(), { archived: false })).toHaveLength(2);
	});

	it("filters by both", () => {
		expect(listEntries(build(), { source: "wechat", archived: false })).toHaveLength(1);
	});

	it("returns everything with no filter", () => {
		expect(listEntries(build())).toHaveLength(3);
	});
});

describe("removeEntry", () => {
	it("drops a known entry and reports unknown ones", () => {
		const data = emptyIndex();
		upsertEntry(data, seed());
		expect(removeEntry(data, "wechat:abc")).toBe(true);
		expect(data.entries["wechat:abc"]).toBeUndefined();
		expect(removeEntry(data, "wechat:abc")).toBe(false);
	});
});

describe("normalizeIndex", () => {
	it("returns an empty index for junk input", () => {
		expect(normalizeIndex(null)).toEqual(emptyIndex());
		expect(normalizeIndex("nope")).toEqual(emptyIndex());
		expect(normalizeIndex({ entries: 42 })).toEqual(emptyIndex());
	});

	it("keeps well-formed entries and drops malformed ones", () => {
		const data = normalizeIndex({
			version: 1,
			entries: {
				"wechat:a": { source: "wechat", id: "a", title: "T", url: "u", path: "p", syncedAt: "s", archived: true, archivedAt: "t" },
				"bad:1": { id: "" },
				"bad:2": "not an object",
			},
		});
		expect(Object.keys(data.entries)).toEqual(["wechat:a"]);
		expect(data.entries["wechat:a"].archived).toBe(true);
		expect(data.entries["wechat:a"].archivedAt).toBe("t");
	});

	it("defaults archived to false and omits archivedAt when absent", () => {
		const data = normalizeIndex({
			entries: { "zhihu:z": { source: "zhihu", id: "z", title: "T" } },
		});
		expect(data.entries["zhihu:z"].archived).toBe(false);
		expect(data.entries["zhihu:z"].archivedAt).toBeUndefined();
	});
});
