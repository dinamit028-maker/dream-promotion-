import { adminDb, userFromRequest } from '@/lib/server/admin';
import { blockedFor, workBusiness } from '@/lib/server/business';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { isUuid } from '@/features/catalog/images';
import { domainRows, normalizeDomain } from '@/features/store/store';
import { addDomain, domainConfig, recordsFor, removeDomain, verifyDomain, vercelEnv, wwwRecord } from '@/features/store/vercel';

export const runtime = 'nodejs';

/**
 * The store's domain (2.55):
 *   connect → the domain (and www beside a bare name) is recorded for the store of the business worked in now, and — when
 *             the dashboard has Vercel's token — added to the storefront's project; the DNS records Vercel answers are kept
 *   check   → Vercel's view of each domain (records, verification); "active" is never set here: only the storefront sets it,
 *             the first time it really serves the domain (sf_domain_seen)
 *   remove  → the domain (and its www), here and in Vercel
 * Service role: this route checks the member (a writer, not a cashier, not a viewer, not a locked business) and the
 * business itself; it never takes a business or a store from the browser.
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string, code = 'bad_request', status = 400) => json(status, { code, message });

export async function POST(req: Request) {
  const limited = rateLimited(req, 'store-domains', 30, MINUTE);
  if (limited) return limited;
  const userId = await userFromRequest(req);
  if (!userId) return bad('צריך להתחבר מחדש.', 'no_session', 401);
  const blocked = await blockedFor(userId);
  if (blocked) return json(403, blocked);
  const business = await workBusiness(userId);
  if (!isUuid(business)) return bad('החשבון לא משויך לעסק.', 'no_business', 403);
  let body: any;
  try { body = await req.json(); } catch { return bad('בקשה לא תקינה.'); }
  const db = adminDb();
  const { data: store } = await db.from('stores').select('id').eq('business_id', business).maybeSingle();
  if (!store) return bad('עוד אין חנות לעסק הזה.', 'no_store', 404);
  const storeId = (store as { id: string }).id;
  const env = vercelEnv();
  const list = async () => ((await db.from('store_domains').select('*').eq('store_id', storeId).order('is_primary', { ascending: false }).order('domain')).data ?? []) as any[];
  const note = (rows: any[]) => ({ domains: rows, vercel: env ? 'connected' : 'not_configured' });

  try {
    if (body.action === 'connect') {
      const d = normalizeDomain(String(body.domain ?? ''));
      if (!d.ok) return bad(d.error);
      const have = await list();
      if (have.some((r) => r.is_primary)) return bad('כבר מחובר דומיין ראשי. כדי להחליף, הסירו אותו קודם.', 'has_primary', 409);
      const rows = domainRows(d).map((r) => ({ business_id: business, store_id: storeId, domain: r.domain, is_primary: r.isPrimary, created_by: userId }));
      const { error } = await db.from('store_domains').insert(rows);
      if (error) {
        if (/store_domains_domain_uq|duplicate key/.test(error.message)) return bad('הדומיין כבר מחובר לחנות (אולי של עסק אחר). אם הוא שלכם — פנו אלינו.', 'taken', 409);
        return bad('הדומיין לא נשמר — נסו שוב.', 'insert_failed', 500);
      }
      if (env) {
        for (const r of rows) {
          const added = await addDomain(env, r.domain, r.is_primary ? undefined : d.domain);
          const ok = added.ok || added.status === 409;
          const config = ok ? (await domainConfig(env, r.domain)).body : {};
          const records = r.is_primary ? recordsFor(r.domain, d.bare, added.body, config) : [wwwRecord(config)];
          await db.from('store_domains').update({
            status: ok ? 'verifying' : 'error', last_checked_at: new Date().toISOString(),
            vercel: { added: ok, code: added.code ?? null, message: ok ? null : added.message ?? null, verified: added.body?.verified ?? null,
              misconfigured: config?.misconfigured ?? null, records },
          }).eq('store_id', storeId).eq('domain', r.domain);
        }
      } else {
        for (const r of rows) {
          const records = r.is_primary ? recordsFor(r.domain, d.bare) : [wwwRecord()];
          await db.from('store_domains').update({ vercel: { added: false, manual: true, records } }).eq('store_id', storeId).eq('domain', r.domain);
        }
      }
      return json(200, note(await list()));
    }

    if (body.action === 'check') {
      const rows = await list();
      if (env) {
        for (const r of rows) {
          if (r.status === 'active') continue;
          const v = await verifyDomain(env, r.domain);
          const config = (await domainConfig(env, r.domain)).body;
          const bare = !r.domain.startsWith('www.') && normalizeDomain(r.domain).ok && (normalizeDomain(r.domain) as { bare: boolean }).bare;
          const records = r.is_primary ? recordsFor(r.domain, bare, v.body, config) : [wwwRecord(config)];
          // not verified yet (the DNS is not set, or not updated yet) is waiting, not a problem; a problem is a domain that
          // Vercel does not have in the project (404) or will not give it (403)
          const broken = v.status === 403 || v.status === 404;
          await db.from('store_domains').update({
            status: broken ? 'error' : 'verifying', last_checked_at: new Date().toISOString(),
            vercel: { ...(r.vercel ?? {}), verified: v.body?.verified ?? null, misconfigured: config?.misconfigured ?? null, records,
              code: v.ok ? null : v.code ?? null, message: v.ok ? null : v.message ?? null },
          }).eq('id', r.id);
        }
      }
      return json(200, note(await list()));
    }

    if (body.action === 'remove') {
      if (!isUuid(body.domainId)) return bad('דומיין לא מוכר.');
      const rows = await list();
      const target = rows.find((r) => r.id === body.domainId);
      if (!target) return bad('הדומיין לא נמצא בחנות הזו.', 'not_found', 404);
      // the primary bare name takes its www with it
      const gone = target.is_primary ? rows.filter((r) => r.id === target.id || r.domain === `www.${target.domain}`) : [target];
      if (env) for (const r of gone) await removeDomain(env, r.domain);
      const { error } = await db.from('store_domains').delete().in('id', gone.map((r) => r.id)).eq('store_id', storeId);
      if (error) return bad('הדומיין לא הוסר — נסו שוב.', 'delete_failed', 500);
      return json(200, note(await list()));
    }

    return bad('פעולה לא מוכרת.');
  } catch {
    return bad('משהו השתבש בחיבור הדומיין — נסו שוב.', 'domain_error', 500);
  }
}
