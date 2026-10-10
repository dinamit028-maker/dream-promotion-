import { UNAVAILABLE, businessOpen } from '@/lib/server/business';
import { paylinkRefOk } from '@/lib/server/order-link';
import { appOrigin, publicLink, storefrontPaylink } from '@/lib/server/paylinks';
import { MINUTE, PUBLIC_LIMITS, rateLimited } from '@/lib/server/rate-limit';
import { PAGE_ERRORS_HE } from '@/features/finance/paylinks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The customer's payment link: /pay/<request id>.<mac> (ORDER_LINK_SECRET, "paylink:"). No login. Nothing internal leaves
 * the server (no ids, no terminal, not the customer's phone or email).
 *   GET                     → {link} what is paid, how much, to whom, its status
 *   POST {action: 'start'}  → {url} the provider's page (made by the storefront's server, the only one that opens the keys)
 *   POST {action: 'check'}  → {link} back from paying: the provider is asked directly (never the return alone), then the status
 * A locked business answers "השירות אינו זמין".
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
type Ctx = { params: Promise<{ ref: string }> };

async function find(ref: string) {
  const id = paylinkRefOk(ref);
  if (!id) return null;
  return publicLink(id).then((v) => (v ? { id, ...v } : null));
}

export async function GET(req: Request, ctx: Ctx) {
  const limited = rateLimited(req, 'pay-read', PUBLIC_LIMITS.payRead, MINUTE);
  if (limited) return limited;
  const v = await find((await ctx.params).ref);
  if (!v) return json(404, { code: 'not_found', message: PAGE_ERRORS_HE.not_found });
  if (!(await businessOpen(v.businessId))) return json(403, UNAVAILABLE);
  return json(200, { link: v.link });
}

export async function POST(req: Request, ctx: Ctx) {
  const { ref } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = body?.action === 'start' ? 'start' : body?.action === 'check' ? 'check' : null;
  if (!action) return json(400, { code: 'bad_request', message: 'בקשה לא תקינה.' });
  const limited = rateLimited(req, action === 'start' ? 'pay-start' : 'pay-check', action === 'start' ? PUBLIC_LIMITS.payStart : PUBLIC_LIMITS.payCheck, MINUTE);
  if (limited) return limited;
  const v = await find(ref);
  if (!v) return json(404, { code: 'not_found', message: PAGE_ERRORS_HE.not_found });
  if (!(await businessOpen(v.businessId))) return json(403, UNAVAILABLE);
  if (action === 'check') {
    // the provider is asked about the link's open pages; whatever it answers, the page shows the database's status
    const r = await storefrontPaylink({ action: 'confirm', request: v.id });
    const now = await publicLink(v.id);
    return json(200, { link: (now ?? v).link, asked: r.ok && r.json.unknown !== true });
  }
  if (v.link.status === 'paid') return json(409, { code: 'paid', message: PAGE_ERRORS_HE.paid, link: v.link });
  if (v.link.status !== 'sent' && v.link.status !== 'failed') return json(409, { code: 'closed', message: PAGE_ERRORS_HE.closed, link: v.link });
  // back to the address the link was sent with (the dashboard's, kept by the server when the owner sent it) — never one the request names
  const r = await storefrontPaylink({ action: 'page', request: v.id, returnUrl: `${v.origin || appOrigin(req)}/pay/${ref}` });
  if (r.ok && r.json.ok === true && typeof r.json.url === 'string' && /^https?:\/\//.test(r.json.url)) return json(200, { url: r.json.url });
  const code = typeof r.json.error === 'string' && PAGE_ERRORS_HE[r.json.error] ? r.json.error : r.status >= 500 || r.status === 503 ? 'unavailable' : 'provider';
  const now = code === 'paid' ? await publicLink(v.id) : null;
  return json(code === 'paid' || code === 'closed' ? 409 : 502, { code, message: PAGE_ERRORS_HE[code], ...(now ? { link: now.link } : {}) });
}
