import { adminDb } from './admin';
import { sendEmail } from './email';
import { paylinkRef } from './order-link';
import { emailFrom } from '@/features/store/commerce';
import { paylinkEmail } from '@/features/finance/paylinks';

/**
 * A payment link's email to the customer (migration 4300): one row of the one outbox (email_outbox kind payment_link, its
 * request_id), sent with the other emails (sendQueuedEmails) — from the store's verified domain, else the platform's
 * sending address (RESEND_FALLBACK_FROM), else it waits. Only a link that is still open is sent.
 */
type Db = ReturnType<typeof adminDb>;

/** the business as its customers know it: the trading name, the brand, the legal name, else its name (as sf_paylink) */
export async function businessContact(db: Db, businessId: string): Promise<{ name: string; phone: string; email: string }> {
  const [{ data: fp }, { data: br }, { data: rs }, { data: b }] = await Promise.all([
    db.from('business_finance_profile').select('trading_name, phone, email').eq('business_id', businessId).maybeSingle(),
    db.from('brands').select('name').eq('business_id', businessId).maybeSingle(),
    db.from('register_settings').select('legal_name').eq('business_id', businessId).maybeSingle(),
    db.from('businesses').select('name').eq('id', businessId).maybeSingle(),
  ]);
  const name = [(fp as any)?.trading_name, (br as any)?.name, (rs as any)?.legal_name, (b as any)?.name].map((x) => String(x ?? '').trim()).find(Boolean) ?? '';
  return { name: name.slice(0, 120), phone: String((fp as any)?.phone ?? ''), email: String((fp as any)?.email ?? '') };
}

export async function sendPaylinkEmail(db: Db, e: { id: string; request_id?: string | null; store_id?: string | null; business_id: string; to_email: string })
  : Promise<{ id: string } | { error: string; final: boolean }> {
  if (!e.request_id) return { error: 'no link', final: true };
  const { data: r } = await db.from('payment_requests').select('id, status, expires_at, label, amount, is_test, customer_name, link_origin')
    .eq('id', e.request_id).eq('business_id', e.business_id).maybeSingle();
  if (!r) return { error: 'the link was not found', final: true };
  if (!['sent', 'failed'].includes((r as any).status) || Date.parse((r as any).expires_at) <= Date.now()) return { error: 'הלינק כבר לא פתוח', final: true };
  const ref = paylinkRef((r as any).id);
  if (!ref) return { error: 'ORDER_LINK_SECRET is not set', final: false };
  const who = await businessContact(db, e.business_id);
  let domain: { domain: string; status: string; fromName: string } | null = null;
  if (e.store_id) {
    const { data: dom } = await db.from('store_email_domains').select('domain, status, from_name').eq('store_id', e.store_id).maybeSingle();
    if (dom) domain = { domain: (dom as any).domain, status: (dom as any).status, fromName: (dom as any).from_name ?? '' };
  }
  const from = emailFrom(who.name, domain, process.env.RESEND_FALLBACK_FROM);
  if (!from) return { error: 'אין כתובת שליחה מאומתת (מגדירים דומיין שליחה ב"מכירה באתר")', final: true };
  const mail = paylinkEmail({
    business: who.name, phone: who.phone, email: who.email, customerName: (r as any).customer_name ?? '', label: (r as any).label,
    amount: Number((r as any).amount), url: `${(r as any).link_origin}/pay/${ref}`, expiresAt: (r as any).expires_at, test: Boolean((r as any).is_test),
  });
  return sendEmail({ from, to: e.to_email, subject: mail.subject, html: mail.html, text: mail.text, replyTo: who.email || undefined, key: `dp-email-${e.id}` });
}
