import { adminDb, userFromRequest } from '@/lib/server/admin';
import { registerOnly, userLocked, workBusiness } from '@/lib/server/business';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { isUuid } from '@/features/catalog/images';
import { makeRevalidateToken, REVALIDATE_SECONDS } from '@/features/store/preview-token';

export const runtime = 'nodejs';

/**
 * 2.74: after a change the shoppers see, the storefront drops what it keeps of the store worked in now (its shared cache —
 * storefront/src/lib/shared-cache.ts): a request to its /api/revalidate, signed for that store only. Nothing to set up
 * beyond what the preview needs (STOREFRONT_URL, STOREFRONT_PREVIEW_SECRET); without them — nothing to drop, said quietly.
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request) {
  const limited = rateLimited(req, 'store-revalidate', 60, MINUTE);
  if (limited) return limited;
  const userId = await userFromRequest(req);
  if (!userId) return json(401, { code: 'no_session', message: 'צריך להתחבר מחדש.' });
  if (await userLocked(userId) || await registerOnly(userId)) return json(403, { code: 'not_allowed', message: 'אין הרשאה.' });
  const secret = process.env.STOREFRONT_PREVIEW_SECRET, base = process.env.STOREFRONT_URL;
  if (!secret || secret.length < 16 || !base || !/^https?:\/\//.test(base)) return json(200, { ok: false, reason: 'not_configured' });
  const business = await workBusiness(userId);
  if (!isUuid(business)) return json(403, { code: 'no_business', message: 'החשבון לא משויך לעסק.' });
  const { data: store } = await adminDb().from('stores').select('id').eq('business_id', business).maybeSingle();
  if (!store) return json(404, { code: 'no_store', message: 'עוד אין חנות לעסק הזה.' });
  const token = makeRevalidateToken((store as { id: string }).id, secret, Math.floor(Date.now() / 1000) + REVALIDATE_SECONDS);
  try {
    const res = await fetch(new URL('/api/revalidate', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(4000),
    });
    return json(200, { ok: res.ok });
  } catch {
    return json(200, { ok: false, reason: 'unreachable' });   // the change shows within the cache's few minutes anyway
  }
}
