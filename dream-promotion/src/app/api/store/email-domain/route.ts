import { adminDb } from '@/lib/server/admin';
import { financeCaller } from '@/lib/server/finance';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { addDomain, checkDomain, emailConfigured } from '@/lib/server/email';
import { emailDomainOf, emailDomainStatus } from '@/features/store/commerce';

export const runtime = 'nodejs';

/**
 * The store's sending domain for the customers' emails (Resend). The screen reads store_email_domains itself (row-level
 * security); only this server writes it, with what Resend answered — a store never marks its own domain "verified".
 *   POST {action: 'connect', domain, fromName}  → Resend adds it and answers with the DNS records to add
 *   POST {action: 'verify'}                     → Resend checks the records now
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string, code = 'bad_request', status = 400) => json(status, { code, message });

export async function POST(req: Request) {
  const limited = rateLimited(req, 'store-email-domain', 10, MINUTE);
  if (limited) return limited;
  const c = await financeCaller(req, { write: true });
  if (!c.ok) return json(c.status, c.body);
  if (!emailConfigured()) return bad('שירות המיילים עוד לא מוגדר בשרת (חסר RESEND_API_KEY ב-Vercel).', 'not_configured', 503);
  const body = await req.json().catch(() => null);
  const db = adminDb();
  const { data: store } = await db.from('stores').select('id').eq('business_id', c.businessId).order('created_at').limit(1).maybeSingle();
  if (!store) return bad('אין חנות לעסק.', 'no_store', 404);

  if (body?.action === 'connect') {
    const domain = emailDomainOf(String(body.domain ?? ''));
    if (!domain) return bad('כתבו דומיין, למשל shop.co.il');
    const fromName = String(body.fromName ?? '').replace(/["<>\r\n]/g, '').trim().slice(0, 60);
    const { data: had } = await db.from('store_email_domains').select('domain, provider_id').eq('store_id', store.id).maybeSingle();
    if (had && had.domain === domain && had.provider_id) {
      await db.from('store_email_domains').update({ from_name: fromName }).eq('store_id', store.id);
      return json(200, { ok: true, again: true });
    }
    const r = await addDomain(domain);
    if (!r.ok) return bad(/already|exists/i.test(r.error) ? 'הדומיין כבר רשום בשירות המיילים בחשבון אחר.' : 'שירות המיילים לא קיבל את הדומיין. בדקו את הכתיבה ונסו שוב.', 'provider', 502);
    const { error } = await db.from('store_email_domains').upsert({
      store_id: store.id, business_id: c.businessId, domain, provider_id: r.domain.id, status: emailDomainStatus(r.domain.status),
      records: r.domain.records, from_name: fromName, checked_at: new Date().toISOString(),
    }, { onConflict: 'store_id' });
    if (error) return bad(/does not exist|schema cache/i.test(error.message) ? 'צריך קודם להריץ את מיגרציה 20261006003600_commerce_finance.sql.' : 'לא נשמר — נסו שוב.', 'save_failed', 500);
    return json(200, { ok: true });
  }

  if (body?.action === 'verify') {
    const { data: d } = await db.from('store_email_domains').select('provider_id').eq('store_id', store.id).eq('business_id', c.businessId).maybeSingle();
    if (!d?.provider_id) return bad('עוד לא חוברה כתובת שליחה.');
    const r = await checkDomain(d.provider_id);
    if (!r.ok) return bad('שירות המיילים לא ענה. נסו שוב בעוד דקה.', 'provider', 502);
    await db.from('store_email_domains').update({ status: emailDomainStatus(r.domain.status), records: r.domain.records, checked_at: new Date().toISOString() })
      .eq('store_id', store.id);
    return json(200, { ok: true, status: emailDomainStatus(r.domain.status) });
  }
  return bad('בקשה לא תקינה.');
}
