import { NextResponse } from 'next/server';
import { ACCESS_COOKIE, ACCESS_DAYS, accessCookie } from '@/lib/access';
import { data } from '@/lib/data';
import { readJson, sameOrigin } from '@/lib/request';
import { allowed } from '@/lib/shop';
import { getSite, hostOf } from '@/lib/site';

/**
 * The password of a store before publishing (or locked by its owner). The database says whether it is right and gives the
 * key; the cookie (this address only, httpOnly) carries an HMAC of it. 10 tries per 10 minutes per visitor and store.
 */
type Ctx = { params: Promise<{ host: string }> };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request, { params }: Ctx) {
  if (!sameOrigin(req)) return answer({ ok: false, message: 'משהו בבקשה לא תקין. נסו שוב.' }, 403);
  const site = await getSite(hostOf((await params).host));
  if (!site || !site.passwordPage) return answer({ ok: false, message: 'אין כאן כניסה עם סיסמה.' }, 404);
  if (!(await allowed(req, site, 'unlock', 10, 600))) return answer({ ok: false, message: 'יותר מדי ניסיונות. חכו כמה דקות ונסו שוב.' }, 429);
  const body = await readJson(req);
  if (!body || (typeof body.website === 'string' && body.website.trim() !== '')) return answer({ ok: false, message: 'משהו בבקשה לא תקין. נסו שוב.' }, 400);
  const password = typeof body.password === 'string' ? body.password.slice(0, 60) : '';
  const key = password ? await data.storeUnlock(site.storeId, password) : null;
  const value = key ? accessCookie(site.storeId, key) : null;
  if (!value) return answer({ ok: false, message: 'הסיסמה לא נכונה.' });
  const res = answer({ ok: true });
  const https = req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:';
  res.cookies.set(ACCESS_COOKIE, value, { httpOnly: true, secure: https, sameSite: 'lax', path: '/', maxAge: ACCESS_DAYS * 86400 });
  return res;
}
