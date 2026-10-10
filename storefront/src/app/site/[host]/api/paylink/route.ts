import { checkTerminal, confirmPaylink, fromDashboard, paylinkPage, returnUrlOk } from '@/lib/paylinks';
import { data } from '@/lib/data';
import { readJson, requestOrigin } from '@/lib/request';

/**
 * Payment links (migration 4300): the dashboard's server asks — on any host of the storefront (its STOREFRONT_URL), with the
 * shared secret COMMERCE_SECRET in x-commerce-secret. This server alone opens the terminal's keys.
 *   {action: 'page', request, returnUrl}  → {ok, url} a page of the provider for the link (the customer is sent there)
 *   {action: 'confirm', request}          → {status} the provider is asked about the link's open pages
 *   {action: 'check', business}           → {ok} "בדיקת חיבור": the terminal's keys make a page → verified
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request) {
  if (!fromDashboard(req)) return json(401, { ok: false, error: 'forbidden' });
  const body = await readJson(req, 4_000);
  if (!body) return json(400, { ok: false, error: 'bad' });
  const origin = requestOrigin(req);
  try {
    if (body.action === 'page') {
      if (typeof body.request !== 'string' || !UUID.test(body.request) || !returnUrlOk(body.returnUrl)) return json(400, { ok: false, error: 'bad' });
      return json(200, await paylinkPage(body.request.toLowerCase(), body.returnUrl, origin));
    }
    if (body.action === 'confirm') {
      if (typeof body.request !== 'string' || !UUID.test(body.request)) return json(400, { ok: false, error: 'bad' });
      const link = await data.paylink(body.request.toLowerCase());
      if (!link) return json(404, { ok: false, error: 'not_found' });
      const s = await confirmPaylink(link, 'verify');
      return json(200, { ok: true, status: s === 'unknown' ? link.status : s, unknown: s === 'unknown' });
    }
    if (body.action === 'check') {
      if (typeof body.business !== 'string' || !UUID.test(body.business)) return json(400, { ok: false, error: 'bad' });
      return json(200, await checkTerminal(body.business.toLowerCase(), origin));
    }
  } catch (e) {
    console.error('[paylink]', e);
    return json(500, { ok: false, error: 'error' });
  }
  return json(400, { ok: false, error: 'bad' });
}
