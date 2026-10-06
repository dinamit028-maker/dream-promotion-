import { adminDb, userFromRequest } from '@/lib/server/admin';
import { cleanRoot } from '@/features/store/store';
import { LOCKED, REGISTER_ONLY, registerOnly, userLocked, workBusiness } from '@/lib/server/business';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { isUuid } from '@/features/catalog/images';
import { makePreviewToken, previewUrl, PREVIEW_SECONDS } from '@/features/store/preview-token';

export const runtime = 'nodejs';

/**
 * A preview link of the store worked in now (2.55): the draft theme, or a store that is not on the air yet — for one hour,
 * for that store only. A viewer may look (it changes nothing); a cashier has no store. It opens on the store's own domain
 * once that domain works, else on the storefront's address (STOREFRONT_URL). Needs STOREFRONT_PREVIEW_SECRET (both apps).
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request) {
  const limited = rateLimited(req, 'store-preview', 30, MINUTE);
  if (limited) return limited;
  const userId = await userFromRequest(req);
  if (!userId) return json(401, { code: 'no_session', message: 'צריך להתחבר מחדש.' });
  if (await userLocked(userId)) return json(403, LOCKED);
  if (await registerOnly(userId)) return json(403, REGISTER_ONLY);
  const secret = process.env.STOREFRONT_PREVIEW_SECRET;
  if (!secret || secret.length < 16) {
    return json(503, { code: 'not_configured', message: 'תצוגה מקדימה עוד לא מוגדרת: חסר STOREFRONT_PREVIEW_SECRET בהגדרות של שני הפרויקטים ב-Vercel.' });
  }
  const business = await workBusiness(userId);
  if (!isUuid(business)) return json(403, { code: 'no_business', message: 'החשבון לא משויך לעסק.' });
  const db = adminDb();
  const { data: store } = await db.from('stores').select('*').eq('business_id', business).maybeSingle();
  if (!store) return json(404, { code: 'no_store', message: 'עוד אין חנות לעסק הזה.' });
  const { data: dom } = await db.from('store_domains').select('domain').eq('store_id', (store as any).id).eq('is_primary', true).eq('status', 'active').maybeSingle();
  // its own domain once that works; else its own address (2.57.1) once the storefront served it; else the storefront's address
  const root = cleanRoot(process.env.STORE_ROOT_DOMAIN), st = store as any;
  const base = dom ? `https://${(dom as any).domain}` : root && st.slug && st.subdomain_seen_at ? `https://${st.slug}.${root}` : process.env.STOREFRONT_URL;
  if (!base || !/^https?:\/\//.test(base)) {
    return json(503, { code: 'not_configured', message: 'אין עדיין כתובת לתצוגה: הדומיין לא פעיל, ו-STOREFRONT_URL לא הוגדר ב-Vercel.' });
  }
  const expires = Math.floor(Date.now() / 1000) + PREVIEW_SECONDS;
  return json(200, { url: previewUrl(base, makePreviewToken((store as any).id, secret, expires)), expires });
}
