import { App, Component } from "obsidian";

/** The community-plugin id Dataview registers itself under. */
export const DATAVIEW_PLUGIN_ID = "dataview";

/** The slice of Dataview's public API Hearth calls. Exposed by the plugin at
 * `app.plugins.plugins.dataview.api` once Dataview is enabled.
 *
 * Both methods render into `container` using Dataview's own renderers (tables,
 * lists, task lists, calendars) and attach a refreshable render-child to
 * `component`, so the result updates itself whenever Dataview's index changes —
 * as long as the component stays alive. Hearth passes the per-card component,
 * which lives until the card is next redrawn, so live updates come for free. */
interface DataviewApi {
	/** Run a Dataview Query Language block (TABLE / LIST / TASK / CALENDAR). */
	execute(source: string, container: HTMLElement, component: Component, filePath: string): Promise<void>;
	/** Run DataviewJS code (the `dv` API in scope). */
	executeJs(code: string, container: HTMLElement, component: Component, filePath: string): Promise<void>;
}

/** Reach Dataview's public API, or null when the plugin isn't installed, isn't
 * enabled, or is too old to expose the render methods Hearth uses. */
export function getDataviewApi(app: App): DataviewApi | null {
	const plugin = app.plugins.plugins[DATAVIEW_PLUGIN_ID] as
		| { api?: unknown }
		| undefined;
	const api = plugin?.api;
	if (
		api &&
		typeof (api as DataviewApi).execute === "function" &&
		typeof (api as DataviewApi).executeJs === "function"
	) {
		return api as DataviewApi;
	}
	return null;
}

/** Whether Dataview is enabled and its render API is reachable right now. */
export function isDataviewAvailable(app: App): boolean {
	return getDataviewApi(app) !== null;
}
