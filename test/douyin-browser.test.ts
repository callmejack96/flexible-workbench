import { describe, expect, it } from "vitest";
import {
	extractDouyinFavoritesFromHtml,
	normalizeDouyinScrapeItems,
} from "../src/douyin-browser";

describe("normalizeDouyinScrapeItems", () => {
	it("builds title+link items, pulling the aweme id from the href", () => {
		expect(
			normalizeDouyinScrapeItems([
				{ href: "/video/7412345678901234567?foo=bar", title: "  A saved\nvideo  " },
			]),
		).toEqual([
			{
				id: "7412345678901234567",
				title: "A saved video",
				url: "https://www.douyin.com/video/7412345678901234567",
			},
		]);
	});

	it("dedupes by aweme id and drops entries without one", () => {
		const items = normalizeDouyinScrapeItems([
			{ href: "/video/111", title: "First" },
			{ href: "/video/111?from=list", title: "Duplicate" },
			{ href: "/user/self", title: "Not a video" },
			{ href: "/video/222", title: "Second" },
		]);
		expect(items.map((item) => item.id)).toEqual(["111", "222"]);
		expect(items[0].title).toBe("First");
	});

	it("falls back to a placeholder title when none is present", () => {
		expect(normalizeDouyinScrapeItems([{ href: "/video/333", title: "   " }])[0].title).toBe(
			"抖音收藏 333",
		);
	});

	it("caps the result at the requested limit", () => {
		const raw = Array.from({ length: 5 }, (_, i) => ({ href: `/video/${i}`, title: `t${i}` }));
		expect(normalizeDouyinScrapeItems(raw, 2)).toHaveLength(2);
	});
});

describe("extractDouyinFavoritesFromHtml", () => {
	it("reads title from the anchor's title attribute", () => {
		const html = `<div><a class="card" href="/video/900001" title="Cats &amp; dogs"><img alt="cover"/></a></div>`;
		expect(extractDouyinFavoritesFromHtml(html)).toEqual([
			{
				id: "900001",
				title: "Cats & dogs",
				url: "https://www.douyin.com/video/900001",
			},
		]);
	});

	it("falls back to an inner img alt, then to text", () => {
		const html = [
			`<a href="/video/900002"><img src="x.jpg" alt="Alt title"></a>`,
			`<a href="/video/900003"><span>Text title</span></a>`,
		].join("");
		expect(extractDouyinFavoritesFromHtml(html).map((item) => item.title)).toEqual([
			"Alt title",
			"Text title",
		]);
	});

	it("dedupes repeated cards and ignores non-video links", () => {
		const html = [
			`<a href="/video/900004" title="One"></a>`,
			`<a href="/video/900004" title="One again"></a>`,
			`<a href="/user/self" title="Profile"></a>`,
		].join("");
		const items = extractDouyinFavoritesFromHtml(html);
		expect(items).toHaveLength(1);
		expect(items[0].id).toBe("900004");
	});
});
