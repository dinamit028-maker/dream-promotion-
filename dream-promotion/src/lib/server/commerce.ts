import { adminDb } from './admin';
import { businessOpen } from './business';
import { notifyManagers } from './notify';
import { emailConfigured, sendEmail } from './email';
import { orderRef } from './order-link';
import { sendPaylinkEmail } from './paylink-mail';
import { sendReminderEmail } from './reminders';
import { documentRow } from '@/features/finance/rows';
import { creditForRefund, toDoc } from '@/features/documents/documents';
import { toRefund } from '@/features/register/refunds';
import { israelParts } from '@/lib/il-time';
import {
  alertPush, documentFailure, emailFrom, orderDocument, orderEmail, orderVat, saleFromRow, toVatSettings,
  type EmailKind, type StoreAlert,
} from '@/features/store/commerce';
import type { RefundPlan } from '@/features/register/refunds';

/**
 * Dream Commerce stage 4 on the dashboard's server (service role — no row-level security, so every read and write names
 * the order's own business). Called by /api/commerce/finalize (the storefront, right after a real payment; the owner's
 * "נסו שוב") and by /api/cron/commerce (every 2 minutes: what was missed). Each step is safe to run twice:
 *   1. the sale      commerce_record_sale (VAT from vat.ts at the business's rate) — the sale's id is the order's
 *   2. the document  the register's docFromSale, inserted with idempotency_key sale:<order id> — the same key as the money
 *                    screen's "a paid sale without a document", so the two never make two documents
 *   3. alerts        the owners' phones; 4. emails  the customer (Resend), "sent" only with Resend's id
 */
type Db = ReturnType<typeof adminDb>;
const today = () => israelParts(Date.now()).date;

async function settingsOf(db: Db, businessId: string) {
  const { data } = await db.from('register_settings').select('business_type, vat_rate').eq('business_id', businessId).maybeSingle();
  return toVatSettings(data);
}

export type FinalizeResult = { order: string; sale: 'recorded' | 'already' | 'skipped' | 'error'; document: 'issued' | 'blocked' | 'waiting' | 'none'; error?: string };

export async function finalizeOrder(orderId: string): Promise<FinalizeResult> {
  const db = adminDb();
  const { data: o } = await db.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (!o || o.is_test || !['paid', 'partially_refunded', 'refunded'].includes(o.payment_status)) return { order: orderId, sale: 'skipped', document: 'none' };
  const settings = await settingsOf(db, o.business_id);
  let sale: FinalizeResult['sale'] = 'already';
  if (!o.sale_id) {
    const vat = orderVat(Number(o.total), settings);
    const { data, error } = await db.rpc('commerce_record_sale', { p_order: o.id, p_vat_rate: vat.rate, p_vat_amount: vat.amount });
    if (error) { console.error('[commerce] record sale', o.id, error.message); return { order: o.id, sale: 'error', document: 'waiting', error: error.message }; }
    sale = (data as any)?.result === 'ok' ? 'recorded' : 'already';
  }
  const { data: fresh } = await db.from('orders').select('id, business_id, sale_id, document_status, customer_email').eq('id', o.id).maybeSingle();
  if (!fresh?.sale_id) return { order: o.id, sale: 'error', document: 'waiting' };
  if (fresh.document_status !== 'pending') return { order: o.id, sale, document: fresh.document_status === 'issued' ? 'issued' : fresh.document_status === 'blocked' ? 'blocked' : 'none' };
  // a locked business issues nothing (the order stays "שולם — מסמך ממתין" until it is open again)
  if (!(await businessOpen(fresh.business_id))) return { order: o.id, sale, document: 'waiting', error: 'business_locked' };
  return { order: o.id, sale, ...(await issueOrderDocument(db, fresh, settings.businessType === 'licensed')) };
}

async function issueOrderDocument(db: Db, o: { id: string; business_id: string; sale_id: string; customer_email: string }, licensed: boolean)
  : Promise<{ document: FinalizeResult['document']; error?: string }> {
  const key = `sale:${o.sale_id}`;
  const done = async (docId: string) => {
    const { error } = await db.rpc('order_document_done', { p_order: o.id, p_document: docId, p_error: '' });
    return error ? { document: 'waiting' as const, error: error.message } : { document: 'issued' as const };
  };
  // issued already (by an earlier run whose answer was lost, or by hand in the money screen)
  const { data: had } = await db.from('documents').select('id').eq('business_id', o.business_id).eq('idempotency_key', key).maybeSingle();
  if (had) return done(had.id);
  const { data: s } = await db.from('sales').select('*').eq('id', o.sale_id).eq('business_id', o.business_id).maybeSingle();
  if (!s) return { document: 'waiting', error: 'sale not found' };
  const sale = saleFromRow(s);
  const doc = orderDocument(sale, { licensed, docDate: today(), email: o.customer_email });
  const row = {
    ...documentRow(doc, { userId: s.user_id, idempotencyKey: key, vatRate: doc.lines[0]?.vatRate ?? 0, saleId: sale.id, leadId: sale.leadId, source: 'pos' }),
    business_id: o.business_id,
  };
  const ins = await db.from('documents').insert(row).select('id').single();
  if (!ins.error && ins.data) return done(ins.data.id);
  const m = `${ins.error?.message ?? ''} ${ins.error?.details ?? ''}`;
  if (ins.error?.code === '23505' && /idempotency/.test(m)) {
    const { data: again } = await db.from('documents').select('id').eq('business_id', o.business_id).eq('idempotency_key', key).maybeSingle();
    if (again) return done(again.id);
  }
  const f = documentFailure(ins.error);
  if (!f.blocked) { console.error('[commerce] document', o.id, ins.error?.message); return { document: 'waiting', error: f.reason }; }
  await db.rpc('order_document_done', { p_order: o.id, p_document: null, p_error: f.reason });
  return { document: 'blocked', error: f.reason };
}

/** live orders still to finish (the cron), until the deadline */
export async function finalizePending(deadline: number): Promise<FinalizeResult[]> {
  const db = adminDb();
  const { data } = await db.rpc('commerce_pending', { p_limit: 20 });
  const out: FinalizeResult[] = [];
  for (const id of (Array.isArray(data) ? data : []) as string[]) {
    if (Date.now() > deadline) break;
    out.push(await finalizeOrder(id));
  }
  return out;
}

/** the alerts not yet on the owners' phones */
export async function pushStoreAlerts(): Promise<number> {
  const { data } = await adminDb().rpc('store_alerts_claim', { p_limit: 20 });
  let sent = 0;
  for (const a of (Array.isArray(data) ? data : []) as StoreAlert[]) sent += (await notifyManagers(a.business, alertPush(a))).sent;
  return sent;
}

/** https://<the store's domain> — its primary domain that the storefront served, else any of its live ones */
export async function storeBaseUrl(storeId: string): Promise<string | null> {
  const { data } = await adminDb().from('store_domains').select('domain, is_primary, status').eq('store_id', storeId).eq('status', 'active');
  const list = (data ?? []) as { domain: string; is_primary: boolean }[];
  const d = list.find((x) => x.is_primary) ?? list[0];
  return d ? `https://${d.domain}` : null;
}

/** the emails waiting in the outbox (nothing is taken while Resend is not set up: they wait, they do not fail) */
export async function sendQueuedEmails(): Promise<{ sent: number; failed: number }> {
  if (!emailConfigured()) return { sent: 0, failed: 0 };
  const db = adminDb();
  const { data } = await db.rpc('email_outbox_claim', { p_limit: 20 });
  let sent = 0, failed = 0;
  for (const e of (Array.isArray(data) ? data : []) as any[]) {
    const r = await sendOne(db, e).catch((err) => ({ error: String(err?.message ?? err).slice(0, 200), final: false }));
    if ('id' in r) { sent++; await db.rpc('email_outbox_done', { p_id: e.id, p_provider_id: r.id, p_error: '', p_final: false }); }
    else { failed++; await db.rpc('email_outbox_done', { p_id: e.id, p_provider_id: '', p_error: r.error, p_final: r.final }); }
  }
  return { sent, failed };
}

async function sendOne(db: Db, e: { id: string; order_id: string; store_id: string; business_id: string; kind: EmailKind | 'payment_link' | 'debt_reminder'; ref: string;
                                     to_email: string; request_id?: string | null; reminder_id?: string | null }) {
  // a payment link's email (migration 4300): no order — its own text and link
  if (e.kind === 'payment_link') return sendPaylinkEmail(db, e);
  // a debt reminder's email (migration 4400): asked again just before it goes (a payment stops it)
  if (e.kind === 'debt_reminder') return sendReminderEmail(db, e);
  const [{ data: o }, { data: lines }, { data: st }, { data: dom }] = await Promise.all([
    db.from('orders').select('*').eq('id', e.order_id).eq('business_id', e.business_id).maybeSingle(),
    db.from('order_lines').select('name, variant_label, qty, line_total, position').eq('order_id', e.order_id).order('position'),
    db.from('stores').select('name, phone, email, address, pickup_note').eq('id', e.store_id).eq('business_id', e.business_id).maybeSingle(),
    db.from('store_email_domains').select('domain, status, from_name').eq('store_id', e.store_id).maybeSingle(),
  ]);
  if (!o || !st) return { error: 'order or store not found', final: true };
  const from = emailFrom(st.name, dom ? { domain: dom.domain, status: dom.status, fromName: dom.from_name ?? '' } : null, process.env.RESEND_FALLBACK_FROM);
  if (!from) return { error: 'אין דומיין שליחה מאומת לחנות (מגדירים ב"מכירה באתר")', final: true };
  let refundAmount: number | undefined;
  if (e.kind === 'order_refunded') {
    const { data: r } = await db.from('sale_refunds').select('amount').eq('id', e.ref).eq('business_id', e.business_id).maybeSingle();
    refundAmount = Number(r?.amount ?? 0);
  }
  const baseUrl = await storeBaseUrl(e.store_id);
  const ref = orderRef(o.id);
  const mail = orderEmail(e.kind,
    { name: st.name, phone: st.phone ?? '', email: st.email ?? '', address: st.address ?? '', pickupNote: st.pickup_note ?? '', baseUrl },
    {
      number: Number(o.number), isTest: Boolean(o.is_test), currency: o.currency ?? 'ILS', subtotal: Number(o.subtotal), discount: Number(o.discount),
      shipping: Number(o.shipping), total: Number(o.total), customerName: o.customer_name, deliveryMethod: o.delivery_method,
      address: (o.address ?? {}) as Record<string, string>,
      lines: ((lines ?? []) as any[]).map((l) => ({ name: l.name, variantLabel: l.variant_label ?? '', qty: Number(l.qty), lineTotal: Number(l.line_total) })),
      trackingNumber: o.tracking_number ?? '', trackingUrl: o.tracking_url ?? '',
    },
    { orderUrl: baseUrl && ref ? `${baseUrl}/orders/${ref}` : null, refundAmount });
  return sendEmail({ from, to: e.to_email, subject: mail.subject, html: mail.html, text: mail.text, replyTo: st.email || undefined, key: `dp-email-${e.id}` });
}

/**
 * A refund recorded from the order's page (the money already went back in the payment company's screen). The database's
 * own triggers check the ceiling under a lock, write the ledger, restock, and update the order. A licensed business's
 * invoice gets its credit invoice (330) on the key refund:<id>, as the register does.
 */
export async function recordOrderRefund(businessId: string, userId: string, saleId: string, plan: RefundPlan)
  : Promise<{ ok: true; refundId: string; credit: 'issued' | 'not_required' | string } | { ok: false; error: unknown }> {
  const db = adminDb();
  const id = crypto.randomUUID();
  const { error } = await db.from('sale_refunds').insert({
    id, user_id: userId, business_id: businessId, sale_id: saleId, amount: plan.amount, vat_amount: plan.vatAmount, method: plan.method,
    items: plan.items, restock: plan.restock, reason: plan.reason, employee_name: plan.employeeName,
  });
  if (error) return { ok: false, error };
  const [{ data: s }, { data: docs }] = await Promise.all([
    db.from('sales').select('*').eq('id', saleId).eq('business_id', businessId).maybeSingle(),
    db.from('documents').select('*').eq('business_id', businessId).eq('sale_id', saleId).in('doc_type', [320, 305]).order('issued_at').limit(1),
  ]);
  const orig = (docs ?? [])[0];
  if (!s || !orig) return { ok: true, refundId: id, credit: 'not_required' };
  const sale = saleFromRow(s);
  const { data: r } = await db.from('sale_refunds').select('*').eq('id', id).maybeSingle();
  const refund = toRefund(r ?? { id, sale_id: saleId, amount: plan.amount, vat_amount: plan.vatAmount, items: plan.items });
  const credit = creditForRefund(toDoc(orig), refund, sale, today());
  const row = {
    ...documentRow(credit, { userId, idempotencyKey: `refund:${id}`, vatRate: credit.lines[0]?.vatRate ?? 0, saleId, leadId: sale.leadId, refundId: id }),
    business_id: businessId,
  };
  const ins = await db.from('documents').insert(row).select('id').single();
  if (ins.error) return { ok: true, refundId: id, credit: documentFailure(ins.error).reason };
  return { ok: true, refundId: id, credit: 'issued' };
}
