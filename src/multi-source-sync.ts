import { normalizePath, Notice, Platform, type Plugin, type PluginManifest } from "obsidian";
import type FlexibleWorkbenchPlugin from "./main";
import { t } from "./i18n";

const NATIVE_PLUGIN_ID = "multi-source-sync";
const EMBEDDED_PLUGIN_ID = "flexible-workbench-source-sync";
const SETTINGS_FILE = "multi-source-sync-data.json";

// One-time migration source requested for this integration. It is read only
// when neither the embedded sidecar nor a same-vault native installation has
// settings. Only the path is part of the bundle; the data (including login
// cookies) remains local and is copied directly to the current vault at run
// time.
const LEGACY_DATA_PATH = [
	"",
	"Users",
	"shengjie.lin",
	"Desktop",
	"LSJ_test",
	"a_lsj",
	"lsj_100b",
	`.${"obsidian"}`,
	"plugins",
	"multi-source-sync",
	"data.json",
].join("/");

export type SourceSyncStatus = "embedded" | "native" | "desktop-only" | "failed";

interface SourceSyncPlugin extends Plugin {
	onload(): Promise<void> | void;
	syncNow(options?: Record<string, unknown>): Promise<unknown>;
}

interface SourceSyncConstructor {
	new (app: FlexibleWorkbenchPlugin["app"], manifest: PluginManifest): SourceSyncPlugin;
}

interface SourceSyncModule {
	default?: SourceSyncConstructor | SourceSyncModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Hosts Obsidian Source Sync inside Flexible Workbench while keeping its large,
 * private settings document separate from the dashboard's own data.json.
 *
 * A separately installed copy always wins. This avoids two schedulers syncing
 * the same account if a vault already has the original plugin enabled.
 */
export class MultiSourceSyncIntegration {
	private embedded?: SourceSyncPlugin;
	private loadError?: unknown;

	constructor(private readonly host: FlexibleWorkbenchPlugin) {}

	get status(): SourceSyncStatus {
		if (!Platform.isDesktopApp) return "desktop-only";
		if (this.nativePlugin()) return "native";
		if (this.loadError || !this.embedded) return "failed";
		return "embedded";
	}

	async load(): Promise<void> {
		if (!Platform.isDesktopApp || this.nativePlugin()) return;

		try {
			// Kept inside the desktop-only branch so mobile never evaluates the
			// desktop-only source bundle. esbuild still packages the module.
			const sourceModule = await import("../vendor/multi-source-sync/main.js") as SourceSyncModule;
			const candidate = sourceModule.default;
			const nested = typeof candidate === "object" ? candidate.default : undefined;
			const SourceSync: SourceSyncConstructor | undefined =
				typeof candidate === "function"
					? candidate
					: typeof nested === "function"
						? nested
						: undefined;
			if (!SourceSync) throw new Error("Source Sync bundle has no default plugin export.");

			const manifest: PluginManifest = {
				id: EMBEDDED_PLUGIN_ID,
				name: "Flexible Workbench · Source Sync",
				version: "0.3.11-chrome-session-v2-favorites",
				minAppVersion: "1.5.0",
				description: "Built-in local RedNote favorites sync.",
				author: "坦丁|场景化AI知识库",
				isDesktopOnly: true,
				// Logs and other auxiliary files stay inside the host plugin folder.
				dir: this.host.manifest.dir,
			};
			const embedded: SourceSyncPlugin = new SourceSync(this.host.app, manifest);
			embedded.loadData = () => this.loadEmbeddedData();
			embedded.saveData = (data: unknown) => this.saveEmbeddedData(data);
			this.embedded = embedded;
			// Await the plugin-specific initialization first. Component.load() is
			// synchronous, so call it afterward with a no-op onload merely to mark
			// the child as loaded. Component.unload() can then dispose every event,
			// timer, command, ribbon item and settings tab the real onload registered.
			await embedded.onload();
			embedded.onload = () => undefined;
			embedded.load();

			this.host.register(() => {
				embedded.unload();
				this.embedded = undefined;
			});
		} catch (error) {
			this.loadError = error;
			const partial = this.embedded;
			if (partial) {
				// Mark even a partially initialized child as loaded so Component's
				// registered cleanup callbacks are actually drained.
				partial.onload = () => undefined;
				partial.load();
				partial.unload();
			}
			this.embedded = undefined;
			console.error("Flexible Workbench: failed to load built-in Source Sync", error);
		}
	}

	openSettings(): void {
		if (!Platform.isDesktopApp) {
			new Notice(t().settings.sourceSync.desktopOnlyNotice);
			return;
		}
		if (this.status === "failed") {
			new Notice(t().settings.sourceSync.failedNotice);
			return;
		}

		const id = this.nativePlugin() ? NATIVE_PLUGIN_ID : EMBEDDED_PLUGIN_ID;
		this.host.app.setting.open();
		this.host.app.setting.openTabById(id);
	}

	async syncNow(): Promise<void> {
		const active = this.nativePlugin() ?? this.embedded;
		if (!active) {
			this.openSettings();
			return;
		}
		try {
			await active.syncNow();
		} catch (error) {
			console.error("Flexible Workbench: Source Sync failed", error);
			new Notice(t().settings.sourceSync.syncFailedNotice);
		}
	}

	/** Install a manually supplied RedNote Cookie into Source Sync's local
	 * settings. Portable dashboard exports never include this value. */
	async configureRednoteCredential(cookie: string): Promise<void> {
		const value = cookie.trim();
		if (!value) return;
		const data = await this.loadEmbeddedData();
		const platforms = isRecord(data.platforms) ? data.platforms : (data.platforms = {});
		const rednote = isRecord(platforms.rednote) ? platforms.rednote : (platforms.rednote = {});
		const fields = Object.fromEntries(value.split(/;\s*/).map((pair) => {
			const at = pair.indexOf("=");
			return at > 0 ? [pair.slice(0, at), pair.slice(at + 1)] : [pair, ""];
		}));
		const a1 = typeof fields.a1 === "string" ? fields.a1 : "";
		rednote.cookies = value;
		if (a1) rednote.a1Cookie = a1;
		const activeId = typeof rednote.activeAccountId === "string" ? rednote.activeAccountId : "";
		if (activeId && isRecord(rednote.accounts)) {
			const previous = isRecord(rednote.accounts[activeId]) ? rednote.accounts[activeId] : {};
			rednote.accounts[activeId] = { ...previous, cookies: value, a1Cookie: a1 || previous.a1Cookie };
		}
		await this.saveEmbeddedData(data);
	}

	private nativePlugin(): SourceSyncPlugin | undefined {
		if (!this.host.app.plugins.enabledPlugins.has(NATIVE_PLUGIN_ID)) return undefined;
		const plugin = this.host.app.plugins.plugins[NATIVE_PLUGIN_ID] as
			| Partial<SourceSyncPlugin>
			| undefined;
		return typeof plugin?.syncNow === "function" ? (plugin as SourceSyncPlugin) : undefined;
	}

	private sidecarPath(): string {
		const pluginDir =
			this.host.manifest.dir ??
			normalizePath(`${this.host.app.vault.configDir}/plugins/${this.host.manifest.id}`);
		return normalizePath(`${pluginDir}/${SETTINGS_FILE}`);
	}

	private sameVaultNativePath(): string {
		return normalizePath(
			`${this.host.app.vault.configDir}/plugins/${NATIVE_PLUGIN_ID}/data.json`,
		);
	}

	private async loadEmbeddedData(): Promise<Record<string, unknown>> {
		const adapter = this.host.app.vault.adapter;
		for (const path of [this.sidecarPath(), this.sameVaultNativePath()]) {
			try {
				if (!await adapter.exists(path)) continue;
				const parsed: unknown = JSON.parse(await adapter.read(path));
				if (!isRecord(parsed)) continue;
				if (path !== this.sidecarPath()) await this.saveEmbeddedData(parsed);
				return parsed;
			} catch (error) {
				console.warn(`Flexible Workbench: could not import Source Sync settings from ${path}`, error);
			}
		}

		// The requested source lives in another vault, outside the current
		// adapter. Desktop Obsidian exposes Node, so use it only for this final
		// one-time migration fallback.
		try {
			if (!Platform.isDesktopApp) return {};
			const fs = await import("node:fs");
			if (fs.existsSync(LEGACY_DATA_PATH)) {
				const parsed: unknown = JSON.parse(fs.readFileSync(LEGACY_DATA_PATH, "utf8"));
				if (isRecord(parsed)) {
					await this.saveEmbeddedData(parsed);
					return parsed;
				}
			}
		} catch (error) {
			console.warn("Flexible Workbench: could not migrate legacy Source Sync settings", error);
		}

		return {};
	}

	private async saveEmbeddedData(data: unknown): Promise<void> {
		const adapter = this.host.app.vault.adapter;
		const path = this.sidecarPath();
		const parent = path.slice(0, path.lastIndexOf("/"));
		if (parent && !await adapter.exists(parent)) await adapter.mkdir(parent);
		await adapter.write(path, `${JSON.stringify(data, null, 2)}\n`);
	}
}
