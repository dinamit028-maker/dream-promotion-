import { UNAVAILABLE } from '@/lib/server/business';
import { adminDb } from '@/lib/server/admin';
import { documentPdf, headRefusal, keepDelivered, later, pdfHeaders, sharedDocument, shareRefusal } from '@/lib/server/doc-share';
import { MINUTE, PUBLIC_LIMITS, rateLimited } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * The customer's document as a PDF, signed digitally when the certificate is configured: /api/doc/<token>/pdf.
 * Same access as the document link itself — the random 64-hex token, an open business.
 * 2.119: a delivery (document_share_open — channel 'pdf', or 'storefront' when the storefront's server asks with ?via=storefront):
 * the mark is the database's ("מקור" the first time, then "העתק נאמן למקור"); a document waiting for its allocation number — 409.
 * The original's bytes, exactly as sent, are kept in delivered-documents after the answer (keepDelivered).
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const params = await ctx.params;   // Next 15: the route's params arrive as a promise
  const limited = rateLimited(req, 'doc-pdf', PUBLIC_LIMITS.docPdf, MINUTE);
  if (limited) return limited;
  const via = new URL(req.url).searchParams.get('via') === 'storefront' ? 'storefront' : 'pdf';
  const s = await sharedDocument(params.token, via);
  if (!s.ok) return Response.json(s.status === 403 ? UNAVAILABLE : shareRefusal(s.code), { status: s.status, headers: { 'Cache-Control': 'no-store' } });
  const { bytes, signed } = await documentPdf(s, s.mark);
  const delivery = s.delivery;
  if (delivery?.original) later(() => keepDelivered(adminDb(), delivery, bytes));
  return new Response(Buffer.from(bytes), { headers: pdfHeaders(s.doc, signed) });
}

/** HEAD records nothing (QA-2119-1 — Next would otherwise answer it from GET, which is a delivery) */
export async function HEAD() { return headRefusal(); }
