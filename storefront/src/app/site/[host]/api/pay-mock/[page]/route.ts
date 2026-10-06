import { mockAllowed, mockDecide } from '@/lib/pay/mock';

/** the pretend page's buttons: the decision, the provider's notice, and back to the store — local tests only */
type Ctx = { params: Promise<{ host: string; page: string }> };

export async function POST(req: Request, { params }: Ctx) {
  if (!mockAllowed()) return new Response('Not found', { status: 404 });
  const approve = new URL(req.url).searchParams.get('a') === 'approve';
  const p = await mockDecide((await params).page, approve);
  if (!p) return new Response('Not found', { status: 404 });
  return new Response(null, { status: 303, headers: { Location: approve ? p.req.successUrl : p.req.failureUrl } });
}
