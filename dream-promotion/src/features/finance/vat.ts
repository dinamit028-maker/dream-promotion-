/**
 * The VAT engine — the one place VAT is computed: the register, documents, refunds, quotes and expenses all use it.
 * Whole agorot (never 0.1 + 0.2). Israel's standard rate is kept with its history, so a document of 2024 is
 * checked at the rate of its day. The database checks the same rule again on every document it receives
 * (|VAT − amount before VAT × rate| ≤ 1 agora — migration 20261004003100).
 */
export const ag = (n: number) => Math.round((Number(n) || 0) * 100);
export const sh = (a: number) => a / 100;

/** Israel's standard VAT rate since 2012 (Eilat and other exceptions are a business setting, not a date). */
export const VAT_HISTORY: readonly { from: string; rate: number }[] = [
  { from: '2012-09-01', rate: 17 },
  { from: '2013-06-02', rate: 18 },
  { from: '2015-10-01', rate: 17 },
  { from: '2025-01-01', rate: 18 },
];

/** the legal standard rate on a day (YYYY-MM-DD) */
export function legalVatRate(date: string): number {
  let rate = VAT_HISTORY[0].rate;
  for (const v of VAT_HISTORY) if (v.from <= date) rate = v.rate;
  return rate;
}

/** the VAT inside a price that includes it (agorot → agorot) */
export const vatOfGross = (grossA: number, rate: number) => (rate ? Math.round((grossA * rate) / (100 + rate)) : 0);
/** the price before VAT inside a price that includes it */
export const netOfGross = (grossA: number, rate: number) => grossA - vatOfGross(grossA, rate);
/** the VAT on an amount before VAT */
export const vatOfNet = (netA: number, rate: number) => (rate ? Math.round((netA * rate) / 100) : 0);

/** the database's own test of a document's VAT, in agorot (same tolerance: one agora) */
export const vatMatches = (afterA: number, vatA: number, rate: number) => Math.abs(vatA - Math.round((afterA * rate) / 100)) <= 1;

/** a warning when the business's rate is not the legal one of that day (Eilat businesses set 0 on purpose) */
export function rateWarning(rate: number, date: string, chargesVat: boolean): string | null {
  if (!chargesVat) return null;
  const legal = legalVatRate(date);
  if (rate === legal) return null;
  if (rate === 0) return 'שיעור מע״מ 0% — נכון רק לעסק שפטור ממע״מ לפי מיקומו (למשל אילת). כדאי לוודא עם רו״ח.';
  return `שיעור המע״מ שמוגדר (${rate}%) שונה מהשיעור החוקי היום (${legal}%). כדאי לעדכן בהגדרות.`;
}
