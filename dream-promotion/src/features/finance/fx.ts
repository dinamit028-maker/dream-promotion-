import { israelParts } from '@/lib/il-time';

/**
 * Foreign currencies in the money lobby (2.98): the Bank of Israel's representative rates ("שער יציג") and a converter both ways,
 * so a business does not look them up elsewhere. The rates reach the screen only from the server (/api/finance/fx — it reads the
 * bank's public feed; the browser never calls the bank), and every rate is shown with its date.
 * Converting is exact: the typed amount and the rate become whole millionths (BigInt), and the result is rounded once, half up,
 * to the minor unit of the currency it is in (ISO 4217: the yen 0, the Jordanian dinar 3, the shekel and the rest 2).
 * A helper only: nothing here is a document or a payment — money in Dream stays in shekels (documents in another currency are
 * not built: docs/FINANCE_ADDITIONS_HE.md §3).
 */
export interface FxRate {
  /** ISO 4217, e.g. USD */
  code: string;
  /** shekels per `unit` of the currency — the bank's currentExchangeRate */
  rate: number;
  /** 1 for most; the bank quotes the yen per 100 and the Lebanese pound per 10 */
  unit: number;
  /** when the bank published it (an ISO instant) */
  updated: string;
}

export const FX_UNAVAILABLE = 'שערי המטבע לא זמינים כרגע. נסו שוב מאוחר יותר.';

const NAMES: Record<string, string> = {
  USD: 'דולר ארה״ב', EUR: 'אירו', GBP: 'לירה שטרלינג', CHF: 'פרנק שוויצרי', JPY: 'ין יפני', CAD: 'דולר קנדי', AUD: 'דולר אוסטרלי',
  DKK: 'כתר דני', NOK: 'כתר נורבגי', SEK: 'כתר שוודי', ZAR: 'ראנד דרום אפריקאי', JOD: 'דינר ירדני', LBP: 'לירה לבנונית', EGP: 'לירה מצרית',
};
const SHORT: Record<string, string> = { USD: 'דולר', EUR: 'אירו', GBP: 'ליש״ט' };
/** the currency's Hebrew name (the code, for one we have no name for) */
export const fxName = (code: string) => NAMES[code] ?? code;
/** a short name for the lobby's line */
export const fxShort = (code: string) => SHORT[code] ?? fxName(code);
/** the ones most businesses need — first in the list, and on the lobby's line */
export const FX_MAIN = ['USD', 'EUR', 'GBP'];
const ORDER = [...FX_MAIN, 'CHF', 'JPY', 'CAD', 'AUD'];
/** digits after the point of the currency's smallest coin (ISO 4217) */
export const fxDigits = (code: string) => (code === 'JPY' ? 0 : code === 'JOD' ? 3 : 2);

const number = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : Number.NaN);

/** the bank's lastUpdate ("2026-10-12T12:23:17.1063397Z") → an ISO instant; more than 3 fraction digits are cut; no zone = UTC */
function instant(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/(\.\d{3})\d+/, '$1');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.test(s)) return null;
  const t = Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** only what is whole — a code of 3 letters (not the shekel, once each), a positive rate, a whole positive unit, a time — the
 *  rest is left out, never guessed; the common currencies first */
export function cleanRates(list: unknown): FxRate[] {
  if (!Array.isArray(list)) return [];
  const out: FxRate[] = [];
  const seen = new Set<string>();
  for (const x of list as Record<string, unknown>[]) {
    const code = typeof x?.code === 'string' ? x.code.trim().toUpperCase() : '';
    const rate = number(x?.rate);
    const unit = number(x?.unit);
    const updated = instant(x?.updated);
    if (!/^[A-Z]{3}$/.test(code) || code === 'ILS' || seen.has(code)) continue;
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100_000) continue;
    if (!Number.isInteger(unit) || unit < 1 || unit > 10_000) continue;
    if (!updated) continue;
    seen.add(code);
    out.push({ code, rate, unit, updated });
  }
  const rank = (c: string) => (ORDER.includes(c) ? ORDER.indexOf(c) : ORDER.length);
  return out.sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code));
}

/** the bank's public feed ({ exchangeRates: [{ key, currentExchangeRate, unit, lastUpdate, … }] }) → the rates */
export function parseBoiRates(json: unknown): FxRate[] {
  const list = (json as { exchangeRates?: unknown } | null)?.exchangeRates;
  if (!Array.isArray(list)) return [];
  return cleanRates(list.map((x: Record<string, unknown>) => ({ code: x?.key, rate: x?.currentExchangeRate, unit: x?.unit, updated: x?.lastUpdate })));
}

const MILLION = BigInt(1_000_000);
const TWO = BigInt(2);
const TEN = BigInt(10);

/** a typed amount → whole millionths; null unless it is a plain number that is not negative: digits, one point, up to 6 digits
 *  after it, and commas only between thousands ("1,234.5" — never "1,5", which could mean one and a half) */
export function parseAmount(text: string): bigint | null {
  let s = text.replace(/\s/g, '');
  if (s.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return null;
    s = s.replace(/,/g, '');
  }
  if (!/^\d{0,12}(\.\d{0,6})?$/.test(s) || !/\d/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole || '0') * MILLION + BigInt(`${frac}000000`.slice(0, 6));
}

const roundHalfUp = (n: bigint, d: bigint) => (n * TWO + d) / (d * TWO);

export type FxDirection = 'toIls' | 'fromIls';
/** the amount (millionths) in the other currency: whole units of its smallest coin, rounded once, half up */
export function convert(amount: bigint, r: FxRate, dir: FxDirection): { minor: bigint; digits: number } {
  const rate = BigInt(Math.round(r.rate * 1_000_000)); // shekels per `unit`, in millionths
  const unit = BigInt(r.unit);
  const digits = dir === 'toIls' ? 2 : fxDigits(r.code);
  const scale = TEN ** BigInt(digits);
  return dir === 'toIls'
    ? { minor: roundHalfUp(amount * rate * scale, unit * MILLION * MILLION), digits }
    : { minor: roundHalfUp(amount * unit * scale, rate), digits };
}

/** whole units of the smallest coin → "1,234.56" (the way the money screens write numbers) */
export function formatMinor(minor: bigint, digits: number): string {
  const neg = minor < BigInt(0);
  const m = neg ? -minor : minor;
  const scale = TEN ** BigInt(digits);
  const whole = (m / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}${digits ? `.${(m % scale).toString().padStart(digits, '0')}` : ''}`;
}

/** the bank's rate as it publishes it: shekels per `unit` */
export const rateText = (r: FxRate) => r.rate.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 });
/** how much of the currency one shekel buys, at that rate */
export const inverseText = (r: FxRate) => (r.unit / r.rate).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
/** the Israeli date of the rate (YYYY-MM-DD) */
export const fxDay = (r: Pick<FxRate, 'updated'>) => israelParts(new Date(r.updated)).date;
