import { parseBoiRates, type FxRate } from '@/features/finance/fx';

/**
 * The Bank of Israel's representative rates for the money lobby (2.98). The bank's public feed (no key): one call returns every
 * currency it publishes, each with its time. The answer is kept in memory for 30 minutes per server instance — the bank
 * publishes once a business day, in the afternoon — and when the bank does not answer, the last good answer is used for up to
 * 3 days: each rate carries its own date and the screen shows it, so an old rate is never passed off as today's. No answer and
 * nothing kept → null (the screen says the rates are not available; it never guesses one).
 */
export const BOI_RATES_URL = 'https://boi.org.il/PublicApi/GetExchangeRates?asJson=true';
const FRESH_MS = 30 * 60_000;
const KEEP_MS = 3 * 24 * 60 * 60_000;
const MAX_CHARS = 256 * 1024;

let kept: { at: number; rates: FxRate[] } | null = null;

export async function boiRates(now = Date.now(), fetcher: typeof fetch = fetch): Promise<FxRate[] | null> {
  if (kept && now - kept.at < FRESH_MS) return kept.rates;
  try {
    const res = await fetcher(BOI_RATES_URL, { cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const text = await res.text();
      const rates = text.length <= MAX_CHARS ? parseBoiRates(JSON.parse(text)) : [];
      if (rates.length) {
        kept = { at: now, rates };
        return rates;
      }
    }
  } catch { /* the bank did not answer, or not in its usual form */ }
  return kept && now - kept.at < KEEP_MS ? kept.rates : null;
}

/** for tests: forget the kept answer */
export function resetFxRates() { kept = null; }
