import { data } from '@/lib/data';
import { orderRefOk } from '@/lib/order-link';
import { REQUEST_ERRORS } from '@/lib/orders';
import { readJson, sameOrigin } from '@/lib/request';
import { allowed } from '@/lib/shop';
import { getSite, hostOf } from '@/lib/site';
import { hashToken, isToken } from '@/lib/tokens';

/**
 * "ביטול / החזרה": the customer asks, from the order's page (its link) or from /cancel (the order's number + the email it
 * was made with). Recorded on the order and told to the owner; no money moves by itself (DREAM_COMMERCE_ARCHITECTURE §6.8).
 */
type Ctx = { params: Promise<{ host: string }> };
const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request, { params }: Ctx) {
  const fail = (error: string, status = 200) => answer({ ok: false, error, message: REQUEST_ERRORS[error] ?? REQUEST_ERRORS.bad_request }, status);
  if (!sameOrigin(req)) return fail('bad_request', 403);
  const site = await getSite(hostOf((await params).host));
  if (!site?.live) return fail('not_found', 404);
  if (!(await allowed(req, site, 'order-request', 5, 600))) return fail('rate', 429);
  const body = await readJson(req);
  if (!body) return fail('bad_request', 400);
  if (typeof body.website === 'string' && body.website.trim() !== '') return fail('bot');
  const kind = body.kind === 'return' ? 'return' : body.kind === 'cancel' ? 'cancel' : null;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (!kind) return fail('bad_request', 400);
  const ref = typeof body.ref === 'string' ? body.ref : '';
  let r;
  if (ref) {
    const id = isToken(ref) ? null : orderRefOk(ref);
    r = isToken(ref) ? await data.orderRequest(site.storeId, hashToken(ref), kind, note)
      : id ? await data.orderRequestById(site.storeId, id, kind, note) : null;
  } else {
    const num = Number(String(body.number ?? '').replace(/[^\d]/g, ''));
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 120) : '';
    if (!Number.isInteger(num) || num < 1 || num > 2_000_000_000 || email.length < 3) return fail('not_found');
    r = await data.orderRequestByNumber(site.storeId, num, email, kind, note);
  }
  if (!r) return fail('not_found');
  if (!r.ok) return fail(r.error);
  return answer({ ok: true, kind: r.kind, message: kind === 'cancel' ? 'בקשת הביטול התקבלה. נחזור אליכם בהקדם.' : 'בקשת ההחזרה התקבלה. נחזור אליכם עם הפרטים.' });
}
