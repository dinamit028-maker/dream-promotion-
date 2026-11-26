import { adminDb, userFromRequest } from '@/lib/server/admin';
import { LOCKED, canUseBusiness } from '@/lib/server/business';
import { appDelivery, documentPdf, keepDelivered, keptOriginal, pdfHeaders, presentDocument } from '@/lib/server/doc-share';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * 2.119 — the PDF of a delivery the business made from the app (the accountant's answers 6 and 6 נוסף): the screen first records it
 * itself (document_delivery_record — the database checks who may deliver the document, refuses one waiting for its allocation
 * number, and says whether it is the original), then asks here, with the delivery's id, for:
 *   want 'pdf'  — the PDF with the delivery's mark ("מקור" / "העתק נאמן למקור"), when it is handed over as a file;
 *   want 'keep' — nothing back: the original's PDF is only kept (a print, a message), as the customer's link keeps it.
 * Only a delivery recorded by the signed-in person, in the last 15 minutes, of a business they may still use. The original's PDF is
 * kept in delivered-documents exactly as sent (keepDelivered). Nothing here records a delivery — this never consumes the original.
 */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return Response.json({ code: 'unauthorized', message: 'צריך להתחבר.' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const want = body?.want === 'keep' ? 'keep' : 'pdf';
  const db = adminDb();
  const v = await appDelivery(db, userId, body?.deliveryId);
  if (!v.ok) return Response.json({ code: v.code, message: v.message }, { status: v.status });
  if (!(await canUseBusiness(userId, v.delivery.businessId))) return Response.json(LOCKED, { status: 403 });
  const { data: d } = await db.from('documents').select('*').eq('id', v.delivery.documentId).maybeSingle();
  if (!d) return Response.json({ code: 'not_found', message: 'המסמך לא נמצא.' }, { status: 404 });
  const s = await presentDocument(db, d as Record<string, unknown>);
  // the original asked again (a retry, a second tap within the window): the very file that was kept — never a new rendering
  const again = await keptOriginal(db, v.delivery);
  if (again) {
    if (want === 'keep') return Response.json({ ok: true, kept: true }, { headers: { 'Cache-Control': 'no-store' } });
    return new Response(Buffer.from(again), { headers: { ...pdfHeaders(s.doc, false), 'X-Signed': 'kept', 'X-Kept': '1' } });
  }
  const { bytes, signed } = await documentPdf(s, v.delivery.mark);
  // kept before the answer: the person waits for the file anyway, and the original is kept once (a retry finds it there)
  const kept = v.delivery.original ? (await keepDelivered(db, v.delivery, bytes)).kept : false;
  if (want === 'keep') return Response.json({ ok: true, kept }, { headers: { 'Cache-Control': 'no-store' } });
  return new Response(Buffer.from(bytes), { headers: { ...pdfHeaders(s.doc, signed), 'X-Kept': kept ? '1' : '0' } });
}
