/** One local repository pinned to the Git dashboard overview. */
export interface LocalGitRepository {
	id: string;
	/** Optional display name. The folder name is used when omitted. */
	name?: string;
	/** Absolute path to the repository on this device. */
	path: string;
	/** Optional vault-relative note opened by the row's Details button. */
	obsidianPath?: string;
}

/** Read-only repository health used by the multi-repository dashboard. */
export interface LocalGitSnapshot {
	id: string;
	name: string;
	path: string;
	branch?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	changed: number;
	staged: number;
	untracked: number;
	conflicted: number;
	lastCommit?: number;
	error?: "desktopOnly" | "invalidPath" | "notRepository" | "unavailable";
}

export interface ParsedPorcelainStatus {
	branch?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	changed: number;
	staged: number;
	untracked: number;
	conflicted: number;
}

/**
 * Parse `git status --porcelain=v2 --branch`. Kept pure so unusual filenames,
 * detached HEADs and upstream counts can be tested without invoking git.
 */
export function parsePorcelainV2(raw: string): ParsedPorcelainStatus {
	const parsed: ParsedPorcelainStatus = {
		ahead: 0,
		behind: 0,
		changed: 0,
		staged: 0,
		untracked: 0,
		conflicted: 0,
	};
	for (const line of raw.split(/\r?\n/)) {
		if (line.startsWith("# branch.head ")) {
			const branch = line.slice("# branch.head ".length).trim();
			parsed.branch = branch === "(detached)" ? "HEAD" : branch;
			continue;
		}
		if (line.startsWith("# branch.upstream ")) {
			parsed.upstream = line.slice("# branch.upstream ".length).trim() || undefined;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/\+(\d+)\s+-(\d+)/);
			if (match) {
				parsed.ahead = Number(match[1]);
				parsed.behind = Number(match[2]);
			}
			continue;
		}
		if (line.startsWith("? ")) {
			parsed.changed++;
			parsed.untracked++;
			continue;
		}
		if (line.startsWith("u ")) {
			parsed.changed++;
			parsed.conflicted++;
			continue;
		}
		if (!line.startsWith("1 ") && !line.startsWith("2 ")) continue;
		const xy = line.slice(2, 4);
		parsed.changed++;
		if (xy[0] && xy[0] !== ".") parsed.staged++;
	}
	return parsed;
}

function safeName(repo: LocalGitRepository): string {
	const path = repo.path.trim().replace(/[\\/]+$/, "");
	return repo.name?.trim() || path.split(/[\\/]/).pop() || path;
}

function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

async function runGit(cwd: string, args: string[], maxBuffer: number): Promise<string> {
	// Obsidian bundles community plugins as CommonJS. A native dynamic `import()`
	// works under plain Node but can be rejected by Electron's renderer loader;
	// a guarded, lazy require is the supported desktop-plugin path.
	const loadNode = (globalThis as typeof globalThis & { require?: NodeRequire }).require;
	if (!loadNode) throw new Error("Node module loader is unavailable");
	const { execFile } = loadNode("node:child_process") as typeof import("node:child_process");
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: 8000, maxBuffer, encoding: "utf8" },
			(err, stdout) => (err ? reject(new Error(err.message)) : resolve(stdout)),
		);
	});
}

/** The three UAT targets intentionally mirror the user's local npt/live layout.
 * This is a write operation, unlike the dashboard's ordinary status reads. */
const NPT_SYNC_TARGETS = [
	{ name: "warehouse_id", branch: "feature/npt_uat1" },
	{ name: "warehouse_ph", branch: "feature/init" },
	{ name: "warehouse_sg", branch: "feature/npt_uat1" },
] as const;

export interface NptSyncResult {
	name: string;
	ok: boolean;
	detail: string;
}

function commandError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim();
}

/**
 * Merge the live repository's *tracked remote branch* into its matching npt
 * UAT branch. If the merge conflicts, `--theirs` means the live branch wins.
 * The function deliberately never force-pushes and refuses a dirty npt tree.
 */
async function syncOneNptRepository(
	target: (typeof NPT_SYNC_TARGETS)[number],
): Promise<NptSyncResult> {
	const nptDir = `/Users/shengjie.lin/Desktop/npt/${target.name}`;
	const liveDir = `/Users/shengjie.lin/Desktop/live/${target.name}`;
	try {
		const dirty = await runGit(nptDir, ["status", "--porcelain"], 1024 * 1024);
		if (dirty.trim()) {
			return { name: target.name, ok: false, detail: "npt 仓库有未提交修改，未覆盖。" };
		}

		const liveBranch = (await runGit(liveDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], 64 * 1024)).trim();
		const liveRemoteName = (await runGit(
			liveDir,
			["config", "--get", `branch.${liveBranch}.remote`],
			64 * 1024,
		)).trim();
		const liveRemoteBranchRef = (await runGit(
			liveDir,
			["config", "--get", `branch.${liveBranch}.merge`],
			64 * 1024,
		)).trim();
		if (!liveRemoteName || !liveRemoteBranchRef) {
			return { name: target.name, ok: false, detail: "live 当前分支未配置远程跟踪分支。" };
		}
		const liveRemote = (await runGit(liveDir, ["remote", "get-url", liveRemoteName], 64 * 1024)).trim();
		const liveRemoteBranch = liveRemoteBranchRef.replace(/^refs\/heads\//, "");
		const liveRef = `refs/remotes/live-source/${liveBranch}`;

		await runGit(nptDir, ["switch", target.branch], 1024 * 1024);
		await runGit(nptDir, ["fetch", "origin", "--prune"], 1024 * 1024);
		await runGit(nptDir, ["pull", "--rebase", "origin", target.branch], 1024 * 1024);
		await runGit(
			nptDir,
			["fetch", liveRemote, `+refs/heads/${liveRemoteBranch}:${liveRef}`],
			1024 * 1024,
		);

		try {
			await runGit(nptDir, ["merge", "--no-edit", "--no-ff", liveRef], 1024 * 1024);
		} catch (mergeError) {
			try {
				await runGit(nptDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], 64 * 1024);
			} catch {
				throw mergeError;
			}
			await runGit(nptDir, ["checkout", "--theirs", "--", "."], 1024 * 1024);
			await runGit(nptDir, ["add", "-A"], 1024 * 1024);
			await runGit(nptDir, ["commit", "--no-edit"], 1024 * 1024);
		}

		await runGit(nptDir, ["push", "origin", `HEAD:refs/heads/${target.branch}`], 1024 * 1024);
		return { name: target.name, ok: true, detail: "已同步并推送。" };
	} catch (error) {
		return { name: target.name, ok: false, detail: commandError(error) || "Git 命令执行失败。" };
	}
}

/** Run the NPT sync serially so the user can see exactly which repository failed. */
export async function syncNptFromLive(): Promise<NptSyncResult[]> {
	if (!Platform.isDesktopApp) {
		return NPT_SYNC_TARGETS.map((target) => ({
			name: target.name,
			ok: false,
			detail: "仅 Obsidian 桌面端可用。",
		}));
	}
	const results: NptSyncResult[] = [];
	for (const target of NPT_SYNC_TARGETS) results.push(await syncOneNptRepository(target));
	return results;
}

/**
 * Read one repository with the system Git executable. This is deliberately
 * read-only: refresh never fetches, checks out, stages or changes remote refs.
 */
export async function readLocalGitRepository(
	repo: LocalGitRepository,
): Promise<LocalGitSnapshot> {
	const path = repo.path.trim();
	const base: LocalGitSnapshot = {
		id: repo.id,
		name: safeName(repo),
		path,
		ahead: 0,
		behind: 0,
		changed: 0,
		staged: 0,
		untracked: 0,
		conflicted: 0,
	};
	if (!Platform.isDesktopApp) return { ...base, error: "desktopOnly" };
	if (!isAbsolutePath(path)) return { ...base, error: "invalidPath" };
	const cwd = path;
	try {
		const loadNode = (globalThis as typeof globalThis & { require?: NodeRequire }).require;
		if (!loadNode) return { ...base, error: "unavailable" };
		const { stat } = loadNode("node:fs/promises") as typeof import("node:fs/promises");
		if (!(await stat(cwd)).isDirectory()) return { ...base, error: "invalidPath" };
	} catch {
		return { ...base, error: "invalidPath" };
	}
	try {
		const statusOut = await runGit(
			cwd,
			["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
			1024 * 1024,
		);
		const parsed = parsePorcelainV2(statusOut);
		// Porcelain v2 normally includes `branch.head`, but a few worktree and
		// older Git combinations omit it. Ask Git directly before reporting that
		// the repository has no branch.
		if (!parsed.branch) {
			try {
				const branch = (await runGit(cwd, ["branch", "--show-current"], 64 * 1024)).trim();
				if (branch) parsed.branch = branch;
			} catch {
				// Detached or unborn HEAD: the status can still be shown without a name.
			}
		}
		let lastCommit: number | undefined;
		try {
			const commitOut = await runGit(cwd, ["log", "-1", "--format=%ct"], 64 * 1024);
			const seconds = Number(commitOut.trim());
			lastCommit = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
		} catch {
			// A repository with no commits still has a perfectly useful status.
		}
		return {
			...base,
			...parsed,
			lastCommit,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			...base,
			error: /not a git repository/i.test(message) ? "notRepository" : "unavailable",
		};
	}
}

/** Read all repositories independently so one broken path never blanks the card. */
export async function readLocalGitRepositories(
	repositories: readonly LocalGitRepository[],
): Promise<LocalGitSnapshot[]> {
	return Promise.all(repositories.map((repo) => readLocalGitRepository(repo)));
}
import { Platform } from "obsidian";
