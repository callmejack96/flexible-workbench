/**
 * Xiaohongshu (RedNote) favorites via a browser context (desktop only).
 *
 * RedNote has no stable direct URL for a user's 收藏, its home feed is full of
 * unrelated note links, and every note link needs an `xsec_token` minted by the
 * page. So we drive it headlessly: load RedNote, navigate to the logged-in
 * user's own profile and click the 收藏 tab (all scripted — no manual step),
 * then read the favorite note links (which carry their `xsec_token`) and titles
 * out of that view. If the automation can't reach 收藏 (logged out, or the
 * markup moved), the shared scraper falls back to showing the window so the user
 * can log in / open 收藏 once; the session then persists.
 */
import { t } from "./i18n";
import type { SocialSyncItem } from "./social-sync";
import { collectViaWebview, type ScrapeCandidate } from "./webview-scraper";

const REDNOTE_ORIGIN = "https://www.xiaohongshu.com";
const REDNOTE_START_URL = REDNOTE_ORIGIN;
const WEBVIEW_PARTITION = "persist:flexible-workbench-rednote";
/** Matches /explore/<id> and /discovery/item/<id>. */
const NOTE_HREF = /\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/;

/**
 * Reach the logged-in user's 收藏 view. Idempotent, re-run each round until it
 * returns true: navigate to the own profile, click the 收藏 tab, and report
 * ready once favorite note links are present. Selectors are best-effort and the
 * one place to adjust if RedNote changes its profile markup.
 */
const PREPARE_SCRIPT = String.raw`
(() => {
	const onProfile = /\/user\/profile\//.test(location.pathname);
	const hasNotes = () => document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]').length > 0;
	// Pick the smallest (leaf) element whose text is exactly 收藏, so we click the
	// tab itself and not an outer container that merely contains the word.
	const findTab = () => Array.from(document.querySelectorAll('[role="tab"], [class*="tab"], span, div, a, p'))
		.filter((el) => (el.textContent || '').trim() === '收藏' && el.offsetParent !== null)
		.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
	if (onProfile) {
		const tab = findTab();
		if (tab) {
			const active = /active|selected/i.test(tab.className || '') || tab.getAttribute('aria-selected') === 'true';
			if (!active) { tab.click(); return false; }
		}
		return hasNotes();
	}
	// Not on a profile yet: follow the current user's own profile link ("我").
	const me = document.querySelector('a[href*="/user/profile/"]');
	if (me) { const href = me.getAttribute('href'); if (href) { location.href = href; } }
	return false;
})()
`;

const COLLECT_SCRIPT = String.raw`
(() => {
	const out = [];
	for (const a of document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]')) {
		const href = a.getAttribute('href') || '';
		if (!/\/(explore|discovery\/item)\/[0-9a-zA-Z]+/.test(href)) continue;
		// A note card usually has two links to the same note: the cover image
		// (no text) and the title. Read the title from the anchor if it has one,
		// otherwise look around the card container for the title element.
		let title = (a.getAttribute('title') || a.textContent || '').trim();
		if (!title) {
			const img = a.querySelector('img');
			if (img) title = (img.getAttribute('alt') || '').trim();
		}
		if (!title) {
			const card = a.closest('section, li, .note-item, [class*="note-item"], [class*="noteItem"], [class*="notecard"], [class*="NoteCard"]') || a.parentElement;
			const el = card && card.querySelector('.title, [class*="title"], .footer a, footer a');
			if (el) title = (el.textContent || '').trim();
		}
		out.push({ href, title });
	}
	return out;
})()
`;

const SCROLL_SCRIPT = String.raw`
(() => {
	const sel = 'a[href*="/explore/"], a[href*="/discovery/item/"]';
	const links = document.querySelectorAll(sel);
	const doc = document.scrollingElement || document.documentElement;
	window.scrollTo(0, doc.scrollHeight);
	// The favorites grid often lives in an inner scroll container, not the
	// window — scroll every scrollable ancestor of the last card, and bring the
	// last card into view, to trigger lazy-loading of more favorites.
	const last = links[links.length - 1];
	if (last) {
		try { last.scrollIntoView({ block: 'end' }); } catch (e) {}
		for (let el = last.parentElement; el && el !== document.body; el = el.parentElement) {
			const s = getComputedStyle(el);
			if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) {
				el.scrollTop = el.scrollHeight;
			}
		}
	}
	return links.length;
})()
`;

/** Note id from a RedNote href, for the incremental early-stop. */
function rednoteIdFromHref(href: string): string | null {
	return NOTE_HREF.exec(href)?.[1] ?? null;
}

export interface RednoteScrapeOptions {
	limit?: number;
	/** Note ids already saved in the vault; scrolling stops once it reaches them. */
	knownIds?: ReadonlySet<string>;
}

/**
 * Build title+link favorites from raw page candidates. The full href is kept
 * (it carries the required `xsec_token`), only made absolute. Pure and DOM-free
 * for unit tests.
 */
export function normalizeRednoteScrapeItems(
	candidates: ScrapeCandidate[],
	limit = Number.POSITIVE_INFINITY,
): SocialSyncItem[] {
	// A note appears more than once per card (cover link + title link), often
	// with the title on only one of them. Merge by id: keep the first href that
	// carries an xsec_token, and fill in the title from whichever link has one.
	const byId = new Map<string, { href: string; title: string }>();
	const order: string[] = [];
	for (const candidate of candidates) {
		const href = candidate.href ?? "";
		const id = NOTE_HREF.exec(href)?.[1];
		if (!id) continue;
		const title = collapseWhitespace(candidate.title);
		const existing = byId.get(id);
		if (!existing) {
			byId.set(id, { href, title });
			order.push(id);
			continue;
		}
		if (!existing.title && title) existing.title = title;
		if (!/xsec_token=/.test(existing.href) && /xsec_token=/.test(href)) existing.href = href;
	}
	const items: SocialSyncItem[] = [];
	for (const id of order) {
		const entry = byId.get(id);
		if (!entry) continue;
		items.push({ id, title: entry.title || `小红书收藏 ${id}`, url: absoluteUrl(entry.href) });
		if (items.length >= limit) break;
	}
	return items;
}

/**
 * Node-safe fallback collector: pull favorites out of a serialized HTML string
 * with regexes. Shares the normalization core and is the unit-tested entry.
 */
export function extractRednoteFavoritesFromHtml(
	html: string,
	limit = Number.POSITIVE_INFINITY,
): SocialSyncItem[] {
	const candidates: ScrapeCandidate[] = [];
	const anchor = /<a\b([^>]*?)href="([^"]*\/(?:explore|discovery\/item)\/[^"]*)"([^>]*)>([\s\S]*?)<\/a>/g;
	let match: RegExpExecArray | null;
	while ((match = anchor.exec(html)) !== null) {
		const attrs = `${match[1]} ${match[3]}`;
		const title = attributeValue(attrs, "title") || imageAlt(match[4]) || stripTags(match[4]);
		candidates.push({ href: decodeEntities(match[2]), title });
	}
	return normalizeRednoteScrapeItems(candidates, limit);
}

/** Open RedNote, auto-navigate to the user's 收藏, and read note links+titles.
 * Falls back to a one-time login/navigation window if automation can't reach it. */
export async function scrapeRednoteFavorites(
	options: RednoteScrapeOptions = {},
): Promise<SocialSyncItem[]> {
	const limit = Math.max(1, Math.min(500, Math.round(options.limit ?? 100)));
	const candidates = await collectViaWebview({
		startUrl: REDNOTE_START_URL,
		partition: WEBVIEW_PARTITION,
		limit,
		collectScript: COLLECT_SCRIPT,
		scrollScript: SCROLL_SCRIPT,
		prepareScript: PREPARE_SCRIPT,
		knownIds: options.knownIds,
		idFromHref: rednoteIdFromHref,
		instruction: t().cards.social.rednoteCollectHint,
		desktopMessage: t().cards.social.rednoteDesktopOnly,
		mode: "headless",
	});
	return normalizeRednoteScrapeItems(candidates, limit);
}

function absoluteUrl(href: string): string {
	if (/^https?:\/\//i.test(href)) return href;
	return `${REDNOTE_ORIGIN}${href.startsWith("/") ? "" : "/"}${href}`;
}

function attributeValue(attrs: string, name: string): string {
	const match = new RegExp(`${name}="([^"]*)"`, "i").exec(attrs);
	return match ? decodeEntities(match[1]) : "";
}

function imageAlt(inner: string): string {
	const match = /<img\b[^>]*\balt="([^"]*)"/i.exec(inner);
	return match ? decodeEntities(match[1]) : "";
}

function stripTags(inner: string): string {
	return decodeEntities(inner.replace(/<[^>]*>/g, " "));
}

function decodeEntities(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
