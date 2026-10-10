import { paylinkNotice } from '@/lib/paylinks';
import { clientIp } from '@/lib/request';

/**
 * The provider's notice about a payment link's page (refURL_callback) — on any host of the storefront: a link belongs to a
 * business, not to a store. It never marks anything paid by itself (paylinkNotice: the signature with the link's own
 * terminal, the notice once, then the provider is asked directly). 200 for anything the provider should not send again.
 */
type Ctx = { params: Promise<{ host: string; provider: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const { provider } = await params;
  const body = await req.text().catch(() => '');
  const status = await paylinkNotice(provider, body, req.headers, clientIp(req)).catch((e) => { console.error('[paylink] notice', e); return 500; });
  return new Response(status === 200 ? 'ok' : 'no', { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
}
