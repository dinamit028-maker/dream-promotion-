import { refundDay, saleDay, type ItemKind, type Line, type Refund, type Sale } from './money';

/**
 * Commissions per employee ("עמלות"), whole agorot.
 * The base is what the business really earned: the amount paid BEFORE VAT, after the sale's discount.
 * Each sale is split into treatments (services, packages, other) and products by its lines — the
 * discount spread over them by their share — and each part gets the employee's percent for it.
 * A refund lowers the base of the month it was made in (the products / treatments it gave back).
 */
export interface CommissionEmployee { id: string; name: string; servicePct: number; productPct: number }
export type CommissionCat = 'service' | 'product';
export interface CommissionRow {
  employeeId: string | null; name: string; servicePct: number; productPct: number;
  sales: number; gross: number; refunds: number;
  base: Record<CommissionCat, number>; commission: number;
}

const ag = (n: number) => Math.round((Number(n) || 0) * 100);
const sh = (a: number) => a / 100;
export const catOf = (kind: ItemKind | undefined): CommissionCat => (kind === 'product' ? 'product' : 'service');

/** split an amount (agorot) over lines by their gross share; the last line absorbs the rounding */
function split(amountA: number, lines: Line[], kindOf: (l: Line) => ItemKind | undefined): Record<CommissionCat, number> {
  const out: Record<CommissionCat, number> = { service: 0, product: 0 };
  const gross = lines.map((l) => ag(l.price) * Math.max(0, l.qty));
  const total = gross.reduce((a, g) => a + g, 0);
  if (!total) { out.service = amountA; return out; }
  let given = 0;
  lines.forEach((l, i) => {
    const part = i === lines.length - 1 ? amountA - given : Math.round((amountA * gross[i]) / total);
    given += part; out[catOf(kindOf(l))] += part;
  });
  return out;
}

/**
 * The month's report: one row per employee who sold (plus "ללא מוכר/ת" when sales had none).
 * kindOf resolves lines saved before 2.50 (no kind) — by the price list; unknown = a treatment.
 */
export function commissionReport(sales: Sale[], refunds: Refund[], employees: CommissionEmployee[], month: string,
  kindOf: (l: Line) => ItemKind | undefined = (l) => l.kind) {
  const rows = new Map<string, CommissionRow & { _base: Record<CommissionCat, number>; _gross: number; _ref: number }>();
  const emp = new Map(employees.map((e) => [e.id, e]));
  const rowOf = (id: string | null, name: string) => {
    const key = id ?? '';
    if (!rows.has(key)) {
      const e = id ? emp.get(id) : undefined;
      rows.set(key, { employeeId: id, name: e?.name ?? (name || 'ללא מוכר/ת'), servicePct: e?.servicePct ?? 0, productPct: e?.productPct ?? 0,
        sales: 0, gross: 0, refunds: 0, base: { service: 0, product: 0 }, commission: 0, _base: { service: 0, product: 0 }, _gross: 0, _ref: 0 });
    }
    return rows.get(key)!;
  };
  const netOf = (s: Pick<Sale, 'total' | 'vatAmount'>) => ag(s.total) - ag(s.vatAmount);

  for (const s of sales) {
    if (s.status !== 'paid' || !saleDay(s).startsWith(month)) continue;
    const r = rowOf(s.employeeId ?? null, s.employeeName ?? '');
    r.sales++; r._gross += ag(s.total);
    const parts = split(netOf(s), s.items, kindOf);
    r._base.service += parts.service; r._base.product += parts.product;
  }
  const byId = new Map(sales.map((s) => [s.id, s]));
  for (const f of refunds) {
    if (!refundDay(f).startsWith(month)) continue;
    const s = byId.get(f.saleId);
    if (!s) continue;
    const r = rowOf(s.employeeId ?? null, s.employeeName ?? '');
    const netA = ag(f.amount) - ag(f.vatAmount);
    // returned items say what came back; a refund of a sum comes back in the sale's own proportions
    const parts = split(netA, f.items.length ? f.items : s.items, kindOf);
    r._ref += ag(f.amount);
    r._base.service -= parts.service; r._base.product -= parts.product;
  }

  const out: CommissionRow[] = [...rows.values()].map(({ _base, _gross, _ref, ...r }) => {
    const comA = r.employeeId ? Math.round((_base.service * r.servicePct) / 100) + Math.round((_base.product * r.productPct) / 100) : 0;
    return { ...r, gross: sh(_gross), refunds: sh(_ref), base: { service: sh(_base.service), product: sh(_base.product) }, commission: sh(comA) };
  }).sort((a, b) => (a.employeeId ? 0 : 1) - (b.employeeId ? 0 : 1) || b.commission - a.commission || a.name.localeCompare(b.name, 'he'));
  const totals = out.reduce((t, r) => ({ sales: t.sales + r.sales, gross: sh(ag(t.gross) + ag(r.gross)), refunds: sh(ag(t.refunds) + ag(r.refunds)),
    commission: sh(ag(t.commission) + ag(r.commission)) }), { sales: 0, gross: 0, refunds: 0, commission: 0 });
  return { rows: out, totals };
}

/** CSV for payroll (UTF-8 BOM) */
export function commissionsCsv(rows: CommissionRow[], month: string) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [month, r.name, r.sales, r.gross.toFixed(2), r.refunds.toFixed(2), r.base.service.toFixed(2), r.servicePct, r.base.product.toFixed(2), r.productPct, r.commission.toFixed(2)].map(esc).join(','));
  return '﻿' + ['חודש,עובד/ת,מכירות,סה״כ כולל מע״מ,החזרים,בסיס טיפולים (לפני מע״מ),% טיפולים,בסיס מוצרים (לפני מע״מ),% מוצרים,עמלה', ...lines].join('\r\n');
}

/** a percent typed by the owner → 0–100 with up to two decimals */
export const cleanPct = (v: unknown) => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0; };
