import { describe, expect, it } from "vitest";
import { browserCookiePythonCandidates, cookieUrlForSource } from "../src/browser-cookie";

describe("social browser Cookie domains", () => {
	it("maps each source to its authenticated web origin", () => {
		expect(cookieUrlForSource("rednote")).toBe("https://www.xiaohongshu.com");
		expect(cookieUrlForSource("wechat")).toBe("https://weread.qq.com");
		expect(cookieUrlForSource("douyin")).toBe("https://www.douyin.com");
		expect(cookieUrlForSource("zhihu")).toBe("https://www.zhihu.com");
	});

	it("does not depend only on an interactive shell PATH", () => {
		expect(browserCookiePythonCandidates()).toContain("/usr/bin/python3");
		expect(browserCookiePythonCandidates()).toContain("python3");
	});
});
