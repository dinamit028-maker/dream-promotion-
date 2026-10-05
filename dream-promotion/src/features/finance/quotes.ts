import type { ComposeCustomer, ComposeLine, Discount } from './compose';

/**
 * Quotes ("הצעות מחיר"): numbered per business by the database, statuses move forward only, a decided quote keeps
 * its content, and it becomes a document only by issuing that document (the database marks it "converted").
 * The same transitions are enforced by the database (quotes_guard, migration 20261004003100).
 */
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'converted' | 'cancelled';
export const QUOTE_STATUS_HE: Record<QuoteStatus, string> = {
  draft: 'טיוטה', sent: 'נשלחה', accepted: 'אושרה', rejected: 'נדחתה', expired: 'פג תוקף', converted: 'הפכה למסמך', cancelled: 'בוטלה',
};
export const QUOTE_NEXT: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ['sent', 'cancelled', 'converted'],
  sent: ['draft', 'accepted', 'rejected', 'expired', 'cancelled', 'converted'],
  accepted: ['converted', 'cancelled'],
  expired: ['sent', 'cancelled'],
  rejected: [], converted: [], cancelled: [],
};
export const canMove = (from: QuoteStatus, to: QuoteStatus) => QUOTE_NEXT[from].includes(to);
/** may its content still change? (draft, sent and expired — a decided quote never) */
export const editable = (s: QuoteStatus) => s === 'draft' || s === 'sent' || s === 'expired';

/** what the composer keeps in quotes.body / document_drafts.body */
export interface ComposerBody {
  lines: ComposeLine[]; pricesIncludeVat: boolean; discount: Discount; customer: ComposeCustomer;
  notes?: string; terms?: string; dueDate?: string | null; payments?: { method: string; amount: number; date: string }[];
}

export interface Quote {
  id: string; number: number; status: QuoteStatus; customerName: string; customerPhone: string; customerEmail: string; customerDealer: string;
  customerStreet: string; customerCity: string; leadId: string | null; body: ComposerBody; beforeDiscount: number; discount: number; afterDiscount: number;
  vatRate: number; vatAmount: number; total: number; validUntil: string | null; notes: string; shareToken: string; sentAt: string | null;
  decidedAt: string | null; decisionBy: string; decisionNote: string; convertedDocumentId: string | null; createdAt: string; issuer: Record<string, unknown> | null;
}
export const toQuote = (r: any): Quote => ({
  id: r.id, number: Number(r.quote_number), status: r.status, customerName: r.customer_name ?? '', customerPhone: r.customer_phone ?? '',
  customerEmail: r.customer_email ?? '', customerDealer: r.customer_dealer ?? '', customerStreet: r.customer_street ?? '', customerCity: r.customer_city ?? '',
  leadId: r.lead_id ?? null, body: (r.body ?? {}) as ComposerBody, beforeDiscount: Number(r.before_discount), discount: Number(r.discount),
  afterDiscount: Number(r.after_discount), vatRate: Number(r.vat_rate), vatAmount: Number(r.vat_amount), total: Number(r.total), validUntil: r.valid_until ?? null,
  notes: r.notes ?? '', shareToken: r.share_token ?? '', sentAt: r.sent_at ?? null, decidedAt: r.decided_at ?? null, decisionBy: r.decision_by ?? '',
  decisionNote: r.decision_note ?? '', convertedDocumentId: r.converted_document_id ?? null, createdAt: r.created_at, issuer: r.issuer ?? null,
});

/** a sent quote past its date shows as expired (the database moves it only when the business does) */
export function quoteState(q: Pick<Quote, 'status' | 'validUntil'>, today: string): QuoteStatus {
  return q.status === 'sent' && q.validUntil && q.validUntil < today ? 'expired' : q.status;
}
const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const validUntilFor = (from: string, days: number) => addDays(from, Math.max(1, Math.min(365, Math.round(days) || 30)));

/** the WhatsApp text that sends a quote (the link is the customer's private page) */
export const quoteMessage = (o: { name: string; number: number; business: string; total: string; validUntil: string | null; link: string }) =>
  `שלום ${o.name.split(' ')[0] || ''}, מצורפת הצעת מחיר מס׳ ${o.number} מ${o.business}: ${o.total}${o.validUntil ? ` (בתוקף עד ${o.validUntil.split('-').reverse().join('/')})` : ''}.\nלצפייה ולאישור: ${o.link}`;
