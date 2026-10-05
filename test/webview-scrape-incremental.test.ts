import { describe, expect, it } from "vitest";
import { countNewIds, type ScrapeCandidate } from "../src/webview-scraper";

/** Simple id extractor: the digits after "/x/". */
const idFromHref = (href: string): string | null => /\/x\/(\d+)/.exec(href)?.[1] ?? null;

function candidate(href: string): ScrapeCandidate {
	return { href, title: "" };
}

describe("countNewIds", () => {
	it("counts distinct ids when nothing is known", () => {
		const list = ["/x/1", "/x/2", "/x/3"].map(candidate);
		expect(countNewIds(list, new Set(), idFromHref)).toBe(3);
	});

	it("dedupes ids that appear more than once (cover + title links)", () => {
		const list = ["/x/1", "/x/1", "/x/2"].map(candidate);
		expect(countNewIds(list, new Set(), idFromHref)).toBe(2);
	});

	it("excludes ids already in the vault", () => {
		const list = ["/x/1", "/x/2", "/x/3"].map(candidate);
		expect(countNewIds(list, new Set(["1", "3"]), idFromHref)).toBe(1);
	});

	it("returns 0 once every id is known (the early-stop signal)", () => {
		const list = ["/x/1", "/x/2"].map(candidate);
		expect(countNewIds(list, new Set(["1", "2"]), idFromHref)).toBe(0);
	});

	it("ignores hrefs without an extractable id", () => {
		const list = ["/x/1", "/other", "notaurl"].map(candidate);
		expect(countNewIds(list, new Set(), idFromHref)).toBe(1);
	});
});
