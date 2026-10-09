import { NextResponse } from 'next/server';
import { UNAVAILABLE } from '@/lib/server/business';
import { publicDoc, sharedDocument } from '@/lib/server/doc-share';
import { MINUTE, PUBLIC_LIMITS, rateLimited } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';
/** A customer's link to their document: /d/<token>. The token is random (64 hex), set when the document was issued. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const params = await ctx.params;   // Next 15: the route's params arrive as a promise
  const limited = rateLimited(req, 'doc-read', PUBLIC_LIMITS.docRead, MINUTE);
  if (limited) return limited;
  const s = await sharedDocument(params.token);
  if (!s.ok) return NextResponse.json(s.status === 403 ? UNAVAILABLE : { code: 'not_found' }, { status: s.status });
  return NextResponse.json({ doc: publicDoc(s.row), business: s.business, allocation: s.allocation, cancelled: s.doc.cancelled }, { headers: { 'Cache-Control': 'no-store' } });
}
