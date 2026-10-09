import { UNAVAILABLE } from '@/lib/server/business';
import { sharedDocument } from '@/lib/server/doc-share';
import { buildDocPdf } from '@/lib/server/doc-pdf';
import { certificateInfo, signedPdfBytes } from '@/lib/server/sign-pdf';
import { MINUTE, PUBLIC_LIMITS, rateLimited } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The customer's document as a PDF, signed digitally when the certificate is configured: /api/doc/<token>/pdf.
 * Same access as the document link itself — the random 64-hex token, an open business.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const params = await ctx.params;   // Next 15: the route's params arrive as a promise
  const limited = rateLimited(req, 'doc-pdf', PUBLIC_LIMITS.docPdf, MINUTE);
  if (limited) return limited;
  const s = await sharedDocument(params.token);
  if (!s.ok) return Response.json(s.status === 403 ? UNAVAILABLE : { code: 'not_found' }, { status: s.status });
  const doc = s.doc;
  const willSign = certificateInfo().configured;
  const mark = doc.cancelled ? 'מסמך ממוחשב · בוטל' : 'מסמך ממוחשב';
  // the software's registration number is printed only when there is a real one (as on the screen) — never "00000000"
  const reg = process.env.NEXT_PUBLIC_SOFTWARE_REG_NUMBER ?? '';
  const software = `Dream Promotion ${process.env.NEXT_PUBLIC_APP_VERSION ?? ''}`.trim() + (/^\d{8}$/.test(reg) && reg !== '00000000' ? ` · תוכנה רשומה מס׳ ${reg}` : '');
  const pdf = await buildDocPdf(doc, s.business, { mark, software, signed: willSign, allocation: s.allocation });
  const { bytes, signed } = await signedPdfBytes(pdf, { name: 'Dream Promotion', reason: `Document ${doc.docType}-${doc.docNumber} (${doc.issuer?.dealerNumber || s.business.dealerNumber})` });
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="doc-${doc.docType}-${doc.docNumber}.pdf"`,
      'Cache-Control': 'no-store',
      'X-Signed': signed ? '1' : '0',
    },
  });
}
