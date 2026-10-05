import { Platform } from "obsidian";
import type { SocialSource } from "./types";

const COOKIE_URLS: Record<SocialSource, string> = {
	rednote: "https://www.xiaohongshu.com",
	wechat: "https://weread.qq.com",
	douyin: "https://www.douyin.com",
	zhihu: "https://www.zhihu.com",
	bilibili: "https://www.bilibili.com",
};

export function cookieUrlForSource(source: SocialSource): string {
	return COOKIE_URLS[source];
}

/** Desktop apps launched from Finder do not inherit the user's interactive
 * shell PATH. Try stable system/package-manager locations before PATH. */
export function browserCookiePythonCandidates(): string[] {
	return [
		"/usr/bin/python3",
		"/opt/homebrew/bin/python3",
		"/usr/local/bin/python3",
		"python3",
	];
}

const PYTHON_COOKIE_READER = String.raw`
import pathlib, sys

try:
    from pycookiecheat import chrome_cookies
except Exception:
    sys.stderr.write("pycookiecheat is not installed")
    raise SystemExit(3)

url = sys.argv[1]
home = pathlib.Path.home()
roots = [
    home / "Library/Application Support/Google/Chrome",
    home / "Library/Application Support/BraveSoftware/Brave-Browser",
    home / "Library/Application Support/Microsoft Edge",
    home / "Library/Application Support/Arc/User Data",
    home / ".config/google-chrome",
    home / ".config/chromium",
    home / ".config/BraveSoftware/Brave-Browser",
    home / ".config/microsoft-edge",
]

files = []
for root in roots:
    if not root.exists():
        continue
    profiles = [root / "Default", root / "System Profile", root / "Guest Profile"]
    profiles.extend(root.glob("Profile *"))
    for profile in profiles:
        for rel in ("Network/Cookies", "Cookies"):
            candidate = profile / rel
            if candidate.exists():
                files.append(candidate)

files.sort(key=lambda path: path.stat().st_mtime, reverse=True)
for cookie_file in files:
    try:
        cookies = chrome_cookies(url, cookie_file=str(cookie_file))
        if not isinstance(cookies, dict) or not cookies:
            continue
        value = "; ".join(f"{key}={val}" for key, val in cookies.items())
        if value:
            sys.stdout.write(value)
            raise SystemExit(0)
    except SystemExit:
        raise
    except Exception:
        continue

sys.stderr.write("no logged-in browser cookies found")
raise SystemExit(4)
`;

/** Read the user's own logged-in Chromium cookies through macOS/Linux browser
 * profiles. The value is returned only to the caller and never logged. */
export async function extractBrowserCookie(source: SocialSource): Promise<string> {
	if (!Platform.isDesktopApp) throw new Error("Browser Cookie detection is desktop-only");
	// Obsidian bundles community plugins as CommonJS. A native dynamic `import()`
	// is handled by Electron's renderer loader and may try to fetch the Node
	// builtin as a browser module (`Failed to fetch dynamically imported module`).
	// Resolve it through the CommonJS loader only when desktop auto-detection is
	// actually requested, keeping the browser/mobile path free of Node imports.
	const loadNode = (globalThis as typeof globalThis & { require?: NodeRequire }).require;
	if (!loadNode) throw new Error("Node module loader is unavailable");
	const { execFile } = loadNode("node:child_process") as typeof import("node:child_process");
	let sawInstalledReader = false;
	for (const python of browserCookiePythonCandidates()) {
		const result = await new Promise<{ cookie?: string; missingReader?: boolean }>((resolve) => {
			execFile(
				python,
				["-c", PYTHON_COOKIE_READER, cookieUrlForSource(source)],
				{ encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
				(error, stdout, stderr) => {
					const value = stdout.trim();
					if (!error && value) resolve({ cookie: value });
					else resolve({ missingReader: stderr.includes("pycookiecheat is not installed") });
				},
			);
		});
		if (result.cookie) return result.cookie;
		if (!result.missingReader) sawInstalledReader = true;
	}
	if (!sawInstalledReader) throw new Error("Cookie reader is not available to Obsidian");
	throw new Error("No logged-in browser Cookie was found");
}
