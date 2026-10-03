import { israelParts } from '@/lib/il-time';
import { paymentsOf, saleDay, summarize, type Sale } from './money';

/**
 * Close of day ("סגירת יום"): the cash drawer is counted against what should be in it.
 * Expected cash = opening cash + the cash that stayed in the drawer today. A cash payment is
 * recorded net (the change already given back), and a split payment lists its cash part net too —
 * so "cash that stayed" is the sum of today's cash payments. Whole agorot throughout.
 */
export interface Shift {
  id: string; openedAt: string; openingCash: number; closedAt: string | null;
  countedCash: number | null; expectedCash: number | null; difference: number | null; note: string; employeeName: string;
}
export const toShift = (r: any): Shift => ({
  id: r.id, openedAt: r.opened_at, openingCash: Number(r.opening_cash), closedAt: r.closed_at ?? null,
  countedCash: r.counted_cash == null ? null : Number(r.counted_cash), expectedCash: r.expected_cash == null ? null : Number(r.expected_cash),
  difference: r.difference == null ? null : Number(r.difference), note: r.note ?? '', employeeName: r.employee_name ?? '',
});

const ag = (n: number) => Math.round((Number(n) || 0) * 100);
const sh = (a: number) => a / 100;

/** the Israeli calendar day a shift belongs to (the day it was opened) */
export const shiftDay = (s: Pick<Shift, 'openedAt'>) => israelParts(new Date(s.openedAt)).date;

/** cash that stayed in the drawer on that Israeli day: paid sales only, cash part of split payments included */
export function cashIn(sales: Sale[], day: string) {
  let a = 0;
  for (const s of sales) {
    if (s.status !== 'paid' || saleDay(s) !== day) continue;
    for (const p of paymentsOf(s)) if (p.method === 'cash') a += ag(p.amount);
  }
  return sh(a);
}

export const expectedCash = (openingCash: number, sales: Sale[], day: string) => sh(ag(openingCash) + ag(cashIn(sales, day)));

/** counted − expected: below zero the drawer is short, above zero there is extra cash */
export function cashDifference(counted: number, expected: number) {
  const d = ag(counted) - ag(expected);
  return { difference: sh(d), kind: d < 0 ? 'short' as const : d > 0 ? 'over' as const : 'even' as const };
}

export interface DocLite { docType: number; docNumber: number; issuedAt: string }
/** the numbers of the documents issued that day, per type: first, last and how many */
export function docRanges(docs: DocLite[], day: string) {
  const by = new Map<number, number[]>();
  for (const d of docs) if (israelParts(new Date(d.issuedAt)).date === day) by.set(d.docType, [...(by.get(d.docType) ?? []), Number(d.docNumber)]);
  return [...by.entries()].sort((a, b) => a[0] - b[0])
    .map(([docType, n]) => ({ docType, from: Math.min(...n), to: Math.max(...n), count: n.length }));
}

/** everything the close-of-day report shows */
export function daySummary(o: { sales: Sale[]; docs: DocLite[]; day: string; openingCash: number }) {
  const sum = summarize(o.sales, o.day, o.day);
  const cash = cashIn(o.sales, o.day);
  return { ...sum, cashIn: cash, expectedCash: expectedCash(o.openingCash, o.sales, o.day), docs: docRanges(o.docs, o.day) };
}
