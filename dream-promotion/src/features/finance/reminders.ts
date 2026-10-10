import { ils } from '@/features/register/money';
import { linkify, type Email } from '@/features/store/commerce';
import { DOC_LABEL } from '@/features/documents/documents';
import { fillReminder, reminderTemplate, type Tone } from './receivables';

/**
 * Scheduled debt reminders ("תזכורות חוב אוטומטיות", docs/FINANCE_ADDITIONS_HE.md T5; migration 20261010004400) — the pure rules
 * of the screens and of the server. The text is receivables.ts's (the same templates, filled with the real values); the
 * database decides who gets what and when (debt_reminders_due), and asks again before each send (debt_reminder_state):
 *   off       until the business's OWNER turns them on — the approval (who, when, which rules) is kept and logged
 *   rules     1–5 days after a due date (3, 7, 14 to start with); an invoice, or each payment of its plan, once per step
 *   channel   email (the one outbox), or the WhatsApp queue the owner sends from; no address → nothing automatic
 *   stops     a payment (the line is not open any more), "לא לשלוח" on the customer, reminders turned off
 */
export type Channel = 'email' | 'whatsapp';
export interface ReminderSettings { enabled: boolean; days: number[]; channel: Channel; approvedBy: string | null; approvedAt: string | null; updatedAt: string | null }
export const DEFAULT_SETTINGS: ReminderSettings = { enabled: false, days: [3, 7, 14], channel: 'whatsapp', approvedBy: null, approvedAt: null, updatedAt: null };
export const toSettings = (r: any): ReminderSettings => (r ? {
  enabled: Boolean(r.enabled), days: Array.isArray(r.days) ? r.days.map(Number) : DEFAULT_SETTINGS.days, channel: r.channel === 'email' ? 'email' : 'whatsapp',
  approvedBy: r.approved_by ?? null, approvedAt: r.approved_at ?? null, updatedAt: r.updated_at ?? null,
} : DEFAULT_SETTINGS);

/** the days as the database keeps them: once each, ascending, 1–120, at most 5 — or why not */
export function normalizeDays(raw: (number | string)[]): { days: number[]; error: string | null } {
  const nums = raw.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (nums.some((x) => !Number.isInteger(x) || x < 1 || x > 120)) return { days: [], error: 'כל יום בין 1 ל-120.' };
  const days = [...new Set(nums)].sort((a, b) => a - b);
  if (!days.length) return { days, error: 'לפחות יום אחד.' };
  if (days.length > 5) return { days, error: 'עד 5 תזכורות לכל חוב.' };
  return { days, error: null };
}
/** the tone of a step, as the database chooses it: the first is gentle, the last of three or more is the final one */
export function toneForStep(step: number, count: number): Tone {
  if (step <= 1) return 'friendly';
  return step === count && count >= 3 ? 'final' : 'firm';
}
/** "3, 7 ו-14 ימים אחרי מועד התשלום" */
export function daysText(days: number[]): string {
  if (!days.length) return '';
  const w = days.map(String);
  const list = w.length === 1 ? w[0] : `${w.slice(0, -1).join(', ')} ו-${w[w.length - 1]}`;
  return `${list} ${days.length === 1 && days[0] === 1 ? 'יום' : 'ימים'} אחרי מועד התשלום`;
}

/** what the reminder is about: "חשבונית מס מס׳ 12", or "תשלום 2 מתוך 3 של חשבונית מס מס׳ 12" */
export function reminderDoc(docType: number, docNumber: number | string, n: number | null, of: number | null): string {
  const doc = `${DOC_LABEL[docType] ?? 'חשבונית'} מס׳ ${docNumber}`;
  return n != null ? `תשלום ${n} מתוך ${of ?? '?'} של ${doc}` : doc;
}
const ddmm = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : '');
/** the text of a reminder: the template of its tone, with the values of the line as they are now */
export function reminderText(o: { tone: Tone; customerName: string; docType: number; docNumber: number | string; n: number | null; of: number | null;
                                  open: number; due: string | null; business: string; link: string }): string {
  return fillReminder(reminderTemplate(o.tone), {
    name: o.customerName.trim().split(/\s+/)[0] || '', doc: reminderDoc(o.docType, o.docNumber, o.n, o.of), amount: ils(o.open),
    due: ddmm(o.due) || 'מועד התשלום', business: o.business, link: o.link,
  });
}
/** a reminder's email: the same text, the business's details at the end; no advertising */
export function reminderEmail(o: { tone: Tone; business: string; phone?: string; email?: string; customerName: string; docType: number; docNumber: number | string;
                                   n: number | null; of: number | null; open: number; due: string | null; link: string }): Email {
  const subject = `תזכורת תשלום — ${o.business}`;
  const body = reminderText({ ...o }).split('\n');
  const lines = [...body, '', `פרטי העסק: ${[o.business, o.phone && `טלפון ${o.phone}`, o.email && `מייל ${o.email}`].filter(Boolean).join(' · ')}`];
  const kept = lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''));
  const text = kept.join('\n').trim();
  const html = `<!doctype html><html lang="he" dir="rtl"><body style="font-family:Arial,sans-serif;line-height:1.6;color:#111">`
    + kept.map((l) => (l === '' ? '<br>' : `<p style="margin:0">${linkify(l)}</p>`)).join('') + `</body></html>`;
  return { subject: subject.slice(0, 200), html, text };
}

// ---- a reminder's state, in Hebrew ------------------------------------------------------------------------------------------
export type ReminderStatus = 'queued' | 'sent' | 'cancelled' | 'failed';
export type CancelReason = '' | 'paid' | 'stopped' | 'off' | 'changed' | 'superseded' | 'skipped';
export const CANCEL_HE: Record<CancelReason, string> = {
  '': 'בוטלה', paid: 'שולם לפני השליחה', stopped: 'הלקוח/ה מסומן/ת "לא לשלוח"', off: 'התזכורות כובו', changed: 'הפריסה השתנתה',
  superseded: 'הוחלפה בתזכורת הבאה', skipped: 'דולגה',
};
export interface Reminder {
  id: string; documentId: string; itemId: string | null; leadId: string | null; step: number; days: number; dueDate: string; amount: number; tone: Tone;
  channel: Channel; toAddress: string; status: ReminderStatus; createdAt: string; sentAt: string | null; cancelReason: CancelReason; error: string;
}
export const REMINDER_COLUMNS = 'id, document_id, item_id, lead_id, step, days, due_date, amount, tone, channel, to_address, status, created_at, sent_at, cancel_reason, error';
export const toReminder = (r: any): Reminder => ({
  id: r.id, documentId: r.document_id, itemId: r.item_id ?? null, leadId: r.lead_id ?? null, step: Number(r.step), days: Number(r.days), dueDate: r.due_date,
  amount: Number(r.amount), tone: r.tone, channel: r.channel, toAddress: r.to_address ?? '', status: r.status, createdAt: r.created_at, sentAt: r.sent_at ?? null,
  cancelReason: (r.cancel_reason ?? '') as CancelReason, error: r.error ?? '',
});
export function reminderLine(q: Pick<Reminder, 'status' | 'channel' | 'cancelReason' | 'error' | 'step'>): { text: string; tone: 'ok' | 'warn' | 'bad' | 'default' } {
  const via = q.channel === 'email' ? 'במייל' : 'בוואטסאפ';
  if (q.status === 'sent') return { text: `תזכורת ${q.step} נשלחה ${via}`, tone: 'ok' };
  if (q.status === 'queued') return { text: q.channel === 'email' ? `תזכורת ${q.step} — נשלחת במייל` : `תזכורת ${q.step} — מחכה לשליחה בוואטסאפ`, tone: 'warn' };
  if (q.status === 'failed') return { text: `תזכורת ${q.step} ${via} לא נשלחה${q.error ? `: ${q.error}` : ''}`, tone: 'bad' };
  return { text: `תזכורת ${q.step}: ${CANCEL_HE[q.cancelReason] ?? 'בוטלה'}`, tone: 'default' };
}
/** what debt_reminder_whatsapp answered, when it did not send */
export const WHATSAPP_RESULT_HE: Record<string, string> = {
  paid: 'החוב שולם בינתיים — התזכורת לא נשלחה.', stopped: 'הלקוח/ה מסומן/ת "לא לשלוח" — התזכורת בוטלה.', off: 'התזכורות כבויות — התזכורת בוטלה.',
  changed: 'הפריסה של המסמך השתנתה — התזכורת בוטלה.', sent: 'התזכורת כבר נשלחה.', cancelled: 'התזכורת כבר בוטלה.', failed: 'התזכורת לא נשלחה.',
};
/** the database's refusal in Hebrew (debt_reminders_configure / _stop / _whatsapp) */
export function reminderErrorHe(e: { message?: string; code?: string } | null | undefined): string {
  const m = String(e?.message ?? '');
  if (m.includes('reminders_owner')) return 'רק הבעלים של העסק מפעילים תזכורות אוטומטיות (או משנים את הכללים שלהן).';
  if (m.includes('reminders_days')) return 'בין 1 ל-5 ימים, כל אחד בין 1 ל-120.';
  if (m.includes('reminders_channel')) return 'ערוץ: מייל או וואטסאפ.';
  if (m.includes('reminder_not_found')) return 'לא נמצא בעסק הזה.';
  if (m.includes('not allowed') || e?.code === '42501') return 'אין לך הרשאה לנהל את הכספים של העסק.';
  return 'הפעולה לא נשמרה. נסו שוב.';
}
