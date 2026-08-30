import { getLanguage } from "obsidian";
import { en } from "./locales/en";
import { LOCALES, type Translations } from "./locales";

export type { Translations };

/** The active translation table. Starts as English and is switched at plugin
 * load by {@link setLanguage}. */
let active: Translations = en;

/**
 * The UI language Obsidian is set to, via Obsidian's {@link getLanguage} API
 * (empty or absent means English). It only changes on a full reload, so reading
 * it once at load is enough — there's no need to react to it at runtime.
 */
export function detectLanguage(): string {
	try {
		return getLanguage() || "en";
	} catch {
		// getLanguage can be unavailable in locked-down/embedded contexts.
		return "en";
	}
}

/**
 * Select the active locale by language code (e.g. `"en"`, `"de"`, `"zh-TW"`).
 * Falls back from a regional code to its base language (`"zh"` for `"zh-TW"`)
 * and finally to English, so an unknown or only-partially-translated locale
 * still renders. Called once from the plugin's `onload`.
 */
export function setLanguage(lang: string = detectLanguage()): void {
	const code = lang.toLowerCase();
	active = LOCALES[code] ?? LOCALES[code.split("-")[0]] ?? en;
}

/**
 * The active translation table. Access plain strings as `t().section.key`;
 * entries that take parameters are functions, e.g.
 * `t().notices.commandNotFound(id)`.
 *
 * It's a function (not a bare object) so every call site reads whatever locale
 * is active at render time rather than capturing English at import time.
 */
export function t(): Translations {
	return active;
}
