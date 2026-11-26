import { NextResponse } from 'next/server';
import { UNAVAILABLE } from '@/lib/server/business';
import { adminDb } from '@/lib/server/admin';
import { documentPdf, headRefusal, keepDelivered, later, publicDoc, sharedDocument, shareRefusal } from '@/lib/server/doc-share';
import { MINUTE, PUBLIC_LIMITS, rateLimited } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 30;
/**
 * A customer's link to their document: /d/<token>. The token is random (64 hex), set when the document was issued.
 * 2.119: every open is a delivery (document_share_open, channel 'link') — the first "מקור", later "העתק נאמן למקור" (the page prints
 * the mark it gets here); a document waiting for its allocation number answers 409 and nothing of it. The original's PDF — the same
 * document with the same mark — is kept after the answer went out (keepDelivered; a failure is logged, never the customer's problem).
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const params = await ctx.params;   // Next 15: the route's params arrive as a promise
  const limited = rateLimited(req, 'doc-read', PUBLIC_LIMITS.docRead, MINUTE);
  if (limited) return limited;
  const s = await sharedDocument(params.token, 'link');
  if (!s.ok) return NextResponse.json(s.status === 403 ? UNAVAILABLE : shareRefusal(s.code), { status: s.status, headers: { 'Cache-Control': 'no-store' } });
  const delivery = s.delivery;
  if (delivery?.original) later(async () => { const pdf = await documentPdf(s, s.mark); await keepDelivered(adminDb(), delivery, pdf.bytes); });
  return NextResponse.json({ doc: publicDoc(s.row), business: s.business, allocation: s.allocation, cancelled: s.doc.cancelled, mark: s.mark },
    { headers: { 'Cache-Control': 'no-store' } });
}

/** HEAD records nothing (QA-2119-1 — Next would otherwise answer it from GET, which is a delivery) */
export async function HEAD() { return headRefusal(); }
