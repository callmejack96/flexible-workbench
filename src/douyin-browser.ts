/**
 * Douyin favorites via a browser context (desktop only).
 *
 * Douyin's private web API needs a `msToken + X-Bogus + a_bogus` signature chain
 * we don't reproduce. Instead we let the logged-in page sign its own requests and
 * hook `fetch`/XHR inside the webview to capture the responses of the favorites-
 * only endpoint `/aweme/v1/web/aweme/listcollection/`. That guarantees we read
 * 收藏 (never the recommendation feed) and needs no signing. A DOM fallback,
 * scoped to the collection container, covers the first page. If nothing is
 * captured (logged out), the shared scraper shows the login window once; the
 * session then persists. See `webview-scraper.ts` for the shared machinery.
 */
import { t } from "./i18n";
import type { SocialSyncItem } from "./social-sync";
import { collectViaWebview, type ScrapeCandidate } from "./webview-scraper";

const DOUYIN_ORIGIN = "https://www.douyin.com";
const DOUYIN_FAVORITES_URL = `${DOUYIN_ORIGIN}/user/self?showTab=favorite_collection`;
const WEBVIEW_PARTITION = "persist:flexible-workbench-douyin";

/**
 * Install a one-time fetch/XHR hook that records every favorite from the
 * `listcollection` endpoint's JSON into `window.__fwDouyin`, and make sure the
 * 收藏 tab is active. Returns true (hook installed); whether favorites actually
 * arrive is gauged by the collector, so a logged-out page yields nothing and the
 * scraper falls back to the login window.
 */
const PREPARE_SCRIPT = String.raw`
(() => {
	if (!window.__fwDouyin) {
		window.__fwDouyin = [];
		var seen = {};
		var record = function (json) {
			try {
				var list = (json && (json.aweme_list || json.collects)) || [];
				for (var i = 0; i < list.length; i++) {
					var info = list[i].aweme_info || list[i];
					var id = info && info.aweme_id;
					if (!id || seen[id]) continue;
					seen[id] = 1;
					window.__fwDouyin.push({ href: '/video/' + id, title: (info.desc || '').trim() });
				}
			} catch (e) {}
		};
		var isCol = function (u) { return ('' + u).indexOf('listcollection') >= 0; };
		var of = window.fetch;
		window.fetch = function () {
			var args = arguments;
			var p = of.apply(this, args);
			try {
				var u = (args[0] && args[0].url) || args[0] || '';
				if (isCol(u)) p.then(function (r) { try { r.clone().json().then(record); } catch (e) {} });
			} catch (e) {}
			return p;
		};
		var OpenX = window.XMLHttpRequest.prototype.open;
		var SendX = window.XMLHttpRequest.prototype.send;
		window.XMLHttpRequest.prototype.open = function (m, u) { this.__fwUrl = u; return OpenX.apply(this, arguments); };
		window.XMLHttpRequest.prototype.send = function () {
			var xhr = this;
			xhr.addEventListener('load', function () {
				try { if (isCol(xhr.__fwUrl)) record(JSON.parse(xhr.responseText)); } catch (e) {}
			});
			return SendX.apply(this, arguments);
		};
	}
	// Make sure the 收藏 tab is active (leaf element whose text is exactly 收藏).
	var tab = Array.prototype.slice.call(document.querySelectorAll('[data-e2e*="tab"], [role="tab"], span, div, p, a'))
		.filter(function (el) { return (el.textContent || '').trim() === '收藏' && el.offsetParent !== null; })
		.sort(function (a, b) { return (a.textContent || '').length - (b.textContent || '').length; })[0];
	if (tab) {
		var active = false;
		for (var n = tab; n && n !== document.body; n = n.parentElement) {
			var c = n.className && n.className.toString ? n.className.toString() : '';
			if (/active|selected|current/i.test(c) || (n.getAttribute && n.getAttribute('aria-selected') === 'true')) { active = true; break; }
		}
		if (!active) { tab.click(); }
	}
	return true;
})()
`;

/** Merge the hook-captured favorites with any rendered in the DOM. Both are
 * favorites-only here (we're on the 收藏 tab); the hook is the authoritative
 * source and the DOM covers the first page / any calls the hook missed. */
const COLLECT_SCRIPT = String.raw`
(() => {
	var out = (window.__fwDouyin || []).slice();
	var seen = {};
	for (var i = 0; i < out.length; i++) seen[out[i].href] = 1;
	var box = document.querySelector('[data-e2e="user-collection-list"], [data-e2e="user-favorite-list"]');
	var links = (box || document).querySelectorAll('a[href*="/video/"]');
	for (var j = 0; j < links.length; j++) {
		var a = links[j];
		var href = a.getAttribute('href') || '';
		if (!/\/video\/\d+/.test(href) || seen[href]) continue;
		seen[href] = 1;
		var img = a.querySelector('img');
		out.push({ href: href, title: a.getAttribute('title') || (img && img.getAttribute('alt')) || a.textContent || '' });
	}
	return out;
})()
`;

const SCROLL_SCRIPT = String.raw`
(() => {
	window.scrollTo(0, document.documentElement.scrollHeight);
	// The favorites list scrolls inside its own container, not the window. Find
	// (once) the tallest scrollable element that actually holds video links and
	// keep scrolling it so the page fetches the next listcollection page.
	if (!window.__fwScroller) {
		var best = null, bestH = 0;
		var all = document.querySelectorAll('*');
		for (var i = 0; i < all.length; i++) {
			var el = all[i];
			if (el.scrollHeight > el.clientHeight + 40 && el.scrollHeight > bestH) {
				var s = getComputedStyle(el);
				if (/(auto|scroll)/.test(s.overflowY) && el.querySelector('a[href*="/video/"]')) { best = el; bestH = el.scrollHeight; }
			}
		}
		window.__fwScroller = best;
	}
	if (window.__fwScroller) window.__fwScroller.scrollTop = window.__fwScroller.scrollHeight;
	var vids = document.querySelectorAll('a[href*="/video/"]');
	var last = vids[vids.length - 1];
	if (last) { try { last.scrollIntoView({ block: 'end' }); } catch (e) {} }
	return (window.__fwDouyin || []).length;
})()
`;

/** Aweme id from a Douyin href, for the incremental early-stop. */
function douyinIdFromHref(href: string): string | null {
	return /\/video\/(\d+)/.exec(href)?.[1] ?? null;
}

export interface DouyinScrapeOptions {
	limit?: number;
	/** Aweme ids already saved in the vault; scrolling stops once it reaches them. */
	knownIds?: ReadonlySet<string>;
}

/**
 * Build clean title+link favorites out of raw page candidates: pull the aweme
 * id from the href, dedupe, fill a fallback title, and cap at `limit`. Pure and
 * DOM-free so it runs under Node in unit tests.
 */
export function normalizeDouyinScrapeItems(
	candidates: ScrapeCandidate[],
	limit = Number.POSITIVE_INFINITY,
): SocialSyncItem[] {
	const items: SocialSyncItem[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const id = /\/video\/(\d+)/.exec(candidate.href ?? "")?.[1];
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const title = collapseWhitespace(candidate.title) || `抖音收藏 ${id}`;
		items.push({ id, title, url: `${DOUYIN_ORIGIN}/video/${id}` });
		if (items.length >= limit) break;
	}
	return items;
}

/**
 * Node-safe fallback collector: pull favorites out of a serialized HTML string
 * with regexes. Shares the normalization core with the in-page collector and is
 * the unit-tested entry point.
 */
export function extractDouyinFavoritesFromHtml(
	html: string,
	limit = Number.POSITIVE_INFINITY,
): SocialSyncItem[] {
	const candidates: ScrapeCandidate[] = [];
	const anchor = /<a\b([^>]*?)href="(\/video\/\d+)"([^>]*)>([\s\S]*?)<\/a>/g;
	let match: RegExpExecArray | null;
	while ((match = anchor.exec(html)) !== null) {
		const attrs = `${match[1]} ${match[3]}`;
		const title = attributeValue(attrs, "title") || imageAlt(match[4]) || stripTags(match[4]);
		candidates.push({ href: match[2], title });
	}
	return normalizeDouyinScrapeItems(candidates, limit);
}

/** Read the logged-in favorites page in a hidden webview (shows a login window
 * only when the page has nothing to read). */
export async function scrapeDouyinFavorites(
	options: DouyinScrapeOptions = {},
): Promise<SocialSyncItem[]> {
	const limit = Math.max(1, Math.min(500, Math.round(options.limit ?? 100)));
	const candidates = await collectViaWebview({
		startUrl: DOUYIN_FAVORITES_URL,
		partition: WEBVIEW_PARTITION,
		limit,
		collectScript: COLLECT_SCRIPT,
		scrollScript: SCROLL_SCRIPT,
		prepareScript: PREPARE_SCRIPT,
		knownIds: options.knownIds,
		idFromHref: douyinIdFromHref,
		instruction: t().cards.social.douyinLoginRequired,
		desktopMessage: t().cards.social.douyinDesktopOnly,
		mode: "headless",
	});
	return normalizeDouyinScrapeItems(candidates, limit);
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
