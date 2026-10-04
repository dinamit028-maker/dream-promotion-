import { adminDb } from '@/lib/server/admin';
import { UNAVAILABLE, businessOpen } from '@/lib/server/business';
import { toDoc } from '@/features/documents/documents';
import { buildDocPdf } from '@/lib/server/doc-pdf';
import { certificateInfo, signedPdfBytes } from '@/lib/server/sign-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The customer's document as a PDF, signed digitally when the certificate is configured: /api/doc/<token>/pdf.
 * Same access as the document link itself — the random 64-hex token, an open business.
 */
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  if (!/^[a-f0-9]{64}$/.test(params.token)) return Response.json({ code: 'not_found' }, { status: 404 });
  const db = adminDb();
  const { data: d } = await db.from('documents').select('*').eq('share_token', params.token).maybeSingle();
  if (!d) return Response.json({ code: 'not_found' }, { status: 404 });
  if (!(await businessOpen((d as any).business_id))) return Response.json(UNAVAILABLE, { status: 403 });
  const [{ data: s }, { data: b }] = await Promise.all([
    db.from('register_settings').select('dealer_number, legal_name, street, house_no, city, zip').eq('business_id', (d as any).business_id).maybeSingle(),
    db.from('brands').select('name').eq('business_id', (d as any).business_id).maybeSingle(),
  ]);
  const business = { dealerNumber: s?.dealer_number ?? '', name: s?.legal_name || (b as any)?.name || '', street: s?.street ?? '', houseNo: s?.house_no ?? '', city: s?.city ?? '', zip: s?.zip ?? '' };
  const doc = toDoc(d);
  const willSign = certificateInfo().configured;
  const pdf = await buildDocPdf(doc, business, { mark: 'מסמך ממוחשב', software: `Dream Promotion ${process.env.NEXT_PUBLIC_APP_VERSION ?? ''}`.trim(), signed: willSign });
  const { bytes, signed } = await signedPdfBytes(pdf, { name: 'Dream Promotion', reason: `Document ${doc.docType}-${doc.docNumber} (${business.dealerNumber})` });
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="doc-${doc.docType}-${doc.docNumber}.pdf"`,
      'Cache-Control': 'no-store',
      'X-Signed': signed ? '1' : '0',
    },
  });
}
