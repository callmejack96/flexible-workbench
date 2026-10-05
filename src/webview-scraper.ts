/**
 * Shared Electron <webview> scraper for reading title+link items out of a
 * logged-in social page (desktop only). Douyin and RedNote both drive this:
 * they supply a start URL, an in-page collect script and a scroll script, and
 * this module handles the webview lifecycle, scrolling, the login/interactive
 * window and cleanup.
 *
 * The DOM/selector-dependent parts live in each caller's collect script and are
 * kept small so they are easy to adjust when a site changes its markup.
 */
import { Platform } from "obsidian";

const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
	"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

const LOAD_TIMEOUT_MS = 30_000;
const INTERACTION_TIMEOUT_MS = 5 * 60_000;
const SCROLL_SETTLE_MS = 1_500;
const MAX_SCROLL_ROUNDS = 80;
/** Stop scrolling only after this many consecutive rounds add no new cards — a
 * single flat round is common mid lazy-load, so one is not enough (the old
 * `count === previous` check stopped after the first screen). */
const STALL_ROUNDS = 4;
/** How long to keep retrying the prepare step (reach the favorites view) before
 * treating the page as not-ready (e.g. logged out). */
const PREPARE_ROUNDS = 8;

const EMPTY_IDS: ReadonlySet<string> = new Set();

export type WebviewScrapeErrorKind = "desktop-only" | "cancelled" | "timeout";

export class WebviewScrapeError extends Error {
	readonly kind: WebviewScrapeErrorKind;

	constructor(kind: WebviewScrapeErrorKind, message: string) {
		super(message);
		this.name = "WebviewScrapeError";
		this.kind = kind;
	}
}

/** A {href,title} pair as read from the page, before normalization. */
export interface ScrapeCandidate {
	href: string;
	title: string;
}

/** How many candidates carry an id not already in `knownIds`. Drives both the
 * incremental early-stop (favorites pages are newest-first, so once fresh ids
 * dry up we've reached what the vault already has) and, when knownIds is empty,
 * plain progress. Pure and DOM-free for unit tests. */
export function countNewIds(
	candidates: ScrapeCandidate[],
	knownIds: ReadonlySet<string>,
	idFromHref: (href: string) => string | null,
): number {
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const id = idFromHref(candidate.href);
		if (id && !knownIds.has(id) && !seen.has(id)) seen.add(id);
	}
	return seen.size;
}

export interface WebviewScrapeConfig {
	startUrl: string;
	/** Persist login across syncs so the window only appears when needed. */
	partition: string;
	userAgent?: string;
	limit: number;
	/** JS expression returning an array of {href,title} objects. */
	collectScript: string;
	/** JS expression that scrolls one page down and returns the item count. */
	scrollScript: string;
	/**
	 * Optional JS expression run before scrolling (and retried each round until
	 * ready) to reach the favorites view — e.g. click the 收藏 tab. Must be
	 * idempotent and return a truthy value once the favorites list is present.
	 * When omitted the page is considered ready as soon as it loads.
	 */
	prepareScript?: string;
	/** Ids already in the vault; scrolling stops once no fresh ids appear. */
	knownIds?: ReadonlySet<string>;
	/** Extract an item id from an href, for the incremental early-stop. */
	idFromHref?: (href: string) => string | null;
	/** Shown in the window's instruction bar. */
	instruction: string;
	/** Message for the desktop-only guard. */
	desktopMessage: string;
	/**
	 * "headless" tries silently first and only shows the window (login bar) when
	 * the page yields nothing. "interactive" always shows the window with a
	 * Collect button the user presses once the right page is loaded.
	 */
	mode: "headless" | "interactive";
	/** Label for the Collect button in interactive mode. */
	collectLabel?: string;
}

/** Desktop-only. Load the page, let the user reach it if needed, and return the
 * raw {href,title} candidates the collect script found. Callers normalize. */
export async function collectViaWebview(config: WebviewScrapeConfig): Promise<ScrapeCandidate[]> {
	if (!Platform.isDesktopApp) {
		throw new WebviewScrapeError("desktop-only", config.desktopMessage);
	}
	const host = new WebviewScraperHost(config);
	try {
		await host.load(config.startUrl);
		if (config.mode === "interactive") {
			return await host.interactiveCollect();
		}
		let candidates = await host.autoScroll();
		if (candidates.length === 0) {
			candidates = await host.awaitLogin();
		}
		return candidates;
	} finally {
		host.destroy();
	}
}

/** Minimal Electron <webview> surface we rely on. */
interface ScraperWebview extends HTMLElement {
	src: string;
	executeJavaScript(code: string): Promise<unknown>;
	stop(): void;
}

/**
 * Owns one long-lived <webview> element (never reparented, to avoid Electron
 * resetting it) plus a centered window (backdrop + instruction bar + optional
 * Collect button) that reuses the same element.
 */
class WebviewScraperHost {
	private readonly host: HTMLDivElement;
	private readonly backdrop: HTMLDivElement;
	private readonly bar: HTMLDivElement;
	private readonly collectButton: HTMLButtonElement;
	private readonly webview: ScraperWebview;
	private destroyed = false;

	constructor(private readonly config: WebviewScrapeConfig) {
		this.backdrop = document.body.createDiv();
		this.backdrop.setCssStyles({
			position: "fixed",
			inset: "0",
			background: "rgba(0,0,0,0.5)",
			zIndex: "999",
			display: "none",
		});

		this.host = document.body.createDiv();
		this.host.setCssStyles(headlessStyle());

		this.bar = this.host.createDiv();
		this.bar.setText(config.instruction);
		this.bar.setCssStyles({
			display: "none",
			padding: "10px 12px",
			font: "13px/1.4 sans-serif",
			color: "var(--text-normal, #222)",
			background: "var(--background-secondary, #f4f4f4)",
			borderBottom: "1px solid var(--background-modifier-border, #ddd)",
		});

		this.collectButton = this.host.createEl("button", { text: config.collectLabel ?? "Collect" });
		this.collectButton.setCssStyles({
			display: "none",
			margin: "8px",
			padding: "6px 12px",
			border: "0",
			borderRadius: "8px",
			background: "var(--interactive-accent, #5b5bd6)",
			color: "var(--text-on-accent, #fff)",
			fontWeight: "600",
			cursor: "pointer",
		});

		const webview = document.createElement("webview") as unknown as ScraperWebview;
		webview.setAttribute("partition", config.partition);
		webview.setAttribute("useragent", config.userAgent ?? DEFAULT_USER_AGENT);
		webview.setAttribute("allowpopups", "false");
		webview.setCssStyles({ flex: "1", width: "100%", border: "0" });
		this.host.appendChild(webview);
		this.webview = webview;
	}

	/** Navigate and wait for the page's DOM to be ready (or time out). */
	async load(url: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				cleanup();
				reject(new WebviewScrapeError("timeout", this.config.instruction));
			}, LOAD_TIMEOUT_MS);
			const onReady = (): void => {
				cleanup();
				resolve();
			};
			const cleanup = (): void => {
				window.clearTimeout(timer);
				this.webview.removeEventListener("dom-ready", onReady);
			};
			this.webview.addEventListener("dom-ready", onReady, { once: true });
			this.webview.src = url;
		});
		await sleep(SCROLL_SETTLE_MS);
	}

	/** Reach the favorites view (retrying the prepare script), then scroll to the
	 * end of the list — favorites are only saved if new, so we pull the whole
	 * list rather than early-stopping (which would miss older un-synced items when
	 * the newest ones are already in the vault). Returns [] if the view never
	 * becomes ready — the caller then falls back to the login window. */
	async autoScroll(): Promise<ScrapeCandidate[]> {
		if (!(await this.prepare())) return [];
		const known = this.config.knownIds ?? EMPTY_IDS;
		const idFromHref = this.config.idFromHref ?? ((href: string) => href);
		let latest = await this.collect();
		let prevCount = latest.length;
		let stall = 0;
		for (let round = 0; round < MAX_SCROLL_ROUNDS && !this.destroyed; round++) {
			// A safety cap for very large lists — count fresh (unknown) ids only.
			if (countNewIds(latest, known, idFromHref) >= this.config.limit) break;
			await this.exec(this.config.scrollScript);
			await sleep(SCROLL_SETTLE_MS);
			latest = await this.collect();
			// Stop when the list stops growing for a few consecutive rounds (end of
			// list / no more lazy-loading), never on the first flat round.
			if (latest.length > prevCount) {
				prevCount = latest.length;
				stall = 0;
			} else if (++stall >= STALL_ROUNDS) {
				break;
			}
		}
		return latest;
	}

	/** Run the prepare script (reach the 收藏 view) until it reports ready. No
	 * prepare script means the loaded page is already the target. */
	private async prepare(): Promise<boolean> {
		if (!this.config.prepareScript) return true;
		for (let round = 0; round < PREPARE_ROUNDS && !this.destroyed; round++) {
			if (await this.exec(this.config.prepareScript)) return true;
			await sleep(SCROLL_SETTLE_MS);
		}
		return false;
	}

	private async collect(): Promise<ScrapeCandidate[]> {
		return toCandidates(await this.exec(this.config.collectScript));
	}

	/** Headless fallback: reveal the window so the user can log in / reach the
	 * favorites page, then return items once the view is ready (or time out). */
	async awaitLogin(): Promise<ScrapeCandidate[]> {
		this.reveal();
		const deadline = Date.now() + INTERACTION_TIMEOUT_MS;
		while (!this.destroyed && Date.now() < deadline) {
			await sleep(2_000);
			const ready = this.config.prepareScript
				? Boolean(await this.exec(this.config.prepareScript))
				: true;
			if (ready && (await this.collect()).length > 0) return this.autoScroll();
		}
		throw new WebviewScrapeError("timeout", this.config.instruction);
	}

	/** Interactive: show the window with a Collect button; resolve with the
	 * scraped items when the user presses it (or [] if they close the window). */
	async interactiveCollect(): Promise<ScrapeCandidate[]> {
		this.reveal();
		this.collectButton.setCssStyles({ display: "inline-block" });
		return new Promise<ScrapeCandidate[]>((resolve) => {
			const timer = window.setTimeout(() => finish([]), INTERACTION_TIMEOUT_MS);
			let done = false;
			const finish = (result: ScrapeCandidate[]): void => {
				if (done) return;
				done = true;
				window.clearTimeout(timer);
				resolve(result);
			};
			this.collectButton.addEventListener("click", () => {
				this.collectButton.disabled = true;
				void this.autoScroll().then(finish, () => finish([]));
			});
			this.backdrop.addEventListener("click", () => finish([]));
		});
	}

	private reveal(): void {
		this.bar.setCssStyles({ display: "block" });
		this.backdrop.setCssStyles({ display: "block" });
		this.host.setCssStyles(overlayStyle());
	}

	private async exec(code: string): Promise<unknown> {
		if (this.destroyed) return null;
		try {
			return await this.webview.executeJavaScript(code);
		} catch {
			return null;
		}
	}

	destroy(): void {
		this.destroyed = true;
		try {
			this.webview.stop();
		} catch {
			// Already detached; nothing to stop.
		}
		this.host.remove();
		this.backdrop.remove();
	}
}

function headlessStyle(): Partial<CSSStyleDeclaration> {
	return {
		position: "fixed",
		left: "-10000px",
		top: "0",
		width: "480px",
		height: "720px",
		display: "flex",
		flexDirection: "column",
		opacity: "0",
		pointerEvents: "none",
		zIndex: "1000",
	};
}

function overlayStyle(): Partial<CSSStyleDeclaration> {
	return {
		position: "fixed",
		left: "50%",
		top: "50%",
		transform: "translate(-50%, -50%)",
		width: "min(560px, 92vw)",
		height: "min(780px, 88vh)",
		display: "flex",
		flexDirection: "column",
		opacity: "1",
		pointerEvents: "auto",
		zIndex: "1000",
		borderRadius: "10px",
		overflow: "hidden",
		boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
	};
}

function toCandidates(value: unknown): ScrapeCandidate[] {
	if (!Array.isArray(value)) return [];
	const out: ScrapeCandidate[] = [];
	for (const entry of value) {
		if (entry && typeof entry === "object") {
			const href = (entry as Record<string, unknown>).href;
			const title = (entry as Record<string, unknown>).title;
			if (typeof href === "string") {
				out.push({ href, title: typeof title === "string" ? title : "" });
			}
		}
	}
	return out;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
