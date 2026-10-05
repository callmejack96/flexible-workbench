/**
 * Scan for "stray" image files and move them into an archive folder WITHOUT
 * breaking links.
 *
 * The only link-safe move in Obsidian is `app.fileManager.renameFile(file, dest)`
 * — it rewrites every `![[img]]` / `![](img)` reference (in notes and canvases)
 * to the new path. `vault.rename` would move the bytes but leave the links
 * dangling, so it must not be used here.
 */
import { normalizePath, type App, type Vault } from "obsidian";
import { isImagePath } from "./filetypes";

export const DEFAULT_IMAGE_ARCHIVE_FOLDER = "archive/image";
/** The top-level archive tree is always skipped so re-runs never churn already
 * filed images, whatever the (configurable) target folder is set to. */
const ARCHIVE_ROOT = "archive";

export interface ArchiveResult {
	scanned: number;
	moved: number;
	failed: number;
}

/** Whether `path` is `folder` itself or lives anywhere beneath it. */
export function isUnder(path: string, folder: string): boolean {
	if (!folder) return false;
	return path === folder || path.startsWith(`${folder}/`);
}

/** Image files that are loose in the vault — i.e. not already under the target
 * folder nor anywhere in the `archive/` tree. Generic over the file shape so it
 * is unit-testable with plain `{ path }` objects, and works on real `TFile`s. */
export function collectStrayImages<T extends { path: string }>(files: T[], targetFolder: string): T[] {
	const target = normalizePath(targetFolder);
	return files.filter(
		(file) => isImagePath(file.path) && !isUnder(file.path, target) && !isUnder(file.path, ARCHIVE_ROOT),
	);
}

/** A destination path in `folder` for `name` that no existing file occupies:
 * `name.png`, else `name-1.png`, `name-2.png`… `exists` is injected so the same
 * logic covers both on-disk files and names already claimed earlier in a batch. */
export function nextAvailablePath(folder: string, name: string, exists: (path: string) => boolean): string {
	const base = normalizePath(`${folder}/${name}`);
	if (!exists(base)) return base;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	for (let i = 1; ; i++) {
		const candidate = normalizePath(`${folder}/${stem}-${i}${ext}`);
		if (!exists(candidate)) return candidate;
	}
}

async function ensureFolder(vault: Vault, folder: string): Promise<void> {
	const parts = normalizePath(folder).split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
	}
}

/** Count loose images without moving anything (drives the card's summary). */
export function countStrayImages(app: App, targetFolder: string): number {
	return collectStrayImages(app.vault.getFiles(), normalizePath(targetFolder)).length;
}

/** Move every stray image into `targetFolder`, updating links as it goes. A
 * single failed move is logged and counted, never aborting the rest. */
export async function archiveStrayImages(app: App, targetFolder: string): Promise<ArchiveResult> {
	const folder = normalizePath(targetFolder);
	const stray = collectStrayImages(app.vault.getFiles(), folder);
	if (stray.length === 0) return { scanned: 0, moved: 0, failed: 0 };

	await ensureFolder(app.vault, folder);
	const taken = new Set<string>();
	const exists = (path: string): boolean => taken.has(path) || app.vault.getAbstractFileByPath(path) !== null;

	let moved = 0;
	let failed = 0;
	for (const file of stray) {
		const dest = nextAvailablePath(folder, file.name, exists);
		taken.add(dest);
		try {
			await app.fileManager.renameFile(file, dest);
			moved++;
		} catch (error) {
			console.error("Flexible Workbench: failed to move image", file.path, error);
			failed++;
		}
	}
	return { scanned: stray.length, moved, failed };
}
