/**
 * Exchange-rate support for the calculator card's currency conversions
 * (e.g. `10 € to USD`).
 *
 * Rates come from the free, key-less, ECB-backed Frankfurter API and are cached
 * in memory for a few hours so a board full of calculator cards makes at most
 * one request per refresh window. Everything degrades gracefully offline: if a
 * fetch fails the last good rates are kept, and if none were ever fetched a
 * currency query just reports that rates are unavailable.
 */
import { requestUrl } from "obsidian";

export interface CurrencyRates {
	/** Base currency code the rates are relative to (lowercase, e.g. "eur"). */
	base: string;
	/** Units of each currency per 1 unit of base; includes the base itself = 1. */
	rates: Record<string, number>;
	/** Epoch milliseconds when these rates were fetched. */
	fetched: number;
}

/** How long a fetched rate table is considered fresh. */
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const ENDPOINT = "https://api.frankfurter.app/latest";

/** ISO 4217 codes the Frankfurter API covers (also what we recognise as units).
 * EUR is the base and isn't returned in `rates`, so it's listed here too. */
export const CURRENCY_CODES: readonly string[] = [
	"eur", "usd", "gbp", "jpy", "chf", "cad", "aud", "nzd", "cny", "hkd",
	"sgd", "sek", "nok", "dkk", "pln", "czk", "huf", "ron", "bgn", "try",
	"ils", "inr", "krw", "mxn", "brl", "zar", "isk", "php", "myr", "thb",
	"idr",
];

/** Common currency signs mapped to their ISO code. Only unambiguous single
 * glyphs are included (multi-letter symbols like "Kč"/"zł" collide with codes
 * and are typed as codes instead). */
export const CURRENCY_SYMBOLS: Record<string, string> = {
	"€": "eur",
	"$": "usd",
	"£": "gbp",
	"¥": "jpy",
	"₹": "inr",
	"₩": "krw",
	"₺": "try",
};

let cache: CurrencyRates | null = null;
let inflight: Promise<CurrencyRates | null> | null = null;

/** The last-fetched rates (possibly stale), or null if none were ever loaded. */
export function cachedRates(): CurrencyRates | null {
	return cache;
}

/**
 * Return fresh rates, fetching if the cache is missing or expired. Concurrent
 * callers share a single in-flight request. Never throws: on failure it returns
 * whatever is cached (possibly null).
 *
 * When `disabled` is true (the "disable external calls" setting), no network
 * request is made — only already-cached rates, if any, are returned. This is
 * the one outbound request Hearth makes, so the flag lives right at its source.
 */
export async function loadRates(disabled = false): Promise<CurrencyRates | null> {
	if (disabled) return cache;
	if (cache && Date.now() - cache.fetched < TTL_MS) return cache;
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			const res = await requestUrl({ url: ENDPOINT });
			const data = res.json as { base?: string; rates?: Record<string, number> };
			if (!data || !data.rates) return cache;
			const base = (data.base ?? "EUR").toLowerCase();
			const rates: Record<string, number> = { [base]: 1 };
			for (const [code, rate] of Object.entries(data.rates)) {
				if (typeof rate === "number" && Number.isFinite(rate)) {
					rates[code.toLowerCase()] = rate;
				}
			}
			cache = { base, rates, fetched: Date.now() };
			return cache;
		} catch {
			// Offline or blocked — keep any prior rates.
			return cache;
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}
