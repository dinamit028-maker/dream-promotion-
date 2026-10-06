import { CART_ERRORS, couponMessage } from '@/lib/checkout';
import { data } from '@/lib/data';
import { readJson, sameOrigin } from '@/lib/request';
import { allowed, cartJson, cartToken, shopSite } from '@/lib/shop';
import { hashToken, newToken } from '@/lib/tokens';

/**
 * The cart: GET reads it; POST changes it — { action: 'add' | 'set', item, variant, qty } or { action: 'coupon', code }.
 * The browser sends ids and quantities only; every price and every limit is the database's (sf_cart_set / sf_cart_coupon).
 */
type Ctx = { params: Promise<{ host: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(req: Request, { params }: Ctx) {
  const site = await shopSite((await params).host);
  if (!site) return cartJson(req, { ok: false, error: 'store', message: CART_ERRORS.store }, { status: 404 });
  const token = await cartToken();
  const cart = await data.cart(site.storeId, hashToken(token ?? newToken()), site.preview);
  return cartJson(req, { ok: true, cart }, { cart });
}

export async function POST(req: Request, { params }: Ctx) {
  if (!sameOrigin(req)) return cartJson(req, { ok: false, error: 'bad_request', message: CART_ERRORS.bad_request }, { status: 403 });
  const site = await shopSite((await params).host);
  if (!site) return cartJson(req, { ok: false, error: 'store', message: CART_ERRORS.store }, { status: 404 });
  if (!(await allowed(req, site, 'cart', 60, 60))) return cartJson(req, { ok: false, error: 'rate', message: CART_ERRORS.rate }, { status: 429 });
  const body = await readJson(req);
  if (!body) return cartJson(req, { ok: false, error: 'bad_request', message: CART_ERRORS.bad_request }, { status: 400 });

  let token = await cartToken();
  let changed = !token;                // a new cookie to keep
  token ??= newToken();
  if (body.action === 'coupon') {
    if (!(await allowed(req, site, 'coupon', 10, 600))) return cartJson(req, { ok: false, error: 'rate', message: CART_ERRORS.rate }, { status: 429 });
    const r = await data.cartCoupon(site.storeId, hashToken(token), typeof body.code === 'string' ? body.code.slice(0, 40) : '', site.preview);
    const message = r?.ok ? '' : r?.error && r.error in CART_ERRORS ? CART_ERRORS[r.error] : couponMessage({ code: '', error: r?.error as any, min: r?.min });
    return cartJson(req, { ok: Boolean(r?.ok), error: r?.error, message, cart: r?.cart }, { cart: r?.cart });
  }
  const item = typeof body.item === 'string' && UUID.test(body.item) ? body.item : null;
  const variant = typeof body.variant === 'string' && UUID.test(body.variant) ? body.variant : null;
  const qty = typeof body.qty === 'number' && Number.isInteger(body.qty) ? body.qty : NaN;
  const mode = body.action === 'add' ? 'add' : body.action === 'set' ? 'set' : null;
  if (!item || !mode || !Number.isFinite(qty) || qty < 0 || qty > 20) {
    return cartJson(req, { ok: false, error: 'bad_request', message: CART_ERRORS.bad_request }, { status: 400 });
  }
  let r = await data.cartSet(site.storeId, hashToken(token), item, variant, qty, mode, site.preview);
  if (r?.error === 'cart') {           // a cookie of another store (it cannot normally happen): start a new cart
    token = newToken(); changed = true;
    r = await data.cartSet(site.storeId, hashToken(token), item, variant, qty, mode, site.preview);
  }
  const ok = Boolean(r?.ok);
  let message = ok ? '' : CART_ERRORS[r?.error ?? 'bad_request'] ?? CART_ERRORS.bad_request;
  if (r?.error === 'not_enough' && r.available != null) message = r.available > 0 ? `נשארו רק ${r.available} במלאי.` : 'המוצר אזל מהמלאי.';
  return cartJson(req, { ok, error: r?.error, message, available: r?.available, cart: r?.cart },
    { token: ok && changed ? token : null, cart: r?.cart });
}
