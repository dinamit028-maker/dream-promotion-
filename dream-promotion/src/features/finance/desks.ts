import { payLabel, type PayMethod } from './payments';
import type { ReportTable } from './statements';

/**
 * The money desks (2.95, migration 20261011005000 — docs/FINANCE_ADDITIONS_HE.md T9): a desk for every way money comes in — cash,
 * cheques, card, transfers, Bit and other — read from the payments ledger itself (no table of money of its own). The cash desk
 * holds what came in in cash, less what went out in cash, less what was deposited; a received cheque is in the drawer until it is
 * deposited, met the bank on its own, or its receipt was cancelled. A deposit takes cash (never more than the desk holds) and chosen
 * cheques of one location to the bank, one deposit for many receipts. The database keeps every rule (cash_desks,
 * bank_deposit_create, …); the functions here read its answers and say in Hebrew what it would refuse.
 */
export const DESK_METHODS: PayMethod[] = ['cash', 'cheque', 'card', 'transfer', 'bit', 'other'];
export const DESK_LABEL: Record<PayMethod, string> = {
  cash: 'מזומן', cheque: 'צ׳קים', card: 'אשראי', transfer: 'העברות', bit: 'Bit / PayBox', other: 'אחר',
};
/** what the desk's card says under its number */
export const DESK_HINT: Record<PayMethod, string> = {
  cash: 'בקופה עכשיו — מה שנכנס במזומן, פחות מה שיצא ומה שהופקד',
  cheque: 'צ׳קים בקופה עכשיו — עד שמפקידים אותם',
  card: 'נכנס בתקופה — עובר לבנק דרך חברת האשראי',
  transfer: 'נכנס בתקופה — ישר לבנק',
  bit: 'נכנס בתקופה',
  other: 'נכנס בתקופה',
};

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);
const numOrNull = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const ag = (n: number) => Math.round(n * 100);

export interface DeskMethod { method: PayMethod; in: number; out: number; count: number }
export interface Desks {
  methods: DeskMethod[];
  /** the cash the desk holds now (all time — the locations the caller sees) */
  cash: number;
  cheques: { count: number; total: number; dueCount: number; dueTotal: number };
  deposits: { count: number; total: number };
  remindDays: number; today: string;
}
export const toDesks = (j: any): Desks => {
  const by = new Map(arr(j?.methods).map((m) => [str(m.method), m]));
  return {
    methods: DESK_METHODS.map((m) => ({ method: m, in: num(by.get(m)?.in), out: num(by.get(m)?.out), count: num(by.get(m)?.count) })),
    cash: num(j?.cash),
    cheques: { count: num(j?.cheques?.count), total: num(j?.cheques?.total), dueCount: num(j?.cheques?.dueCount), dueTotal: num(j?.cheques?.dueTotal) },
    deposits: { count: num(j?.deposits?.count), total: num(j?.deposits?.total) },
    remindDays: num(j?.remindDays ?? 3), today: str(j?.today),
  };
};

/** a received cheque: its details (fields 1307–1311 of its receipt), its receipt and customer, and its deposit (if any) */
export interface Cheque {
  id: string; amount: number; paidOn: string; number: string; bank: string; branch: string; account: string; dueDate: string | null;
  docType: number | null; docNumber: number | null; customer: string; location: string | null; matched: boolean;
  deposit: { id: string; number: number; date: string } | null;
}
const toCheque = (c: any): Cheque => ({
  id: str(c?.id), amount: num(c?.amount), paidOn: str(c?.paidOn), number: str(c?.number), bank: str(c?.bank), branch: str(c?.branch), account: str(c?.account),
  dueDate: strOrNull(c?.dueDate), docType: numOrNull(c?.docType), docNumber: numOrNull(c?.docNumber), customer: str(c?.customer), location: strOrNull(c?.location),
  matched: Boolean(c?.matched), deposit: c?.deposit ? { id: str(c.deposit.id), number: num(c.deposit.number), date: str(c.deposit.date) } : null,
});
export interface ChequeBook { drawer: Cheque[]; deposited: Cheque[] }
export const toChequeBook = (j: any): ChequeBook => ({ drawer: arr(j?.drawer).map(toCheque), deposited: arr(j?.deposited).map(toCheque) });

export interface DepositItem { payment: string; amount: number; number: string; bank: string; dueDate: string | null; customer: string; docType: number | null; docNumber: number | null }
export interface Deposit {
  id: string; number: number; date: string; location: string | null; cash: number; cheques: number; total: number; note: string;
  status: 'active' | 'cancelled'; cancelReason: string; matched: boolean; items: DepositItem[];
}
export const toDeposits = (j: any): Deposit[] => arr(j).map((d) => ({
  id: str(d?.id), number: num(d?.number), date: str(d?.date), location: strOrNull(d?.location), cash: num(d?.cash), cheques: num(d?.cheques), total: num(d?.total),
  note: str(d?.note), status: d?.status === 'cancelled' ? 'cancelled' : 'active', cancelReason: str(d?.cancelReason), matched: Boolean(d?.matched),
  items: arr(d?.items).map((x) => ({ payment: str(x?.payment), amount: num(x?.amount), number: str(x?.number), bank: str(x?.bank), dueDate: strOrNull(x?.dueDate),
    customer: str(x?.customer), docType: numOrNull(x?.docType), docNumber: numOrNull(x?.docNumber) })),
}));

/** a cheque's day, by the reminder's days: past its day, due within them, later — or no day written on it */
export type DueState = 'overdue' | 'soon' | 'later' | 'none';
export function chequeDue(dueDate: string | null, today: string, days: number): DueState {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return 'none';
  if (dueDate < today) return 'overdue';
  const until = new Date(`${today}T12:00:00Z`); until.setUTCDate(until.getUTCDate() + Math.max(0, days));
  return dueDate <= until.toISOString().slice(0, 10) ? 'soon' : 'later';
}
export const DUE_LABEL: Record<DueState, string> = { overdue: 'עבר מועד הפירעון', soon: 'לפירעון בקרוב', later: '', none: '' };

/** a deposit's total, agorot-exact: its cash and its chosen cheques */
export const depositTotal = (cash: number, cheques: { amount: number }[]) => (ag(cash || 0) + cheques.reduce((a, c) => a + ag(c.amount), 0)) / 100;

/** what the database would refuse in a new deposit (deposit_*) — Hebrew, none when fine */
export function depositErrors(o: { cash: number; cheques: number; desk: number; date: string; today: string }): string[] {
  const e: string[] = [];
  if (!Number.isFinite(o.cash) || o.cash < 0 || Math.abs(Math.round(o.cash * 100) - o.cash * 100) > 1e-6) e.push('סכום המזומן — מספר חיובי, עד אגורות');
  else if (ag(o.cash) > ag(Math.max(0, o.desk))) e.push(`בקופת המזומן רשומים רק ₪${Math.max(0, o.desk).toLocaleString('he-IL')}. הפקדה גדולה יותר אומרת שיש מזומן שלא הופקה עליו קבלה.`);
  if (!(o.cash > 0) && o.cheques === 0) e.push('מה מפקידים? מזומן, צ׳קים או שניהם');
  if (o.cheques > 200) e.push('עד 200 צ׳קים בהפקדה אחת');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date) || o.date > o.today) e.push('תאריך ההפקדה — היום או לפני');
  return e;
}

/** "the cheques deposited": a report of the period — the CSV and the PDF of the reports */
export function chequesTable(list: Cheque[], title = 'צ׳קים שהופקדו'): ReportTable {
  const rows = list.map((c) => [c.deposit?.date ?? '', c.deposit ? c.deposit.number : null, c.number, c.bank, c.branch, c.account, c.dueDate ?? '', c.customer,
    c.docType && c.docNumber ? `${c.docType}-${c.docNumber}` : '', c.amount]);
  const total = list.reduce((a, c) => a + ag(c.amount), 0) / 100;
  return {
    title,
    columns: [{ label: 'הופקד ב', type: 'date' }, { label: 'הפקדה', type: 'count' }, { label: 'מס׳ צ׳ק', type: 'text' }, { label: 'בנק', type: 'text' },
      { label: 'סניף', type: 'text' }, { label: 'חשבון', type: 'text' }, { label: 'פירעון', type: 'date' }, { label: 'לקוח', type: 'text' },
      { label: 'קבלה', type: 'text' }, { label: 'סכום', type: 'money' }],
    rows, total: list.length ? ['סה״כ', null, '', '', '', '', '', `${list.length} צ׳קים`, '', total] : null,
  };
}

/** the desk of a method for its card: what it holds (cash, cheques) or what came in in the period (the rest) */
export function deskValue(d: Desks, m: PayMethod): { value: number; sub: string } {
  const row = d.methods.find((x) => x.method === m);
  if (m === 'cash') return { value: d.cash, sub: row ? `בתקופה: נכנס ₪${row.in.toLocaleString('he-IL')} · יצא ₪${row.out.toLocaleString('he-IL')}` : '' };
  if (m === 'cheque') return { value: d.cheques.total, sub: `${d.cheques.count} צ׳קים${d.cheques.dueCount ? ` · ${d.cheques.dueCount} לפירעון בקרוב` : ''}` };
  return { value: row?.in ?? 0, sub: row?.out ? `יצא ₪${row.out.toLocaleString('he-IL')}` : row?.count ? `${row.count} תנועות` : 'אין תנועות' };
}
export const methodName = (m: string) => DESK_LABEL[m as PayMethod] ?? payLabel(m);
