import { ils } from '@/features/register/money';
import type { TerminalInfo } from '@/features/store/checkout';
import { linkify, type Email } from '@/features/store/commerce';

/**
 * Payment links ("שלח לינק לתשלום", docs/FINANCE_ADDITIONS_HE.md T2; migration 20261010004300) — the screens' and the
 * server's pure rules: what a link reads as, the gate before sending one, the WhatsApp text, and the Hebrew of a refusal.
 * The database decides everything again (paylink_create: the terminal, the balance under the invoice's lock, the deposit).
 *   statuses  נשלח / שולם / נכשל / פג תוקף / בוטל — a failed payment is never shown as paid, a test payment says "בדיקה"
 *   the gate  a link only on a connected AND checked terminal ("בדיקת חיבור"); otherwise "חבר ספק תשלום"
 *   money     a real payment's receipt is issued through the existing documents (at once, or after the owner's approval);
 *             a test payment has no receipt and nothing in the ledger
 */
export type PaylinkKind = 'document' | 'quote' | 'deposit';
export type PaylinkStatus = 'sent' | 'paid' | 'failed' | 'expired' | 'cancelled';
export type ReceiptStatus = 'none' | 'pending' | 'awaiting' | 'issued' | 'blocked';
export type PaylinkVia = 'whatsapp' | 'email' | 'link';

export interface Paylink {
  id: string; kind: PaylinkKind; documentId: string | null; packageId: string | null; quoteId: string | null; appointmentId: string | null;
  leadId: string | null; label: string; customerName: string; customerPhone: string; customerEmail: string; amount: number; isTest: boolean;
  provider: string; status: PaylinkStatus; expiresAt: string; sentVia: PaylinkVia; sends: number; paidAt: string | null; paidAmount: number | null;
  paidLate: boolean; failedAt: string | null; failReason: string; cancelledAt: string | null; receiptStatus: ReceiptStatus;
  receiptDocumentId: string | null; receiptError: string; createdAt: string;
}
export const toPaylink = (r: any): Paylink => ({
  id: r.id, kind: r.kind, documentId: r.document_id ?? null, packageId: r.package_id ?? null, quoteId: r.quote_id ?? null,
  appointmentId: r.appointment_id ?? null, leadId: r.lead_id ?? null, label: r.label ?? '', customerName: r.customer_name ?? '',
  customerPhone: r.customer_phone ?? '', customerEmail: r.customer_email ?? '', amount: Number(r.amount), isTest: Boolean(r.is_test),
  provider: r.provider ?? '', status: r.status, expiresAt: r.expires_at, sentVia: r.sent_via ?? 'link', sends: Number(r.sends ?? 1),
  paidAt: r.paid_at ?? null, paidAmount: r.paid_amount == null ? null : Number(r.paid_amount), paidLate: Boolean(r.paid_late),
  failedAt: r.failed_at ?? null, failReason: r.fail_reason ?? '', cancelledAt: r.cancelled_at ?? null,
  receiptStatus: r.receipt_status ?? 'none', receiptDocumentId: r.receipt_document_id ?? null, receiptError: r.receipt_error ?? '', createdAt: r.created_at,
});
/** the columns the screens read (never the provider's pages: they are the servers') */
export const PAYLINK_COLUMNS = 'id, kind, document_id, package_id, quote_id, appointment_id, lead_id, label, customer_name, customer_phone, customer_email, amount, '
  + 'is_test, provider, status, expires_at, sent_via, sends, paid_at, paid_amount, paid_late, failed_at, fail_reason, cancelled_at, receipt_status, '
  + 'receipt_document_id, receipt_error, created_at';

// ---- what a link reads as ----------------------------------------------------------------------------------------------------
export const PAYLINK_STATUS_HE: Record<PaylinkStatus, string> = { sent: 'נשלח', paid: 'שולם', failed: 'נכשל', expired: 'פג תוקף', cancelled: 'בוטל' };
/** an open link past its time reads "פג תוקף" also before the cron moved it */
export function paylinkState(l: Pick<Paylink, 'status' | 'expiresAt'>, now = Date.now()): PaylinkStatus {
  return (l.status === 'sent' || l.status === 'failed') && Date.parse(l.expiresAt) <= now ? 'expired' : l.status;
}
export const paylinkOpen = (l: Pick<Paylink, 'status' | 'expiresAt'>, now = Date.now()) => {
  const s = paylinkState(l, now);
  return s === 'sent' || s === 'failed';
};
export type Tone = 'default' | 'ok' | 'warn' | 'bad' | 'info';
/** the pill of a link: its status, with "בדיקה" on a test payment — a failure is never green */
export function paylinkPill(l: Pick<Paylink, 'status' | 'expiresAt' | 'isTest' | 'paidLate'>, now = Date.now()): { text: string; tone: Tone } {
  const s = paylinkState(l, now);
  if (s === 'paid') return { text: l.isTest ? 'שולם (בדיקה)' : l.paidLate ? 'שולם (באיחור)' : 'שולם', tone: l.isTest ? 'info' : 'ok' };
  if (s === 'failed') return { text: 'נכשל', tone: 'bad' };
  if (s === 'sent') return { text: 'נשלח', tone: 'warn' };
  return { text: PAYLINK_STATUS_HE[s], tone: 'default' };
}
/** the receipt of a real payment, in a line ('' when there is nothing to say) */
export function receiptLine(l: Pick<Paylink, 'status' | 'isTest' | 'receiptStatus' | 'receiptError'>): string {
  if (l.status !== 'paid') return '';
  if (l.isTest) return 'תשלום בדיקה — לא כסף אמיתי, בלי קבלה';
  switch (l.receiptStatus) {
    case 'issued': return 'הקבלה הופקה';
    case 'pending': return 'הקבלה מופקת עכשיו';
    case 'awaiting': return 'ממתין לאישור הפקת הקבלה';
    case 'blocked': return `הקבלה לא הופקה: ${l.receiptError || 'צריך לבדוק את פרטי העסק'}`;
    default: return '';
  }
}

// ---- the gate --------------------------------------------------------------------------------------------------------------
export type Gate = { ok: true; test: boolean } | { ok: false; reason: 'connect' | 'verify' | 'live_closed' | 'unknown'; message: string };
export type PaylinkTerminal = TerminalInfo;
/** may a link be sent now? Only on a connected and checked terminal; a live one only with the platform's switch */
export function paylinkGate(t: PaylinkTerminal | null): Gate {
  if (!t) return { ok: false, reason: 'unknown', message: 'בודקים את ספק התשלום…' };
  if (!t.connected) return { ok: false, reason: 'connect', message: 'חבר ספק תשלום — ב"החנות ← מכירה באתר" מחברים את מסוף הסליקה (PayPlus).' };
  if (!t.verifiedAt) return { ok: false, reason: 'verify', message: 'ספק התשלום מחובר אבל עוד לא נבדק — לוחצים "בדיקת חיבור" ב"החנות ← מכירה באתר".' };
  if (t.mode === 'live' && !t.linksLive) return { ok: false, reason: 'live_closed', message: 'תשלום אמיתי בלינק עוד סגור במערכת — כרגע אפשר לשלוח לינקים רק ממסוף בדיקה.' };
  return { ok: true, test: t.mode !== 'live' };
}

// ---- sending ---------------------------------------------------------------------------------------------------------------
const first = (name: string) => name.trim().split(/\s+/)[0] ?? '';
const ddmm = (iso: string) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Jerusalem' }); };
/** the WhatsApp text (and the email's words): who, what, how much, the link, until when */
export function paylinkMessage(o: { name: string; business: string; label: string; amount: number; url: string; expiresAt: string; test?: boolean }): string {
  const hi = first(o.name) ? `שלום ${first(o.name)}, ` : 'שלום, ';
  return `${hi}לתשלום ${o.label} ל${o.business}: ${ils(o.amount)}\n${o.url}\nהלינק בתוקף עד ${ddmm(o.expiresAt)}.${o.test ? '\n(תשלום בדיקה — לא יחויב כסף אמיתי)' : ''}`;
}
/** the customer's email of a link (a service email: no advertising in it) */
export function paylinkEmail(o: { business: string; phone?: string; email?: string; customerName: string; label: string; amount: number; url: string;
                                  expiresAt: string; test: boolean }): Email {
  const subject = `לתשלום: ${o.label} — ${o.business}${o.test ? ' (בדיקה)' : ''}`;
  const lines = [
    first(o.customerName) ? `שלום ${first(o.customerName)},` : 'שלום,',
    `${o.business} שלחו לך לינק לתשלום ${o.label}: ${ils(o.amount)}.`, '',
    `לתשלום מאובטח: ${o.url}`, `הלינק בתוקף עד ${ddmm(o.expiresAt)}. פרטי הכרטיס מוקלדים בעמוד של חברת הסליקה בלבד.`,
    o.test ? 'זהו תשלום בדיקה — לא יחויב כסף אמיתי.' : '', '',
    `פרטי העסק: ${[o.business, o.phone && `טלפון ${o.phone}`, o.email && `מייל ${o.email}`].filter(Boolean).join(' · ')}`,
  ];
  const kept = lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''));
  const text = kept.join('\n').trim();
  const html = `<!doctype html><html lang="he" dir="rtl"><body style="font-family:Arial,sans-serif;line-height:1.6;color:#111">`
    + kept.map((l) => (l === '' ? '<br>' : `<p style="margin:0">${linkify(l)}</p>`)).join('') + `</body></html>`;
  return { subject: subject.slice(0, 200), html, text };
}

/** what the form asks for: a sum in shekels with at most agorot, more than zero, not more than what is left */
export function amountError(raw: string, left: number): string | null {
  const s = raw.trim().replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return 'סכום בשקלים, למשל 300 או 299.90.';
  const n = Number(s);
  if (!(n > 0)) return 'הסכום חייב להיות גדול מאפס.';
  if (n > left + 1e-9) return `אפשר לבקש עד ${ils(left)}.`;
  return null;
}
export const LINK_DAYS = [1, 3, 7, 14, 30] as const;

// ---- a deposit, offset from the final payment ------------------------------------------------------------------------------
/**
 * The register's line for an appointment whose deposit was really paid (appointment_deposits — never a test one): the
 * service's price less the deposit, named so — the deposit already has its own document, so the two add up to the price.
 */
export function afterDeposit(name: string, price: number, deposit: number): { name: string; price: number } {
  if (!(deposit > 0)) return { name, price };
  return { name: `${name} (יתרה אחרי מקדמה ${ils(deposit)})`.slice(0, 120), price: Math.max(0, Math.round((price - deposit) * 100) / 100) };
}
/** how many days a deposit link may live: until the appointment (1 to 7) */
export const depositDays = (startIso: string, now = Date.now()) => Math.min(7, Math.max(1, Math.ceil((Date.parse(startIso) - now) / 864e5)));

// ---- a refusal of the database or the servers, in Hebrew --------------------------------------------------------------------
export const PAYLINK_MIGRATION = 'צריך להריץ את מיגרציה 20261010004300 (לינק לתשלום) ב-Supabase לפני שזה עובד.';
export function paylinkError(e: unknown): string {
  const m = `${(e as any)?.message ?? e ?? ''} ${(e as any)?.code ?? ''} ${(e as any)?.details ?? ''}`;
  if (/schema cache|does not exist|PGRST20[24]|42P01|42703|42883|Could not find/i.test(m)) return PAYLINK_MIGRATION;
  if (/paylink_no_terminal/.test(m)) return 'חבר ספק תשלום — ב"החנות ← מכירה באתר" מחברים את מסוף הסליקה.';
  if (/paylink_not_verified/.test(m)) return 'ספק התשלום עוד לא נבדק — לוחצים "בדיקת חיבור" ב"החנות ← מכירה באתר".';
  if (/paylink_live_closed/.test(m)) return 'תשלום אמיתי בלינק עוד סגור במערכת — כרגע רק ממסוף בדיקה.';
  const over = /paylink_over_balance: ([\d.]+)/.exec(m);
  if (over) return Number(over[1]) > 0 ? `אפשר לבקש עד ${ils(Number(over[1]))} (היתרה, פחות לינקים שעוד פתוחים).` : 'אין יתרה לבקש — הכל שולם או כבר נשלח בלינק פתוח.';
  if (/paylink_not_invoice/.test(m)) return 'לינק לתשלום נשלח רק על חשבונית פתוחה (חשבונית מס או חשבונית עסקה) שלא בוטלה.';
  if (/paylink_quote/.test(m)) return 'לינק לתשלום נשלח רק על הצעה שהלקוח/ה אישר/ה.';
  if (/paylink_appointment/.test(m)) return 'התור כבר עבר או בוטל.';
  if (/paylink_no_deposit/.test(m)) return 'לשירות הזה לא הוגדרה מקדמה (מגדירים בעריכת השירות).';
  if (/paylink_deposit_exists/.test(m)) return 'לתור הזה כבר נשלח לינק למקדמה.';
  if (/paylink_days/.test(m)) return 'לינק בתוקף בין יום אחד ל-30 ימים.';
  if (/paylink_amount/.test(m)) return 'הסכום חייב להיות גדול מאפס.';
  if (/paylink_not_found/.test(m)) return 'לא נמצא (אולי נמחק או שייך לעסק אחר).';
  if (/business_locked/.test(m)) return 'העסק נעול. כדי לחדש את השירות פנו למנהל המערכת.';
  if (/42501|permission denied|row-level security/i.test(m)) return 'אין הרשאה לפעולה הזו.';
  return 'משהו השתבש. נסו שוב.';
}
/** the storefront's answer when the customer pressed "לתשלום" */
export const PAGE_ERRORS_HE: Record<string, string> = {
  paid: 'התשלום כבר התקבל. תודה!',
  closed: 'הלינק הזה כבר לא פעיל. אפשר לבקש מהעסק לינק חדש.',
  too_many: 'היו כבר כמה ניסיונות תשלום בלינק הזה. אפשר לבקש מהעסק לינק חדש.',
  no_terminal: 'העסק לא מקבל כרגע תשלום בלינק. אפשר לפנות אליו ישירות.',
  terminal_changed: 'הלינק הזה כבר לא פעיל. אפשר לבקש מהעסק לינק חדש.',
  payment: 'אי אפשר לשלם כרגע. נסו שוב מאוחר יותר.',
  provider: 'לא הצלחנו לפתוח את עמוד התשלום. נסו שוב בעוד רגע.',
  not_found: 'הלינק לא נמצא.',
  unavailable: 'אי אפשר לשלם כרגע. נסו שוב מאוחר יותר.',
};
