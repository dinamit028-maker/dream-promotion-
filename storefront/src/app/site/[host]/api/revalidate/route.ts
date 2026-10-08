import { revalidateTag } from 'next/cache';
import { verifyRevalidateToken } from '@/lib/preview';
import { storeTag } from '@/lib/shared-cache';

/**
 * 2.74: the dashboard, after a change the shoppers see (a published theme, a page, a menu, a collection, the store's
 * details or its access): what the storefront keeps of that store (shared-cache.ts) is dropped, and the next visit reads the
 * database. Signed for one store (makeRevalidateToken, STOREFRONT_PREVIEW_SECRET); on any host of the storefront.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const store = verifyRevalidateToken(typeof body?.token === 'string' ? body.token : null, process.env.STOREFRONT_PREVIEW_SECRET);
  if (!store) return new Response('no', { status: 401 });
  revalidateTag(storeTag(store), { expire: 0 });
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
