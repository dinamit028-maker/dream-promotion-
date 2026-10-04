import type { Doc, DocLine } from '@/features/documents/openformat';
import { DOC_LABEL, creditFor } from '@/features/documents/documents';
import { dealerDigits, validIsraeliId } from '@/features/register/billing';
import { israelParts } from '@/lib/il-time';
import { ag, netOfGross, sh, vatOfGross, vatOfNet } from './vat';
import { canIssue, chargesVat, type EntityType } from './rules';
import { chequeError, toDocPayment, type PaymentEntry } from './payments';

/**
 * The accounting engine's document builder: what the user typed → a legal document, agorot-exact.
 * The result satisfies every rule the database checks on insert (migration 20261004003100):
 *   lines add up to "before discount"; after discount = before − discount; total = after + VAT;
 *   VAT = after × rate (± 1 agora); a receipt's payments = its total; no VAT on a receipt or for an exempt dealer.
 * Used by the document center, quotes, receipts for invoices and credit invoices. The register keeps
 * docFromSale (documents.ts), which follows the same rules.
 */
export type NewDoc = Omit<Doc, 'docNumber' | 'linkNo' | 'issuedAt'> & { dueDate?: string | null; notes?: string; customerEmail?: string };
export interface ComposeLine { name: string; qty: number; unitPrice: number; itemId?: string }
export interface ComposeCustomer { name: string; phone?: string; email?: string; dealer?: string; street?: string; city?: string }
export interface Discount { kind: 'sum' | 'percent'; value: number }
export interface ComposeInput {
  docType: number; entity: EntityType; vatRate: number; pricesIncludeVat: boolean;
  lines: ComposeLine[]; discount?: Discount; customer: ComposeCustomer; payments?: PaymentEntry[];
  docDate: string; dueDate?: string | null; notes?: string; today?: string;
}
export interface Totals { subtotal: number; discount: number; beforeDiscount: number; discountExVat: number; afterDiscount: number; vatRate: number; vatAmount: number; total: number }
export type ComposeResult = { ok: true; doc: NewDoc; totals: Totals } | { ok: false; errors: string[] };

const ils = (n: number) => `₪${n.toLocaleString('he-IL', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const todayIL = () => israelParts(Date.now()).date;
/** a line the user started (a name or a price) — empty rows of the form are ignored */
const started = (l: ComposeLine) => Boolean(l.name.trim()) || Boolean(l.unitPrice);

/** lines and totals. prices as typed: including VAT (shops) or before VAT (business to business) */
export function computeLines(lines: ComposeLine[], o: { pricesIncludeVat: boolean; discount?: Discount; rate: number }): { lines: DocLine[]; totals: Totals } {
  const rate = o.rate || 0;
  const clean = lines.filter((l) => l.name.trim() && l.qty > 0 && l.unitPrice >= 0);
  const lineA = clean.map((l) => Math.round(ag(l.unitPrice) * l.qty));
  const subA = lineA.reduce((a, x) => a + x, 0);
  const d = o.discount ?? { kind: 'sum', value: 0 };
  const dRaw = d.kind === 'percent' ? Math.round((subA * Math.min(100, Math.max(0, d.value || 0))) / 100) : ag(Math.max(0, d.value || 0));
  const discA = Math.min(subA, dRaw);
  let netLines = [...lineA];
  let beforeA: number, afterA: number, vatA: number, totalA: number;
  if (!rate) {
    beforeA = subA; afterA = subA - discA; vatA = 0; totalA = afterA;
  } else if (o.pricesIncludeVat) {
    totalA = subA - discA; vatA = vatOfGross(totalA, rate); afterA = totalA - vatA;
    netLines = lineA.map((g) => netOfGross(g, rate));
    beforeA = netLines.reduce((a, x) => a + x, 0);
    // rounding per line: the biggest line absorbs the agorot, so the lines always add up (and never go below after)
    if (netLines.length && (discA === 0 || beforeA < afterA)) {
      const big = netLines.indexOf(Math.max(...netLines));
      netLines[big] += afterA - beforeA; beforeA = afterA;
    }
  } else {
    beforeA = subA; afterA = subA - discA; vatA = vatOfNet(afterA, rate); totalA = afterA + vatA;
  }
  const docLines: DocLine[] = clean.map((l, i) => ({
    name: l.name.trim().slice(0, 120), qty: l.qty, unitPriceExVat: sh(Math.round(netLines[i] / l.qty)), discountExVat: 0,
    totalExVat: sh(netLines[i]), vatRate: rate, kind: 1, ...(l.itemId ? { itemId: l.itemId } : {}),
  }));
  return {
    lines: docLines,
    totals: { subtotal: sh(subA), discount: sh(discA), beforeDiscount: sh(beforeA), discountExVat: sh(beforeA - afterA), afterDiscount: sh(afterA), vatRate: rate, vatAmount: sh(vatA), total: sh(totalA) },
  };
}

function customerErrors(c: ComposeCustomer, needName: boolean): string[] {
  const e: string[] = [];
  if (needName && !c.name.trim()) e.push('חסר שם הלקוח (מי צריך לשלם)');
  const d = dealerDigits(c.dealer ?? '');
  if (d && (d.length !== 9 || !validIsraeliId(d))) e.push('מספר העוסק / ח.פ של הלקוח לא תקין (9 ספרות עם ספרת ביקורת)');
  if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email.trim())) e.push('כתובת המייל של הלקוח לא תקינה');
  return e;
}
function paymentErrors(payments: PaymentEntry[], totalA: number, today: string): string[] {
  const e: string[] = [];
  if (!payments.length) return ['איך שולם? צריך לפחות תשלום אחד'];
  for (const p of payments) {
    if (!(p.amount > 0)) e.push('כל תשלום צריך סכום גדול מאפס');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || p.date > today) e.push('תאריך תשלום לא תקין (לא בעתיד)');
    if (p.method === 'cheque') { const c = chequeError(p.cheque); if (c) e.push(c); }
  }
  const paidA = payments.reduce((a, p) => a + ag(p.amount), 0);
  if (!e.length && paidA !== totalA) e.push(`סכום התשלומים (${ils(sh(paidA))}) שונה מסכום המסמך (${ils(sh(totalA))})`);
  return e;
}
const customerOf = (c: ComposeCustomer) => ({
  customerName: c.name.trim().slice(0, 120), customerPhone: (c.phone ?? '').trim().slice(0, 30), customerDealer: dealerDigits(c.dealer ?? ''),
  customerStreet: (c.street ?? '').trim().slice(0, 120), customerCity: (c.city ?? '').trim().slice(0, 60), customerEmail: (c.email ?? '').trim().slice(0, 120),
});

/** a new 305 / 320 / 300 / 400 from the document center */
export function composeDocument(input: ComposeInput): ComposeResult {
  const t = input.docType;
  const today = input.today ?? todayIL();
  const errors: string[] = [];
  if (t === 330 || !canIssue(input.entity, t)) errors.push(t === 330 ? 'חשבונית זיכוי מופקת מתוך החשבונית המקורית' : 'סוג המסמך הזה לא מתאים לסוג העסק');
  const rate = chargesVat(input.entity) && t !== 400 ? input.vatRate : 0;
  errors.push(...customerErrors(input.customer, t === 305 || t === 300));
  const bad = input.lines.filter(started).find((l) => !l.name.trim() || !(l.qty > 0) || !(l.unitPrice >= 0));
  if (bad) errors.push('בכל שורה: תיאור, כמות גדולה מאפס ומחיר');
  const { lines, totals } = computeLines(input.lines, { pricesIncludeVat: input.pricesIncludeVat, discount: input.discount, rate });
  if (!lines.length) errors.push('צריך לפחות שורה אחת');
  else if (totals.total <= 0) errors.push('הסכום חייב להיות גדול מאפס');
  const receipt = t === 320 || t === 400;
  if (receipt && lines.length && totals.total > 0) errors.push(...paymentErrors(input.payments ?? [], ag(totals.total), today));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.docDate) || input.docDate > today) errors.push('תאריך המסמך לא יכול להיות בעתיד');
  if ((t === 305 || t === 300) && input.dueDate && input.dueDate < input.docDate) errors.push('מועד התשלום לפני תאריך המסמך');
  if ((input.notes ?? '').length > 1000) errors.push('ההערות ארוכות מדי (עד 1,000 תווים)');
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  return {
    ok: true, totals,
    doc: {
      docType: t, docDate: input.docDate, ...customerOf(input.customer),
      beforeDiscount: totals.beforeDiscount, discount: totals.discountExVat, afterDiscount: totals.afterDiscount, vatAmount: totals.vatAmount, total: totals.total,
      issuedBy: '', lines, payments: receipt ? (input.payments ?? []).map(toDocPayment) : [],
      dueDate: t === 305 || t === 300 ? input.dueDate || null : null, notes: (input.notes ?? '').trim(),
    },
  };
}

/** what an open invoice (305 / 300) owes, for its receipt */
export interface OpenInvoice extends Pick<Doc, 'docType' | 'docNumber' | 'customerName' | 'customerPhone' | 'customerDealer' | 'customerStreet' | 'customerCity' | 'lines' | 'beforeDiscount' | 'discount' | 'afterDiscount' | 'vatAmount' | 'total'> { balance: number }

/**
 * Payment of an open invoice. A 305 (tax invoice) gets a receipt (400). A 300 (transaction invoice) of a VAT business
 * gets a tax invoice-receipt (320) — the whole of it as it was, or a part as one line; of an exempt dealer, a receipt.
 */
export function composeReceipt(inv: OpenInvoice, o: { entity: EntityType; vatRate: number; payments: PaymentEntry[]; docDate: string; notes?: string; today?: string }): ComposeResult {
  const today = o.today ?? todayIL();
  const paidA = o.payments.reduce((a, p) => a + ag(p.amount), 0);
  const errors: string[] = [];
  if (inv.docType !== 305 && inv.docType !== 300) errors.push('קבלה מופקת על חשבונית מס או חשבונית עסקה');
  if (paidA <= 0) errors.push('הסכום חייב להיות גדול מאפס');
  if (paidA > ag(inv.balance)) errors.push(`הסכום גדול מהיתרה לתשלום (${ils(inv.balance)})`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.docDate) || o.docDate > today) errors.push('תאריך המסמך לא יכול להיות בעתיד');
  errors.push(...paymentErrors(o.payments, paidA, today));
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  const cust = { customerName: inv.customerName, customerPhone: inv.customerPhone ?? '', customerDealer: inv.customerDealer ?? '', customerStreet: inv.customerStreet ?? '', customerCity: inv.customerCity ?? '' };
  const payments = o.payments.map(toDocPayment);
  const ref = `${DOC_LABEL[inv.docType]} מס׳ ${inv.docNumber}`;
  if (inv.docType === 300 && chargesVat(o.entity)) {
    const whole = paidA === ag(inv.total) && ag(inv.balance) === ag(inv.total);
    if (whole) {
      const totals = { subtotal: inv.total, discount: inv.discount, beforeDiscount: inv.beforeDiscount, discountExVat: inv.discount, afterDiscount: inv.afterDiscount, vatRate: inv.lines[0]?.vatRate ?? o.vatRate, vatAmount: inv.vatAmount, total: inv.total };
      return { ok: true, totals, doc: { docType: 320, docDate: o.docDate, ...cust, beforeDiscount: inv.beforeDiscount, discount: inv.discount, afterDiscount: inv.afterDiscount,
        vatAmount: inv.vatAmount, total: inv.total, issuedBy: '', lines: inv.lines.map((l) => ({ ...l })), payments, notes: (o.notes ?? '').trim() || `על פי ${ref}` } };
    }
    const vatA = vatOfGross(paidA, o.vatRate), afterA = paidA - vatA;
    const line: DocLine = { name: `תשלום חלקי — ${ref}`, qty: 1, unitPriceExVat: sh(afterA), discountExVat: 0, totalExVat: sh(afterA), vatRate: o.vatRate, kind: 1 };
    return { ok: true, totals: { subtotal: sh(paidA), discount: 0, beforeDiscount: sh(afterA), discountExVat: 0, afterDiscount: sh(afterA), vatRate: o.vatRate, vatAmount: sh(vatA), total: sh(paidA) },
      doc: { docType: 320, docDate: o.docDate, ...cust, beforeDiscount: sh(afterA), discount: 0, afterDiscount: sh(afterA), vatAmount: sh(vatA), total: sh(paidA), issuedBy: '', lines: [line], payments, notes: (o.notes ?? '').trim() } };
  }
  const line: DocLine = { name: `תשלום עבור ${ref}`, qty: 1, unitPriceExVat: sh(paidA), discountExVat: 0, totalExVat: sh(paidA), vatRate: 0, kind: 1 };
  return { ok: true, totals: { subtotal: sh(paidA), discount: 0, beforeDiscount: sh(paidA), discountExVat: 0, afterDiscount: sh(paidA), vatRate: 0, vatAmount: 0, total: sh(paidA) },
    doc: { docType: 400, docDate: o.docDate, ...cust, beforeDiscount: sh(paidA), discount: 0, afterDiscount: sh(paidA), vatAmount: 0, total: sh(paidA), issuedBy: '', lines: [line], payments, notes: (o.notes ?? '').trim() } };
}

export type CreditMode = { kind: 'full' } | { kind: 'amount'; amount: number } | { kind: 'lines'; qty: number[]; restock: boolean };
/**
 * A credit invoice (330) for a tax invoice (305 / 320): the whole of what is left, a sum (VAT inside it), or chosen lines
 * (their share of the invoice's discount included; products can go back to stock). Never beyond what is left to credit.
 */
export function composeCredit(base: Doc, mode: CreditMode, creditedSoFar: number, docDate: string, o: { reason?: string; today?: string } = {}): ComposeResult {
  const today = o.today ?? todayIL();
  if (base.docType !== 305 && base.docType !== 320) return { ok: false, errors: ['חשבונית זיכוי מופקת על חשבונית מס (305) או חשבונית מס / קבלה (320)'] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(docDate) || docDate > today) return { ok: false, errors: ['תאריך המסמך לא יכול להיות בעתיד'] };
  const leftA = ag(base.total) - ag(creditedSoFar);
  if (leftA <= 0) return { ok: false, errors: ['החשבונית כבר זוכתה במלואה'] };
  const rate = base.lines[0]?.vatRate ?? 0;
  const ref = `${DOC_LABEL[base.docType]} מס׳ ${base.docNumber}`;
  const notes = (o.reason ?? '').trim().slice(0, 1000);
  const shell = { docType: 330, docDate, customerName: base.customerName, customerPhone: base.customerPhone ?? '', customerDealer: base.customerDealer ?? '',
    customerStreet: base.customerStreet ?? '', customerCity: base.customerCity ?? '', baseDocType: base.docType, baseDocNumber: base.docNumber, issuedBy: base.issuedBy ?? '', payments: [] };
  const done = (lines: DocLine[], afterA: number, vatA: number): ComposeResult => ({
    ok: true, totals: { subtotal: sh(afterA + vatA), discount: 0, beforeDiscount: sh(afterA), discountExVat: 0, afterDiscount: sh(afterA), vatRate: rate, vatAmount: sh(vatA), total: sh(afterA + vatA) },
    doc: { ...shell, beforeDiscount: sh(afterA), discount: 0, afterDiscount: sh(afterA), vatAmount: sh(vatA), total: sh(afterA + vatA), lines, notes },
  });
  if (mode.kind === 'full' && ag(creditedSoFar) === 0) {
    const c = creditFor(base, docDate);
    return { ok: true, totals: { subtotal: base.total, discount: base.discount, beforeDiscount: base.beforeDiscount, discountExVat: base.discount, afterDiscount: base.afterDiscount, vatRate: rate, vatAmount: base.vatAmount, total: base.total },
      doc: { ...c, payments: [], notes } };
  }
  if (mode.kind === 'full' || mode.kind === 'amount') {
    const amountA = mode.kind === 'full' ? leftA : ag(mode.amount);
    if (amountA <= 0) return { ok: false, errors: ['הסכום חייב להיות גדול מאפס'] };
    if (amountA > leftA) return { ok: false, errors: [`אפשר לזכות עד ${ils(sh(leftA))}`] };
    const vatA = vatOfGross(amountA, rate), afterA = amountA - vatA;
    return done([{ name: `זיכוי — ${ref}`, qty: 1, unitPriceExVat: sh(afterA), discountExVat: 0, totalExVat: sh(afterA), vatRate: rate, kind: 1 }], afterA, vatA);
  }
  // chosen lines: their share of what the customer actually paid (the invoice's discount included), as a gross sum,
  // so one of two creams of ₪100 at 10% off credits exactly ₪90. The lines carry the amount before VAT.
  const parts = base.lines.map((l, i) => {
    const q = Math.max(0, Math.min(l.qty, Number(mode.qty[i]) || 0));
    return { l, q, netA: q ? Math.round((ag(l.totalExVat) * q) / l.qty) : 0 };
  }).filter((p) => p.q > 0);
  if (!parts.length) return { ok: false, errors: ['לא נבחר מה לזכות'] };
  const chosenA = parts.reduce((a, p) => a + p.netA, 0);
  const totalA = ag(base.beforeDiscount) ? Math.round((ag(base.total) * chosenA) / ag(base.beforeDiscount)) : 0;
  if (totalA <= 0) return { ok: false, errors: ['הסכום חייב להיות גדול מאפס'] };
  if (totalA > leftA) return { ok: false, errors: [`אפשר לזכות עד ${ils(sh(leftA))}`] };
  const vatA = vatOfGross(totalA, rate), afterA = totalA - vatA;
  const netLines = parts.map((p) => (chosenA ? Math.round((afterA * p.netA) / chosenA) : 0));
  const big = netLines.indexOf(Math.max(...netLines));
  netLines[big] += afterA - netLines.reduce((a, x) => a + x, 0);
  const lines: DocLine[] = parts.map((p, k) => ({
    name: p.l.name, qty: p.q, unitPriceExVat: sh(Math.round(netLines[k] / p.q)), discountExVat: 0, totalExVat: sh(netLines[k]), vatRate: rate, kind: 1,
    ...(p.l.itemId ? { itemId: p.l.itemId, ...(mode.restock ? { restock: true } : {}) } : {}),
  }));
  return done(lines, afterA, vatA);
}

/** the database's own checks, in code — what tests use to prove every builder above stays inside them */
export function docInvariants(d: Pick<NewDoc, 'docType' | 'lines' | 'payments' | 'beforeDiscount' | 'discount' | 'afterDiscount' | 'vatAmount' | 'total'>, rate: number): string[] {
  const e: string[] = [];
  const linesA = d.lines.reduce((a, l) => a + ag(l.totalExVat), 0);
  if (d.lines.length && linesA !== ag(d.beforeDiscount)) e.push(`lines ${linesA} ≠ before ${ag(d.beforeDiscount)}`);
  if (ag(d.afterDiscount) !== ag(d.beforeDiscount) - ag(d.discount)) e.push('after ≠ before − discount');
  if (ag(d.total) !== ag(d.afterDiscount) + ag(d.vatAmount)) e.push('total ≠ after + vat');
  if (d.discount < 0 || d.beforeDiscount < 0 || d.vatAmount < 0 || d.total <= 0) e.push('negative / zero');
  if (Math.abs(ag(d.vatAmount) - Math.round((ag(d.afterDiscount) * rate) / 100)) > 1) e.push(`vat ${ag(d.vatAmount)} vs ${Math.round((ag(d.afterDiscount) * rate) / 100)}`);
  if (d.docType === 320 || d.docType === 400) {
    const paidA = d.payments.reduce((a, p) => a + ag(p.amount), 0);
    if (Math.abs(paidA - ag(d.total)) > 1) e.push('payments ≠ total');
  } else if (d.payments.length) e.push('payments on a non-receipt');
  return e;
}
