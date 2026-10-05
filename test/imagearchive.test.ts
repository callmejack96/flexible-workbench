import { describe, expect, it } from "vitest";
import { collectStrayImages, isUnder, nextAvailablePath } from "../src/imagearchive";

describe("isUnder", () => {
	it("matches the folder itself and its descendants", () => {
		expect(isUnder("archive/image/a.png", "archive/image")).toBe(true);
		expect(isUnder("archive/image", "archive/image")).toBe(true);
		expect(isUnder("archive/imageX/a.png", "archive/image")).toBe(false);
		expect(isUnder("notes/a.png", "archive/image")).toBe(false);
		expect(isUnder("notes/a.png", "")).toBe(false);
	});
});

describe("collectStrayImages", () => {
	const files = [
		{ path: "notes/pic.png" },
		{ path: "assets/photo.JPG" },
		{ path: "notes/readme.md" },
		{ path: "archive/image/already.png" },
		{ path: "archive/old/legacy.gif" },
		{ path: "diagram.canvas" },
		{ path: "sub/dir/shot.webp" },
	];

	it("keeps only loose images, excluding the target and the whole archive tree", () => {
		const stray = collectStrayImages(files, "archive/image").map((f) => f.path);
		expect(stray).toEqual(["notes/pic.png", "assets/photo.JPG", "sub/dir/shot.webp"]);
	});

	it("is case-insensitive on extensions and skips non-images", () => {
		const stray = collectStrayImages([{ path: "a.PNG" }, { path: "b.txt" }], "archive/image");
		expect(stray.map((f) => f.path)).toEqual(["a.PNG"]);
	});

	it("excludes a custom target folder too", () => {
		const stray = collectStrayImages([{ path: "media/x.png" }, { path: "notes/y.png" }], "media");
		expect(stray.map((f) => f.path)).toEqual(["notes/y.png"]);
	});
});

describe("nextAvailablePath", () => {
	it("uses the plain name when free", () => {
		expect(nextAvailablePath("archive/image", "a.png", () => false)).toBe("archive/image/a.png");
	});

	it("appends -1 before the extension on a collision", () => {
		const exists = (p: string): boolean => p === "archive/image/a.png";
		expect(nextAvailablePath("archive/image", "a.png", exists)).toBe("archive/image/a-1.png");
	});

	it("increments until a free slot is found", () => {
		const used = new Set(["archive/image/a.png", "archive/image/a-1.png", "archive/image/a-2.png"]);
		expect(nextAvailablePath("archive/image", "a.png", (p) => used.has(p))).toBe("archive/image/a-3.png");
	});

	it("handles names without an extension", () => {
		const exists = (p: string): boolean => p === "archive/image/LICENSE";
		expect(nextAvailablePath("archive/image", "LICENSE", exists)).toBe("archive/image/LICENSE-1");
	});
});
