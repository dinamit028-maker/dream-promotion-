import { ag, sh } from './vat';
import type { Line } from './plans';

/**
 * Receivables ("חייבים"): invoices that ask for money (305 / 300) less their credit invoices and payments.
 * The numbers come from the database view `receivables`; this module adds the status, the aging and the reminder.
 * Smart collection: the reminder text is built from the REAL values here. An AI may only reword a template
 * that keeps the {{placeholders}} — it never writes an amount, a number or a date (aiDraftIsSafe), and nothing
 * is sent without the user pressing "send" (WhatsApp opens with the text; the user sends it).
 */
export interface Receivable {
  id: string; docType: number; docNumber: number; docDate: string; dueDate: string | null; customerName: string; customerPhone: string;
  customerEmail: string; leadId: string | null; total: number; credited: number; paid: number; balance: number; cancelled: boolean; shareToken: string;
}
export const toReceivable = (r: any): Receivable => ({
  id: r.id, docType: r.doc_type, docNumber: Number(r.doc_number), docDate: r.doc_date, dueDate: r.due_date ?? null, customerName: r.customer_name ?? '',
  customerPhone: r.customer_phone ?? '', customerEmail: r.customer_email ?? '', leadId: r.lead_id ?? null, total: Number(r.total), credited: Number(r.credited ?? 0),
  paid: Number(r.paid ?? 0), balance: Number(r.balance), cancelled: Boolean(r.cancelled), shareToken: r.share_token ?? '',
});

/** payment terms: immediate, net_30 ("30 יום"), eom_30 ("שוטף + 30": end of the month, then 30 days) */
export const TERMS: { id: string; label: string }[] = [
  { id: 'immediate', label: 'מיידי' }, { id: 'net_14', label: '14 יום' }, { id: 'net_30', label: '30 יום' }, { id: 'net_45', label: '45 יום' },
  { id: 'eom_30', label: 'שוטף + 30' }, { id: 'eom_60', label: 'שוטף + 60' }, { id: 'eom_90', label: 'שוטף + 90' },
];
const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const endOfMonth = (date: string) => { const d = new Date(`${date.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
export function dueDateFor(docDate: string, terms: string): string {
  const m = /^(net|eom)_(\d{1,3})$/.exec(terms);
  if (!m) return docDate;
  return m[1] === 'net' ? addDays(docDate, Number(m[2])) : addDays(endOfMonth(docDate), Number(m[2]));
}
export const termsLabel = (t: string) => TERMS.find((x) => x.id === t)?.label ?? (/^net_(\d+)$/.exec(t)?.[1] ? `${/^net_(\d+)$/.exec(t)![1]} יום` : /^eom_(\d+)$/.exec(t) ? `שוטף + ${/^eom_(\d+)$/.exec(t)![1]}` : 'מיידי');

export type ReceivableStatus = 'paid' | 'open' | 'partial' | 'overdue' | 'cancelled' | 'credit';
export const STATUS_HE: Record<ReceivableStatus, string> = { paid: 'שולם', open: 'פתוח', partial: 'שולם חלקית', overdue: 'באיחור', cancelled: 'בוטל', credit: 'זכות ללקוח' };
export function receivableStatus(r: Pick<Receivable, 'balance' | 'paid' | 'credited' | 'dueDate' | 'cancelled'>, today: string): ReceivableStatus {
  if (r.cancelled) return 'cancelled';
  const b = ag(r.balance);
  if (b < 0) return 'credit';
  if (b === 0) return 'paid';
  if (r.dueDate && r.dueDate < today) return 'overdue';
  return ag(r.paid) > 0 || ag(r.credited) > 0 ? 'partial' : 'open';
}
export function daysOverdue(r: Pick<Receivable, 'dueDate' | 'balance'>, today: string): number {
  if (!r.dueDate || ag(r.balance) <= 0 || r.dueDate >= today) return 0;
  return Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${r.dueDate}T12:00:00Z`)) / 864e5);
}
/** open money by how late it is: not due yet, 1–30, 31–60, 61–90, over 90 days */
export function aging(list: Receivable[], today: string) {
  const b = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
  for (const r of list) {
    if (r.cancelled || ag(r.balance) <= 0) continue;
    const d = daysOverdue(r, today), a = ag(r.balance);
    if (d === 0) b.current += a; else if (d <= 30) b.d30 += a; else if (d <= 60) b.d60 += a; else if (d <= 90) b.d90 += a; else b.over90 += a;
  }
  return { current: sh(b.current), d30: sh(b.d30), d60: sh(b.d60), d90: sh(b.d90), over90: sh(b.over90), total: sh(b.current + b.d30 + b.d60 + b.d90 + b.over90) };
}

// ---- an invoice with a payment plan (2.89, T3): its date and status by the plan's payments -------------------------------------
type LineLike = Pick<Line, 'open' | 'dueDate' | 'planId'>;
const daysLate = (due: string, today: string) => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 864e5);
/**
 * The status, the date and the lateness of an invoice — by its lines (receivable_lines) when it has a plan: late when a payment
 * of the plan is late (from that payment's date), else the next payment's date. Without a plan: as before (its own date).
 */
export function byLines(r: Receivable, lines: LineLike[] | undefined, today: string): { status: ReceivableStatus; dueDate: string | null; late: number; planned: boolean } {
  if (!lines?.some((l) => l.planId)) return { status: receivableStatus(r, today), dueDate: r.dueDate, late: daysOverdue(r, today), planned: false };
  const open = lines.filter((l) => ag(l.open) > 0).sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  const base = receivableStatus({ ...r, dueDate: null }, today);
  if (base === 'cancelled' || base === 'credit' || base === 'paid') return { status: base, dueDate: open[0]?.dueDate ?? null, late: 0, planned: true };
  const late = open.find((l) => l.dueDate && l.dueDate < today);
  if (late?.dueDate) return { status: 'overdue', dueDate: late.dueDate, late: daysLate(late.dueDate, today), planned: true };
  return { status: base, dueDate: open[0]?.dueDate ?? null, late: 0, planned: true };
}
/** open money by how late it is — by lines: a plan's payment counts from its own date (an invoice without a plan: as aging) */
export const agingByLines = (lines: Pick<Line, 'open' | 'dueDate'>[], today: string) =>
  aging(lines.map((l) => ({ cancelled: false, balance: l.open, dueDate: l.dueDate }) as Receivable), today);

// ---- reminders ----------------------------------------------------------------------------------------------------
export type Tone = 'friendly' | 'firm' | 'final';
export const TONES: { id: Tone; label: string }[] = [{ id: 'friendly', label: 'עדינה' }, { id: 'firm', label: 'ברורה' }, { id: 'final', label: 'אחרונה' }];
export const PLACEHOLDERS = ['{{name}}', '{{doc}}', '{{amount}}', '{{due}}', '{{business}}', '{{link}}'] as const;
const TEMPLATES: Record<Tone, string> = {
  friendly: 'היי {{name}}, תזכורת קטנה מ{{business}} 🙏\nנשארה יתרה של {{amount}} על {{doc}} (לתשלום עד {{due}}).\nאפשר לראות את המסמך כאן: {{link}}\nתודה!',
  firm: 'שלום {{name}}, לפי הרישומים שלנו ב{{business}}, {{doc}} עדיין לא שולמה במלואה — יתרה של {{amount}}, שמועד התשלום שלה היה {{due}}.\nהמסמך: {{link}}\nנשמח להסדיר את התשלום בהקדם.',
  final: 'שלום {{name}}, זו תזכורת אחרונה מ{{business}} לגבי {{doc}}: יתרה של {{amount}} שהייתה לתשלום עד {{due}}.\nהמסמך: {{link}}\nאם כבר שילמת — אפשר להתעלם, ותודה. אחרת נשמח לתשלום עוד היום.',
};
export const reminderTemplate = (t: Tone) => TEMPLATES[t];
export interface ReminderValues { name: string; doc: string; amount: string; due: string; business: string; link: string }
export const fillReminder = (template: string, v: ReminderValues) =>
  template.replace(/\{\{(name|doc|amount|due|business|link)\}\}/g, (_, k: keyof ReminderValues) => v[k] || '');

/**
 * An AI rewording is used only if it keeps the facts in placeholders: no digits, no currency, no links of its own,
 * and the amount and the document are still there as {{amount}} / {{doc}}. Anything else → the plain template.
 */
export function aiDraftIsSafe(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 20 || t.length > 700) return false;
  if (!t.includes('{{amount}}') || !t.includes('{{doc}}')) return false;
  const outside = t.replace(/\{\{(name|doc|amount|due|business|link)\}\}/g, '');
  if (/[0-9٠-٩]|₪|\$|€|ש["״]ח|https?:|www\.|\{\{|\}\}/.test(outside)) return false;
  return true;
}
