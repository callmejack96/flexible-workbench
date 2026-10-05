import { describe, expect, it } from "vitest";
import { exportLayout, exportSettings, sanitizeSocial } from "../src/layout";
import { DEFAULT_SETTINGS, type DashboardCard, type HomeSettings } from "../src/types";

function socialCard(id: string, credential: string): DashboardCard {
	return {
		id,
		kind: "social",
		x: 0,
		y: 0,
		w: 8,
		h: 5,
		social: {
			rednoteFolder: "raw/red",
			wechatFolder: "raw/wechat",
			douyinFolder: "raw/douyin",
			zhihuFolder: "raw/zhihu",
			credentials: { rednote: credential, wechat: credential, douyin: credential, zhihu: credential },
		},
	};
}

function settings(credential: string): HomeSettings {
	return {
		...DEFAULT_SETTINGS,
		dashboards: [{ id: "dashboard", name: "Dashboard", cards: [socialCard("card", credential)] }],
		activeDashboardId: "dashboard",
		pinnedCards: [socialCard("pinned", credential)],
	};
}

describe("social favorites credentials", () => {
	it("scrubs every platform credential from portable exports without mutating live settings", () => {
		const sentinel = "SOCIAL_CREDENTIAL_SENTINEL";
		const live = settings(sentinel);
		expect(exportLayout(live)).not.toContain(sentinel);
		expect(exportSettings(live)).not.toContain(sentinel);
		expect(live.dashboards[0].cards[0].social?.credentials?.rednote).toBe(sentinel);
		expect(live.pinnedCards[0].social?.credentials?.zhihu).toBe(sentinel);
	});

	it("allowlists folders, source, limit and credentials on import", () => {
		expect(sanitizeSocial({
			initialSource: "douyin",
			rednoteFolder: "r",
			wechatFolder: "w",
			douyinFolder: "d",
			zhihuFolder: "z",
			itemLimit: 999,
			credentials: { rednote: "a", wechat: "b", unknown: "drop" },
		})).toEqual({
			initialSource: "douyin",
			rednoteFolder: "r",
			wechatFolder: "w",
			douyinFolder: "d",
			zhihuFolder: "z",
			itemLimit: 100,
			credentials: { rednote: "a", wechat: "b" },
		});
	});
});
