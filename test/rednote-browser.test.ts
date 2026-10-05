import { describe, expect, it } from "vitest";
import {
	extractRednoteFavoritesFromHtml,
	normalizeRednoteScrapeItems,
} from "../src/rednote-browser";

describe("normalizeRednoteScrapeItems", () => {
	it("keeps the full href (with xsec_token) and pulls the note id", () => {
		expect(
			normalizeRednoteScrapeItems([
				{
					href: "https://www.xiaohongshu.com/explore/64a291370000000031008c04?xsec_token=ABC=&xsec_source=pc_user",
					title: "  My note  ",
				},
			]),
		).toEqual([
			{
				id: "64a291370000000031008c04",
				title: "My note",
				url: "https://www.xiaohongshu.com/explore/64a291370000000031008c04?xsec_token=ABC=&xsec_source=pc_user",
			},
		]);
	});

	it("makes relative hrefs absolute and handles /discovery/item/", () => {
		const items = normalizeRednoteScrapeItems([
			{ href: "/discovery/item/abc123?xsec_token=T1", title: "Rel" },
		]);
		expect(items[0].url).toBe("https://www.xiaohongshu.com/discovery/item/abc123?xsec_token=T1");
		expect(items[0].id).toBe("abc123");
	});

	it("dedupes by note id and applies the limit", () => {
		const items = normalizeRednoteScrapeItems(
			[
				{ href: "/explore/n1?xsec_token=a", title: "one" },
				{ href: "/explore/n1?xsec_token=b", title: "dup" },
				{ href: "/explore/n2?xsec_token=c", title: "two" },
				{ href: "/explore/n3?xsec_token=d", title: "three" },
			],
			2,
		);
		expect(items.map((item) => item.id)).toEqual(["n1", "n2"]);
	});

	it("falls back to a placeholder title", () => {
		expect(normalizeRednoteScrapeItems([{ href: "/explore/n9?xsec_token=z", title: "" }])[0].title).toBe(
			"小红书收藏 n9",
		);
	});

	it("fills the title from the title-link when the cover-link (seen first) has none", () => {
		const items = normalizeRednoteScrapeItems([
			{ href: "/explore/n5?xsec_token=a", title: "" }, // cover link, no text
			{ href: "/explore/n5?xsec_token=a", title: "真正的标题" }, // title link
		]);
		expect(items).toHaveLength(1);
		expect(items[0].title).toBe("真正的标题");
	});

	it("prefers the href that carries an xsec_token", () => {
		const items = normalizeRednoteScrapeItems([
			{ href: "/explore/n6", title: "标题" }, // no token
			{ href: "/explore/n6?xsec_token=tok", title: "标题" },
		]);
		expect(items[0].url).toBe("https://www.xiaohongshu.com/explore/n6?xsec_token=tok");
	});
});

describe("extractRednoteFavoritesFromHtml", () => {
	it("reads note links and titles from markup, decoding entities in the href", () => {
		const html =
			`<a href="/explore/900001?xsec_token=AA&amp;xsec_source=pc_user" title="Hello"><img alt="cover"></a>`;
		expect(extractRednoteFavoritesFromHtml(html)).toEqual([
			{
				id: "900001",
				title: "Hello",
				url: "https://www.xiaohongshu.com/explore/900001?xsec_token=AA&xsec_source=pc_user",
			},
		]);
	});

	it("ignores anchors that are not note links", () => {
		const html = [
			`<a href="/explore/900002?xsec_token=T"><img alt="A"></a>`,
			`<a href="/user/profile/xyz">Profile</a>`,
		].join("");
		const items = extractRednoteFavoritesFromHtml(html);
		expect(items).toHaveLength(1);
		expect(items[0].id).toBe("900002");
	});
});
