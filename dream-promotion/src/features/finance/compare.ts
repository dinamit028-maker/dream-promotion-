import { csv } from './reports';

/**
 * "השוואת סניפים" (2.93, migration 20261011004800 — T12ד of docs/FINANCE_ADDITIONS_HE.md): each location the member may use,
 * side by side, in a period — from location_compare() in the database (revenue and estimated profit by finance_summary's own
 * rules, the register's and the site's sales and refunds, the best-selling products, the stock now). Nothing is recomputed
 * here: these functions read the answer, total it and write the file. The other reports already follow the location picked at
 * the top (finance_summary reads through the location gates of migration 4600).
 */
export interface CompareItem { itemId: string | null; name: string; qty: number; total: number }
export interface CompareRow {
  id: string; name: string; active: boolean; main: boolean;
  revenue: { net: number; vat: number }; expenses: { net: number; cost: number }; profit: number;
  sales: { count: number; total: number; online: number; refunds: number; refundCount: number };
  items: CompareItem[]; stock: { units: number; value: number };
}
export interface Comparison { from: string; to: string; vat: boolean; locations: CompareRow[] }

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** the database's answer → the screen's shape (lenient: a missing field is 0) */
export function toComparison(raw: unknown): Comparison | null {
  const r = obj(raw);
  if (!Array.isArray(r.locations)) return null;
  return {
    from: s(r.from), to: s(r.to), vat: Boolean(r.vat),
    locations: r.locations.map((x) => {
      const l = obj(x), rev = obj(l.revenue), ex = obj(l.expenses), sa = obj(l.sales), st = obj(l.stock);
      return {
        id: s(l.id), name: s(l.name), active: l.active !== false, main: Boolean(l.main),
        revenue: { net: n(rev.net), vat: n(rev.vat) }, expenses: { net: n(ex.net), cost: n(ex.cost) }, profit: n(l.profit),
        sales: { count: n(sa.count), total: n(sa.total), online: n(sa.online), refunds: n(sa.refunds), refundCount: n(sa.refundCount) },
        items: (Array.isArray(l.items) ? l.items : []).map((i) => { const o = obj(i); return { itemId: o.itemId ? s(o.itemId) : null, name: s(o.name), qty: n(o.qty), total: n(o.total) }; }),
        stock: { units: n(st.units), value: n(st.value) },
      };
    }),
  };
}

const ag = (v: number) => Math.round(v * 100);
/** the business's total of the locations shown (agorot-exact) */
export function compareTotals(rows: CompareRow[]) {
  const sum = (f: (r: CompareRow) => number) => rows.reduce((a, r) => a + ag(f(r)), 0) / 100;
  return {
    revenue: sum((r) => r.revenue.net), vat: sum((r) => r.revenue.vat), expenses: sum((r) => r.expenses.cost), profit: sum((r) => r.profit),
    sales: rows.reduce((a, r) => a + r.sales.count, 0), salesTotal: sum((r) => r.sales.total), refunds: sum((r) => r.sales.refunds),
    units: rows.reduce((a, r) => a + r.stock.units, 0), value: sum((r) => r.stock.value),
  };
}
/** a location's part of the whole, as people say it ("42%"); '' when there is no whole */
export function shareOf(part: number, whole: number): string {
  if (!whole || !Number.isFinite(part / whole)) return '';
  return `${Math.round((part / whole) * 100)}%`;
}
/** the location that leads by a measure (null with fewer than two, or a tie at the top) */
export function leader(rows: CompareRow[], by: (r: CompareRow) => number): string | null {
  if (rows.length < 2) return null;
  const sorted = [...rows].sort((a, b) => by(b) - by(a));
  return by(sorted[0]) > by(sorted[1]) ? sorted[0].id : null;
}

const money = (v: number) => v.toFixed(2);
const day = (d: string) => (d ? d.split('-').reverse().join('/') : '');
/** the comparison as a file for Excel (a row a location, and the total) */
export function compareCsv(c: Comparison): string {
  const t = compareTotals(c.locations);
  const head = ['סניף', 'מתאריך', 'עד תאריך', 'הכנסות (לפני מע״מ)', 'הוצאות', 'רווח משוער', 'מכירות', 'סכום המכירות', 'מהן באתר', 'החזרים',
    'יחידות במלאי', 'שווי המלאי (במחיר מכירה)', 'הנמכרים ביותר'];
  const rows = c.locations.map((r) => [r.name + (r.active ? '' : ' (סגור)'), day(c.from), day(c.to), money(r.revenue.net), money(r.expenses.cost), money(r.profit),
    r.sales.count, money(r.sales.total), r.sales.online, money(r.sales.refunds), r.stock.units, money(r.stock.value),
    r.items.slice(0, 5).map((i) => `${i.name} ×${i.qty}`).join(' · ')]);
  rows.push(['סה״כ', day(c.from), day(c.to), money(t.revenue), money(t.expenses), money(t.profit), t.sales, money(t.salesTotal), '', money(t.refunds), t.units, money(t.value), '']);
  return csv(head, rows);
}
