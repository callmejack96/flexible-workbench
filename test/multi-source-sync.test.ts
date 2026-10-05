import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const vendorDir = path.join(root, "vendor", "multi-source-sync");

describe("embedded Source Sync artifact", () => {
	it("keeps the plugin bundle but strips machine-specific cookie bootstrap code", () => {
		const bundle = fs.readFileSync(path.join(vendorDir, "main.js"), "utf8");

		expect(bundle.startsWith("const __mssMinimalSettings=")).toBe(true);
		expect(bundle).not.toContain("__mssRefreshChromeSession");
		expect(bundle).not.toContain("LSJ_test");
		expect(bundle).not.toMatch(/web_session=[0-9a-f]{32}/i);
		expect(bundle).not.toMatch(/id_token=[A-Za-z0-9+/]{24,}/);
	});

	it("ships the imported settings styles exactly once", () => {
		const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

		expect(css.match(/BEGIN embedded multi-source-sync styles/g)).toHaveLength(1);
		expect(css.match(/END embedded multi-source-sync styles/g)).toHaveLength(1);
		expect(css).toContain(".mss-settings");
	});

	it("records the imported source version", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(vendorDir, "source-manifest.json"), "utf8"),
		) as { id: string; version: string };

		expect(manifest.id).toBe("multi-source-sync");
		expect(manifest.version).toBe("0.3.11-chrome-session-v2-favorites");
	});
});
