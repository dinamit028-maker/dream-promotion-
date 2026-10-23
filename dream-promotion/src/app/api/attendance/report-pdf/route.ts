import { adminDb } from '@/lib/server/admin';
import { attendanceCaller } from '@/lib/server/attendance';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { buildReportPdf, reportPdfInput } from '@/lib/server/report-pdf';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * An employee's monthly attendance report as a PDF (2.107). The same drawing as the money reports (report-pdf.ts): the screen
 * sends the table it shows (monthPdfBody — the hours engine's rows), the server only draws it; the business's name is read here.
 * Anyone who may read attendance (the rows they could send are the ones they see). Nothing is stored.
 */
const MAX_BYTES = 512 * 1024;

export async function POST(req: Request) {
  const limited = rateLimited(req, 'attendance-report-pdf', 30, MINUTE);
  if (limited) return limited;
  const c = await attendanceCaller(req);
  if (!c.ok) return Response.json(c.body, { status: c.status });
  const raw = await req.text().catch(() => '');
  if (raw.length > MAX_BYTES) return Response.json({ code: 'too_large', message: 'הדוח גדול מדי ל-PDF.' }, { status: 413 });
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* answered below */ }
  const v = reportPdfInput(body);
  if (!v.ok) return Response.json({ code: 'bad_request', message: v.error }, { status: 400 });
  const { data: biz } = await adminDb().from('businesses').select('name').eq('id', c.businessId).maybeSingle();
  const software = `Dream Promotion ${process.env.NEXT_PUBLIC_APP_VERSION ?? ''}`.trim();
  const pdf = await buildReportPdf(v.input, { name: (biz as any)?.name || '', dealerNumber: '' },
    { software, at: new Date().toISOString(), footer: 'דוח נוכחות' });
  const bytes = await pdf.save();
  return new Response(Buffer.from(bytes), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="attendance.pdf"; filename*=UTF-8''${encodeURIComponent(`${v.input.title}.pdf`)}`,
      'Cache-Control': 'no-store' },
  });
}
