import { describe, expect, it } from "vitest";
import {
	DouyinFavoritesClient,
	normalizeDouyinFavoriteFolder,
	normalizeDouyinFavoriteItem,
	syncDouyinFavorites,
	walkPages,
	type DouyinHttpRequest,
} from "../src/douyin-sync";

function page(json: Record<string, unknown>, status = 200) {
	return { status, json };
}

describe("normalizeDouyinFavoriteItem", () => {
	it("keeps the useful fields and builds a share URL", () => {
		const item = normalizeDouyinFavoriteItem(
			{
				aweme_id: "123",
				desc: "A saved video",
				create_time: "1700000000",
				author: { nickname: "Alice", sec_uid: "MS4w" },
				video: { cover: { url_list: ["https://img.example/cover.jpg"] } },
			},
			{ source: "folder", folderId: "folder-1", folderName: "待整理" },
		);

		expect(item).toMatchObject({
			awemeId: "123",
			title: "A saved video",
			description: "A saved video",
			author: "Alice",
			authorSecUid: "MS4w",
			coverUrl: "https://img.example/cover.jpg",
			shareUrl: "https://www.douyin.com/video/123",
			createTime: 1700000000,
			folderIds: ["folder-1"],
			folderNames: ["待整理"],
			sources: ["folder"],
		});
		expect(item?.raw.aweme_id).toBe("123");
	});

	it("accepts the aweme_info wrapper used by some responses", () => {
		const item = normalizeDouyinFavoriteItem(
			{ aweme_info: { aweme_id: 456, title: "Wrapped" } },
			{ source: "account" },
		);
		expect(item?.awemeId).toBe("456");
		expect(item?.title).toBe("Wrapped");
	});
});

describe("normalizeDouyinFavoriteFolder", () => {
	it("normalizes nested folder metadata", () => {
		expect(
			normalizeDouyinFavoriteFolder({
				collects_info: { collects_id: "f-1", name: "旅行", video_count: "7" },
			}),
		).toMatchObject({ id: "f-1", name: "旅行", count: 7 });
	});
});

describe("syncDouyinFavorites", () => {
	it("merges account and folder pages, then deduplicates by aweme_id", async () => {
		const calls: DouyinHttpRequest[] = [];
		const transport = async (request: DouyinHttpRequest) => {
			calls.push(request);
			const url = new URL(request.url);
			const cursor = url.searchParams.get("cursor") ?? "0";

			if (request.path.endsWith("listcollection/")) {
				if (cursor === "0") {
					return page({
						status_code: 0,
						aweme_list: [
							{ aweme_id: "1", desc: "one" },
							{ aweme_id: "2", desc: "two" },
						],
						has_more: 0,
					});
				}
			}
			if (request.path.endsWith("collects/list/")) {
				return page({
					status_code: 0,
					collects_list: [{ collects_id: "f-1", name: "旅行" }],
					has_more: 0,
				});
			}
			if (request.path.endsWith("collects/video/list/")) {
				return page({
					status_code: 0,
					aweme_list: [
						{ aweme_id: "1", desc: "one" },
						{ aweme_id: "3", desc: "three" },
					],
					has_more: 0,
				});
			}
			throw new Error(`unexpected path: ${request.path}`);
		};

		const snapshot = await syncDouyinFavorites({
			cookie: "sessionid=secret; msToken=token",
			transport,
			now: () => 1700000000000,
		});

		expect(snapshot.syncedAt).toBe(1700000000000);
		expect(snapshot.items.map((item) => item.awemeId)).toEqual(["1", "2", "3"]);
		expect(snapshot.items[0]).toMatchObject({
			folderIds: ["f-1"],
			folderNames: ["旅行"],
			sources: ["account", "folder"],
		});
		expect(snapshot.counts).toEqual({
			accountItems: 2,
			folderItems: 2,
			uniqueItems: 3,
		});
		expect(snapshot.folders).toMatchObject([{ id: "f-1", name: "旅行" }]);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body).toBe("count=20&cursor=0");
		expect(calls[0].headers.Cookie).toContain("sessionid=secret");
		expect(calls[0].headers.Referer).toContain("favorite_collection");
		expect(new URL(calls[0].url).searchParams.get("msToken")).toBe("token");
	});

	it("stops a cursor walk when the server repeats the cursor", async () => {
		let calls = 0;
		const warnings: string[] = [];
		const result = await walkPages(
			async () => {
				calls++;
				return {
					items: [{ aweme_id: "1" }],
					hasMore: true,
					nextCursor: 0,
					raw: {},
				};
			},
			500,
			undefined,
			(message) => warnings.push(message),
		);

		expect(calls).toBe(1);
		expect(result.items).toHaveLength(1);
		expect(warnings[0]).toContain("cursor did not advance");
	});
});

describe("DouyinFavoritesClient errors", () => {
	it("classifies an expired login session", async () => {
		const client = new DouyinFavoritesClient({
			cookie: "sessionid=secret",
			transport: async () => page({ status_code: 2483, status_msg: "请先登录" }),
		});

		await expect(client.getUserCollection()).rejects.toMatchObject({
			name: "DouyinSyncError",
			kind: "not-logged-in",
		});
	});

	it("requires a cookie for the default Obsidian transport", () => {
		expect(() => new DouyinFavoritesClient()).toThrow(/logged-in web Cookie/);
	});
});
