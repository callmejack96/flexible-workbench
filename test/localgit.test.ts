import { describe, expect, it } from "vitest";
import { parsePorcelainV2 } from "../src/localgit";

describe("parsePorcelainV2", () => {
	it("reads branch divergence and all working-tree groups", () => {
		const parsed = parsePorcelainV2([
			"# branch.oid 0123456789",
			"# branch.head feature/dashboard",
			"# branch.upstream origin/feature/dashboard",
			"# branch.ab +2 -3",
			"1 M. N... 100644 100644 100644 abc abc staged.md",
			"1 .M N... 100644 100644 100644 abc abc dirty.md",
			"2 R. N... 100644 100644 100644 abc abc R100 new.md\told.md",
			"? untracked.md",
			"u UU N... 100644 100644 100644 100644 abc abc abc conflict.md",
		].join("\n"));

		expect(parsed).toEqual({
			branch: "feature/dashboard",
			upstream: "origin/feature/dashboard",
			ahead: 2,
			behind: 3,
			changed: 5,
			staged: 2,
			untracked: 1,
			conflicted: 1,
		});
	});

	it("handles a clean detached head without inventing an upstream", () => {
		expect(parsePorcelainV2("# branch.oid abc\n# branch.head (detached)\n")).toEqual({
			branch: "HEAD",
			upstream: undefined,
			ahead: 0,
			behind: 0,
			changed: 0,
			staged: 0,
			untracked: 0,
			conflicted: 0,
		});
	});
});
