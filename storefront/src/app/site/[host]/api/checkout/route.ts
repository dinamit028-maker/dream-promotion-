import { CHECKOUT_ERRORS, customerOf, startCheckout } from '@/lib/checkout';
import { clientIp, readJson, requestOrigin, sameOrigin } from '@/lib/request';
import { allowed, cartJson, cartToken, shopSite } from '@/lib/shop';
import { shopperKey } from '@/lib/tokens';

/**
 * "לתשלום": the customer's details → the order (the database computes it and holds the stock) → the provider's payment page.
 * The answer is the page's address; the browser goes there (a full redirect: the card is typed on the provider's page).
 */
type Ctx = { params: Promise<{ host: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) =>
    cartJson(req, { ok: false, error, message: CHECKOUT_ERRORS[error] ?? CHECKOUT_ERRORS.bad_request, ...extra }, { status });
  if (!sameOrigin(req)) return fail('bad_request', 403);
  const site = await shopSite((await params).host);
  if (!site) return fail('store', 404);
  if (!(await allowed(req, site, 'checkout', 10, 600))) return fail('rate', 429);
  const body = await readJson(req);
  if (!body) return fail('bad_request');
  if (typeof body.website === 'string' && body.website.trim() !== '') return fail('bot');   // a field people never see
  const token = await cartToken();
  if (!token) return fail('empty');
  const r = await startCheckout({
    storeId: site.storeId, storeName: site.store.name, preview: site.preview, origin: requestOrigin(req), cart: token,
    customer: customerOf(body), shopper: shopperKey(clientIp(req), site.storeId),
  });
  return cartJson(req, r);                 // a refusal of the shop (details, stock, coupon) is an answer, not a broken request
}
