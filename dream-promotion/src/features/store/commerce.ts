import { docFromSale } from '@/features/documents/documents';
import { ag, sh, vatOfGross } from '@/features/finance/vat';
import { financeError } from '@/features/finance/rows';
import type { NewDoc } from '@/features/finance/compose';
import type { Sale } from '@/features/register/money';
import { planRefund, type RefundRequest, type RefundPlan, REFUND_ERROR_HE } from '@/features/register/refunds';
import type { Refund } from '@/features/register/money';

/**
 * Dream Commerce stage 4 (2.57.0): what happens to a paid order on the dashboard's server — the rules only (no database,
 * no network), so the tests run them as they are. The server (src/lib/server/commerce.ts) reads, calls these, and writes.
 *   VAT       the business's rate (register_settings), through vat.ts only; an exempt business: 0
 *   document  docFromSale of the sale row (320 licensed / 400 exempt) — the register's own way
 *   failures  a refusal the business has to fix (details, closed books, a type not allowed) → "blocked", with the Hebrew
 *             reason; anything else (network, a timeout) → tried again by the cron
 */
export interface VatSettings { businessType: 'exempt' | 'licensed'; vatRate: number }
export const toVatSettings = (r: any): VatSettings => ({
  businessType: r?.business_type === 'exempt' ? 'exempt' : 'licensed', vatRate: Number(r?.vat_rate ?? 18),
});

/** the VAT inside an order's total (₪ in, ₪ out) */
export function orderVat(total: number, s: VatSettings): { rate: number; amount: number } {
  const rate = s.businessType === 'licensed' ? Number(s.vatRate) || 0 : 0;
  return { rate, amount: sh(vatOfGross(ag(total), rate)) };
}

/** a sales row as the register reads it */
export const saleFromRow = (r: any): Sale => ({
  id: r.id, leadId: r.lead_id ?? null, appointmentId: r.appointment_id ?? null, customerName: r.customer_name ?? '', customerPhone: r.customer_phone ?? '',
  items: Array.isArray(r.items) ? r.items : [], subtotal: Number(r.subtotal), discount: Number(r.discount ?? 0), total: Number(r.total),
  vatRate: Number(r.vat_rate ?? 0), vatAmount: Number(r.vat_amount ?? 0), method: r.method, status: r.status, note: r.note ?? '',
  paidAt: r.paid_at ?? null, createdAt: r.created_at, payments: Array.isArray(r.payments) ? r.payments : [],
  billingName: r.billing_name ?? '', customerDealer: r.customer_dealer ?? '', customerStreet: r.customer_street ?? '', customerCity: r.customer_city ?? '',
});

/** the document of an online sale: the register's docFromSale, with the customer's email (the document goes to her) */
export function orderDocument(sale: Sale, o: { licensed: boolean; docDate: string; email?: string }): NewDoc {
  return { ...docFromSale(sale, { licensed: o.licensed, docDate: o.docDate, issuedBy: 'אתר' }), customerEmail: (o.email ?? '').slice(0, 120) };
}

/** a refusal of the database that only the business can fix: the document waits ("blocked") until it does */
const BLOCKING = /business_details_missing|doc_type_not_allowed|period_locked|totals:|lines:|payments:|names are text|paid but the document|42501|row-level security|not allowed|23514|22023/;
export function documentFailure(e: unknown): { blocked: boolean; reason: string } {
  const m = `${(e as any)?.message ?? e ?? ''} ${(e as any)?.code ?? ''} ${(e as any)?.details ?? ''}`;
  if (BLOCKING.test(m)) return { blocked: true, reason: financeError(e) };
  return { blocked: false, reason: 'תקלה זמנית — ננסה שוב בעוד כמה דקות.' };
}

/**
 * A refund from the order's page: the register's planRefund (all, items or a sum; items carry the sale's discount), on
 * the card it was paid with. The money goes back through the payment company's own screen — the owner confirms it was
 * done there ("ההחזר בוצע בממשק של חברת הסליקה"); nothing is recorded without that.
 */
export function planOrderRefund(sale: Sale, prior: Refund[], req: RefundRequest,
  o: { confirmed: boolean; restock?: boolean; reason?: string; employeeName?: string }): { ok: true; refund: RefundPlan } | { ok: false; error: string } {
  if (!o.confirmed) return { ok: false, error: 'צריך לאשר שההחזר בוצע בממשק של חברת הסליקה.' };
  const p = planRefund(sale, prior, req, { method: 'card', restock: o.restock, reason: o.reason, employeeName: o.employeeName });
  return p.ok ? p : { ok: false, error: REFUND_ERROR_HE[p.error] };
}

// ---- the customer's emails --------------------------------------------------------------------------------------------------
/** every value from the database goes through esc() (also numbers and dates) */
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const money = (n: number, currency = 'ILS') => `${currency === 'ILS' ? '₪' : `${currency} `}${Number(n).toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export type EmailKind = 'order_confirmation' | 'order_ready' | 'order_shipped' | 'order_refunded';
export interface EmailStore { name: string; phone: string; email: string; address: string; pickupNote: string; baseUrl: string | null }
export interface EmailOrder {
  number: number; isTest: boolean; currency: string; subtotal: number; discount: number; shipping: number; total: number;
  customerName: string; deliveryMethod: 'pickup' | 'delivery'; address: Record<string, string>;
  lines: { name: string; variantLabel: string; qty: number; lineTotal: number }[];
  trackingNumber: string; trackingUrl: string;
}
export interface Email { subject: string; html: string; text: string }

/**
 * A service email (confirmation, ready, shipped, refund): no advertising in it, ever (stage 5 adds marketing, with consent).
 * The confirmation carries the seller's details and the link to the returns policy — the disclosure of a distance sale
 * (NEEDS_LEGAL_VERIFICATION: the exact content is the lawyer's). A test order says so in the subject and on top.
 */
export function orderEmail(kind: EmailKind, s: EmailStore, o: EmailOrder, x: { orderUrl: string | null; refundAmount?: number }): Email {
  const test = o.isTest ? ' (הזמנת בדיקה)' : '';
  const hi = `שלום ${o.customerName},`;
  const link = x.orderUrl ? `לצפייה בהזמנה ובמסמך: ${x.orderUrl}` : '';
  const seller = [s.name, s.phone && `טלפון ${s.phone}`, s.email && `מייל ${s.email}`, s.address].filter(Boolean).join(' · ');
  const policies = s.baseUrl ? `מדיניות ביטולים והחזרות: ${s.baseUrl}/policies/returns` : '';
  let subject: string; let lines: string[];
  switch (kind) {
    case 'order_confirmation': {
      subject = `אישור הזמנה #${o.number} — ${s.name}${test}`;
      const items = o.lines.map((l) => `${l.name}${l.variantLabel ? ` — ${l.variantLabel}` : ''} × ${l.qty} · ${money(l.lineTotal, o.currency)}`);
      const sums = [
        o.discount > 0 ? `הנחה: −${money(o.discount, o.currency)}` : '',
        o.deliveryMethod === 'delivery' ? `משלוח: ${o.shipping > 0 ? money(o.shipping, o.currency) : 'חינם'}` : 'איסוף עצמי',
        `סה״כ ששולם: ${money(o.total, o.currency)}`,
      ].filter(Boolean);
      const where = o.deliveryMethod === 'delivery'
        ? `כתובת למשלוח: ${[o.address.street, o.address.house, o.address.apartment && `דירה ${o.address.apartment}`, o.address.city].filter(Boolean).join(' ')}`
        : `איסוף: ${s.pickupNote || s.address || 'נעדכן כשההזמנה מוכנה'}`;
      lines = [hi, `קיבלנו את ההזמנה שלך (#${o.number}) והתשלום אושר.${test}`, '', ...items, '', ...sums, where, '', link, '', `פרטי המוכר: ${seller}`, policies];
      break;
    }
    case 'order_ready':
      subject = `ההזמנה #${o.number} מוכנה לאיסוף — ${s.name}${test}`;
      lines = [hi, `ההזמנה שלך (#${o.number}) מוכנה לאיסוף.`, s.pickupNote || s.address, '', link, '', `פרטי המוכר: ${seller}`];
      break;
    case 'order_shipped':
      subject = `ההזמנה #${o.number} נשלחה — ${s.name}${test}`;
      lines = [hi, `ההזמנה שלך (#${o.number}) יצאה אלייך.`, o.trackingNumber ? `מספר מעקב: ${o.trackingNumber}` : '', o.trackingUrl ? `מעקב: ${o.trackingUrl}` : '',
        '', link, '', `פרטי המוכר: ${seller}`];
      break;
    case 'order_refunded':
      subject = `החזר כספי להזמנה #${o.number} — ${s.name}${test}`;
      lines = [hi, `ביצענו החזר של ${money(x.refundAmount ?? 0, o.currency)} להזמנה #${o.number}, לכרטיס שבו שילמת.`,
        'הזמן עד שההחזר מופיע בפירוט החיובים תלוי בחברת האשראי.', '', link, '', `פרטי המוכר: ${seller}`];
      break;
  }
  const kept = lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''));
  const text = kept.join('\n').trim();
  const html = `<!doctype html><html lang="he" dir="rtl"><body style="font-family:Arial,sans-serif;line-height:1.6;color:#111">`
    + kept.map((l) => (l === '' ? '<br>' : `<p style="margin:0">${linkify(l)}</p>`)).join('') + `</body></html>`;
  return { subject: subject.slice(0, 200), html, text };
}
/** a line with one https address in it: the address becomes a link (both escaped) */
export function linkify(line: string): string {
  const m = /https:\/\/[^\s<>"']+/.exec(line);
  if (!m) return esc(line);
  return `${esc(line.slice(0, m.index))}<a href="${esc(m[0])}">${esc(m[0])}</a>${esc(line.slice(m.index + m[0].length))}`;
}

/** the "from" of an email: the store's verified domain, else the platform's sending address (env), else none (it waits) */
export function emailFrom(storeName: string, domain: { domain: string; status: string; fromName: string } | null, fallback: string | undefined): string | null {
  const name = (domain?.fromName || storeName).replace(/["<>\r\n]/g, '').slice(0, 60) || 'החנות';
  if (domain && domain.status === 'verified') return `${name} <orders@${domain.domain}>`;
  const f = (fallback ?? '').trim();
  if (/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(f)) return `${name} <${f}>`;
  return null;
}

/** the owner's phone notification of an alert (store_alerts_claim) */
export interface StoreAlert { id: number; business: string; order: string; kind: string; body: string; number: number; total: number; name: string; test: boolean }
export function alertPush(a: StoreAlert): { title: string; body: string; url: string; tag: string } {
  const n = `#${a.number}`;
  const title = {
    new_order: `🛍️ הזמנה חדשה באתר ${n} · ${money(a.total)}`,
    late_payment: `⚠️ הזמנה ${n}: התשלום הגיע באיחור`,
    document_blocked: `⚠️ הזמנה ${n}: המסמך לא הופק`,
    request: `↩️ הזמנה ${n}: בקשה מהלקוח`,
    email_failed: `✉️ הזמנה ${n}: מייל לא נשלח`,
  }[a.kind] ?? `הזמנה ${n}`;
  return { title: a.test ? `${title} (בדיקה)` : title, body: [a.name, a.body].filter(Boolean).join(' · ').slice(0, 180),
    url: `/store/orders/${a.order}`, tag: `order-${a.order}-${a.kind}` };
}

// ---- the store's sending domain (Resend) -------------------------------------------------------------------------------------
/** "Shop.co.il " → "shop.co.il"; a sub-domain is fine (mail.shop.co.il). Null when it is not a domain. */
export function emailDomainOf(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  return d.length <= 200 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) && /\.[a-z]{2,}$/.test(d) ? d : null;
}
/** Resend's word → ours: only "verified" sends from the store's own domain */
export const emailDomainStatus = (s: string): 'pending' | 'verified' | 'failed' => (s === 'verified' ? 'verified' : s === 'failed' ? 'failed' : 'pending');
export const EMAIL_DOMAIN_HE: Record<'pending' | 'verified' | 'failed', string> = {
  pending: 'ממתין לרשומות DNS', verified: 'מאומת — המיילים יוצאים מהדומיין של החנות', failed: 'האימות נכשל — בודקים את הרשומות ומנסים שוב',
};

/** "תעודת ליקוט": what to pick and where it goes — no prices (it travels with the parcel). Every value through esc(). */
export function packingSlip(storeName: string, o: { number: number; customerName: string; customerPhone: string; deliveryMethod: 'pickup' | 'delivery';
  address: Record<string, string>; notes: string; createdAt: string }, lines: { name: string; variantLabel: string; sku: string; qty: number }[]): string {
  const addr = o.deliveryMethod === 'delivery'
    ? [o.address.street, o.address.house, o.address.apartment && `דירה ${o.address.apartment}`, o.address.city].filter(Boolean).join(' ')
    : 'איסוף עצמי';
  const day = new Date(o.createdAt).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const rows = lines.map((l) => `<tr><td>${esc(l.qty)}</td><td>${esc(l.name)}${l.variantLabel ? ` — ${esc(l.variantLabel)}` : ''}</td><td dir="ltr">${esc(l.sku)}</td><td>☐</td></tr>`).join('');
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>תעודת ליקוט #${esc(o.number)}</title>`
    + `<style>body{font-family:Arial,sans-serif;padding:24px}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{border:1px solid #999;padding:6px;text-align:start}</style></head><body>`
    + `<h1>${esc(storeName)} · הזמנה #${esc(o.number)}</h1><p>${esc(day)}</p>`
    + `<p><strong>${esc(o.customerName)}</strong> · <span dir="ltr">${esc(o.customerPhone)}</span><br>${esc(addr)}</p>`
    + (o.notes ? `<p>הערה: ${esc(o.notes)}</p>` : '')
    + `<table><thead><tr><th>כמות</th><th>מוצר</th><th>מק״ט</th><th>נלקט</th></tr></thead><tbody>${rows}</tbody></table>`
    + `</body></html>`;
}
