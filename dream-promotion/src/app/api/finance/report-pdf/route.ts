import { adminDb } from '@/lib/server/admin';
import { financeCaller } from '@/lib/server/finance';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { buildReportPdf, reportPdfInput } from '@/lib/server/report-pdf';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * A report of the money screens as a PDF (2.94 — T8). The same gates as every money route (financeCaller: the business worked in
 * now, its money open to the caller, never a cashier; a viewer may read). The screen sends the table it shows; the server only
 * draws it — the business's name and number are read here, never taken from the request. Nothing is stored.
 */
const MAX_BYTES = 2 * 1024 * 1024;

export async function POST(req: Request) {
  const limited = rateLimited(req, 'finance-report-pdf', 30, MINUTE);
  if (limited) return limited;
  const c = await financeCaller(req);
  if (!c.ok) return Response.json(c.body, { status: c.status });
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES) {
    return Response.json({ code: 'too_large', message: 'הדוח גדול מדי ל-PDF — אפשר להוריד CSV.' }, { status: 413 });
  }
  const raw = await req.text().catch(() => '');
  if (raw.length > MAX_BYTES) return Response.json({ code: 'too_large', message: 'הדוח גדול מדי ל-PDF — אפשר להוריד CSV.' }, { status: 413 });
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* answered below */ }
  const v = reportPdfInput(body);
  if (!v.ok) return Response.json({ code: 'bad_request', message: v.error }, { status: 400 });
  const db = adminDb();
  const [{ data: rs }, { data: biz }] = await Promise.all([
    db.from('register_settings').select('legal_name, dealer_number').eq('business_id', c.businessId).maybeSingle(),
    db.from('businesses').select('name').eq('id', c.businessId).maybeSingle(),
  ]);
  const software = `Dream Promotion ${process.env.NEXT_PUBLIC_APP_VERSION ?? ''}`.trim();
  const pdf = await buildReportPdf(v.input, { name: (rs as any)?.legal_name || (biz as any)?.name || '', dealerNumber: (rs as any)?.dealer_number || '' },
    { software, at: new Date().toISOString() });
  const bytes = await pdf.save();
  return new Response(Buffer.from(bytes), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(`${v.input.title}.pdf`)}`,
      'Cache-Control': 'no-store' },
  });
}
