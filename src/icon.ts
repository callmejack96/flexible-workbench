/** Flexible Workbench's own modular work-surface mark. The frame represents
 * the workbench; the asymmetric panels represent independently configurable
 * dashboard cards. Two variants are registered: brand purple and themeable. */
import { resolveIconId } from "./lucide";

export const FLEXIBLE_WORKBENCH_ICON_ID = "flexible-workbench-mark";
export const FLEXIBLE_WORKBENCH_ICON_THEMED_ID = "flexible-workbench-mark-themed";

const BRAND_PURPLE = "#A179FF";
const MARK = (color: string): string =>
	`<g fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">` +
	`<rect x="10" y="14" width="80" height="64" rx="10"/>` +
	`<path d="M10 34h80M43 34v44M43 56h47M29 88h42"/>` +
	`</g>`;

export const FLEXIBLE_WORKBENCH_ICON_SVG = MARK(BRAND_PURPLE);
export const FLEXIBLE_WORKBENCH_ICON_THEMED_SVG = MARK("currentColor");

/** Icon id for a theme-color target: the themed (currentColor) mark when the
 * icon follows the theme, the brand-purple mark otherwise. */
export function flexibleWorkbenchIconIdFor(target: "none" | "icon" | "title" | "both"): string {
	return target === "icon" || target === "both" ? FLEXIBLE_WORKBENCH_ICON_THEMED_ID : FLEXIBLE_WORKBENCH_ICON_ID;
}

/**
 * The icon for Flexible Workbench's tab header and ribbon button: the user's chosen Lucide
 * icon, or the workbench mark when they haven't chosen one.
 *
 * The chosen id is resolved against the icons Obsidian actually has, so a typo
 * in the setting shows the workbench mark rather than a blank tab — a tab with no icon
 * at all is much harder to notice, and much harder to undo, than one that
 * simply didn't change.
 */
export function tabIconIdFor(
	target: "none" | "icon" | "title" | "both",
	custom: string | undefined,
): string {
	return resolveIconId(custom) ?? flexibleWorkbenchIconIdFor(target);
}
