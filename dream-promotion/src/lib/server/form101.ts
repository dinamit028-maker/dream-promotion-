import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { adminDb } from './admin';
import { businessName } from './client-file';
import { fontBytes, forceLtr, ilDateTime, visual } from './doc-pdf';
import { DECLARATION, FORM, cleanForm, pdfSections, type AttachKind, type Employer, type Form101Data } from '@/features/attendance/form101';

/**
 * טופס 101 on the server (docs/FORM101_REQUIREMENTS_HE.md): the employer's part (חלק א), what the employee's link prefills,
 * the files' bucket, and the signed form as a PDF — the official form's sections in order (pdfSections), the declaration word for
 * word, the employee's signature, the server's time, IP and browser. The link's token and the finger signature are the ones of the
 * health declarations (declarations.ts: newToken / hashToken / checkSignature).
 */
export const FORM101_BUCKET = 'form101-files';
export const FORM_CODE = `${FORM.code} · ${FORM.updated}`;
export const ATTACH_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };
export const MAX_FILE_BYTES = 4 * 1024 * 1024;   // a phone photo resized in the browser; a PDF as it is (under Vercel's body limit)

/** חלק א: the business's legal name and address (the business details), the deductions file and phone (attendance settings) */
export async function employerOf(businessId: string): Promise<Employer> {
  const db = adminDb();
  const [{ data: r }, { data: t }, name] = await Promise.all([
    db.from('register_settings').select('legal_name, street, house_no, city').eq('business_id', businessId).limit(1).maybeSingle(),
    db.from('timeclock_settings').select('employer_deductions_file, employer_phone').eq('business_id', businessId).limit(1).maybeSingle(),
    businessName(businessId),
  ]);
  const rs = (r ?? {}) as { legal_name?: string; street?: string; house_no?: string; city?: string };
  const ts = (t ?? {}) as { employer_deductions_file?: string; employer_phone?: string };
  return {
    name: String(rs.legal_name ?? '').trim() || name,
    address: [[rs.street, rs.house_no].filter(Boolean).join(' '), rs.city].filter(Boolean).join(', '),
    phone: String(ts.employer_phone ?? ''), deductionsFile: String(ts.employer_deductions_file ?? ''),
  };
}

/** what a new form starts from: the employee's card, the ID (private), and the last form the employee signed */
export async function prefillSource(businessId: string, employeeId: string) {
  const db = adminDb();
  const [{ data: e }, { data: p }, { data: last }] = await Promise.all([
    db.from('employees').select('name, phone, start_date').eq('id', employeeId).eq('business_id', businessId).maybeSingle(),
    db.from('employee_private').select('id_number').eq('employee_id', employeeId).eq('business_id', businessId).maybeSingle(),
    db.from('form101_submissions').select('data, tax_year').eq('employee_id', employeeId).eq('business_id', businessId)
      .order('submitted_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const emp = (e ?? {}) as { name?: string; phone?: string; start_date?: string | null };
  return {
    base: { name: emp.name ?? '', phone: emp.phone ?? '', idNumber: String((p as { id_number?: string } | null)?.id_number ?? ''), startDate: emp.start_date ?? null },
    last: last ? cleanForm((last as { data: unknown }).data) : null,
    lastYear: last ? Number((last as { tax_year: number }).tax_year) : null,
  };
}

export interface Form101PdfInput {
  data: Form101Data; employer: Employer; attached: AttachKind[]; taxYear: number; version: number; number: string; requestId: string;
  signerName: string; signaturePng: Uint8Array; signedAt: string; ip: string; userAgent: string; software: string;
}

/** the signed form as a PDF (A4, Hebrew, right to left) */
export async function buildForm101Pdf(d: Form101PdfInput): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fb = fontBytes();
  const font = await pdf.embedFont(fb.regular, { subset: true });
  const bold = await pdf.embedFont(fb.bold, { subset: true });
  forceLtr(font); forceLtr(bold);
  const who = `${d.data.employee.firstName} ${d.data.employee.lastName}`.trim();
  pdf.setTitle(`טופס 101 — ${who} — ${d.taxYear}`);
  pdf.setAuthor(d.employer.name); pdf.setCreator(d.software); pdf.setProducer(d.software); pdf.setLanguage('he-IL');
  pdf.setCreationDate(new Date(d.signedAt)); pdf.setModificationDate(new Date(d.signedAt));

  const W = 595.28, H = 841.89, M = 36, maxW = W - 2 * M;
  const ink = rgb(0.07, 0.07, 0.07), muted = rgb(0.4, 0.4, 0.4), line = rgb(0.8, 0.8, 0.8), band = rgb(0.93, 0.94, 0.96);
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;
  const known = new Set(font.getCharacterSet());
  const clean = (t: string) => Array.from(String(t ?? '')).filter((c) => known.has(c.codePointAt(0)!) || c === ' ').join('');
  const width = (t: string, size: number, f: PDFFont) => f.widthOfTextAtSize(visual(clean(t)), size);
  const room = (need: number) => { if (y - need < M + 24) { page = pdf.addPage([W, H]); y = H - M; } };
  /** right-aligned text in a column [right edge, width], wrapped by words; returns the lines drawn */
  const wrap = (t: string, size: number, f: PDFFont, w: number) => {
    const out: string[] = [];
    for (const raw of String(t).split('\n')) {
      const words = raw.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      let cur = '';
      for (const x of words) { const next = cur ? `${cur} ${x}` : x; if (cur && width(next, size, f) > w) { out.push(cur); cur = x; } else cur = next; }
      if (cur) out.push(cur);
    }
    return out;
  };
  const draw = (t: string, size: number, f: PDFFont, right: number, yy: number, color = ink) => {
    const v = visual(clean(t)); page.drawText(v, { x: right - f.widthOfTextAtSize(v, size), y: yy, size, font: f, color });
  };
  const para = (t: string, size: number, f: PDFFont, color = ink, gap = 3) => {
    const lh = size * 1.4;
    for (const l of wrap(t, size, f, maxW)) { room(lh); draw(l, size, f, W - M, y, color); y -= lh; }
    y -= gap;
  };

  // the heading: the form's own
  para(FORM.title, 15, bold, ink, 1);
  para(`טופס ${FORM.code} (מעודכן ל-${FORM.updated}) · לפי תקנות מס הכנסה (ניכוי ממשכורת ומשכר עבודה), התשנ"ג-1993`, 8.5, font, muted, 1);
  para(`שנת המס ${d.taxYear} · גרסה ${d.version} · ${who}`, 11, bold, ink, 8);

  const LABEL_W = 170, size = 9, lh = size * 1.4;
  for (const s of pdfSections(d.data, d.employer, d.attached)) {
    room(30);
    page.drawRectangle({ x: M, y: y - 4, width: maxW, height: 16, color: band });
    draw(s.title, 10.5, bold, W - M - 6, y);
    y -= 20;
    for (const [label, value] of s.rows) {
      const valueW = label ? maxW - LABEL_W - 12 : maxW - 12;
      const lines = wrap(value || '—', size, font, valueW);
      const labelLines = label ? wrap(label, size, bold, LABEL_W) : [];
      const rows = Math.max(lines.length, labelLines.length, 1);
      room(rows * lh + 4);
      labelLines.forEach((l, i) => draw(l, size, bold, W - M - 6, y - i * lh));
      lines.forEach((l, i) => draw(l, size, font, label ? W - M - 6 - LABEL_W - 12 : W - M - 6, y - i * lh, value ? ink : muted));
      y -= rows * lh + 2;
      page.drawLine({ start: { x: M, y: y + lh - 4 }, end: { x: W - M, y: y + lh - 4 }, thickness: 0.3, color: line });
    }
    for (const n of s.notes ?? []) para(n, 8, font, muted, 1);
    y -= 6;
  }

  // י. הצהרה — the form's words, the name, the signature, when / where from
  room(170);
  page.drawRectangle({ x: M, y: y - 4, width: maxW, height: 16, color: band });
  draw('י. הצהרה', 10.5, bold, W - M - 6, y);
  y -= 22;
  para(DECLARATION, 9.5, font, ink, 6);
  para(`שם המבקש/ת: ${d.signerName}`, 10, bold, ink, 3);
  const img = await pdf.embedPng(d.signaturePng);
  const k = Math.min(220 / img.width, 80 / img.height, 1);
  room(img.height * k + 10);
  page.drawImage(img, { x: W - M - img.width * k, y: y - img.height * k, width: img.width * k, height: img.height * k });
  y -= img.height * k + 10;
  para(`נחתם במסך: ${ilDateTime(d.signedAt)} (שעון השרת, ישראל)`, 8.5, font, muted, 1);
  para(`כתובת IP: ${d.ip || 'לא ידועה'}`, 8.5, font, muted, 1);
  para(`דפדפן: ${d.userAgent.slice(0, 300) || 'לא ידוע'}`, 7.5, font, muted, 1);
  para(`מס׳ טופס במערכת: ${d.number} · קישור: ${d.requestId}`, 7.5, font, muted, 1);

  const foot = `טופס 101 שמולא במערכת ונחתם במסך — לבדיקת רואה החשבון והמעסיק · ${d.software}`;
  for (const [i, p] of pdf.getPages().entries()) {
    const v = visual(clean(foot));
    p.drawText(v, { x: W - M - font.widthOfTextAtSize(v, 7), y: M - 16, size: 7, font, color: muted });
    p.drawText(`${i + 1}/${pdf.getPageCount()}`, { x: M, y: M - 16, size: 7, font, color: muted });
  }
  return pdf;
}

/** is migration 5900 in the database? (a select of no rows) */
export async function form101Ready(): Promise<boolean> {
  const { error } = await adminDb().from('form101_requests').select('id').limit(0);
  return !error;
}

// ---- the employee's link (/f/<token>) ----------------------------------------------------------------------------------------
export interface RequestRow { id: string; business_id: string; employee_id: string; tax_year: number; kind: 'year' | 'update'; status: string; expires_at: string; sent_by: string | null }
const noStore = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
export const linkJson = (status: number, body: unknown) => Response.json(body, { status, headers: noStore });
export const linkGone = (code: 'not_found' | 'expired' | 'submitted' | 'cancelled') => linkJson(code === 'not_found' ? 404 : 410, {
  code,
  message: code === 'expired' ? 'הקישור פג. בקשו מהמעסיק קישור חדש.'
    : code === 'submitted' ? 'הטופס כבר מולא ונחתם. תודה!'
      : code === 'cancelled' ? 'הקישור בוטל. בקשו מהמעסיק קישור חדש.' : 'הקישור לא נמצא.',
});

/** the link of a token: open (sent / opened, not expired), of an open business — else the answer to give */
export async function openRequest(tokenHash: string, businessOpen: (id: string) => Promise<boolean>): Promise<{ error: Response } | { r: RequestRow }> {
  const db = adminDb();
  const { data } = await db.from('form101_requests').select('id, business_id, employee_id, tax_year, kind, status, expires_at, sent_by').eq('token_hash', tokenHash).maybeSingle();
  const r = data as RequestRow | null;
  if (!r) return { error: linkGone('not_found') };
  if (!(await businessOpen(r.business_id))) return { error: linkJson(403, { code: 'unavailable', message: 'השירות אינו זמין' }) };
  if (r.status === 'submitted') return { error: linkGone('submitted') };
  if (r.status === 'cancelled') return { error: linkGone('cancelled') };
  if (r.status === 'expired' || !(Date.parse(r.expires_at) > Date.now())) {
    if (r.status !== 'expired') await db.from('form101_requests').update({ status: 'expired' }).eq('id', r.id).in('status', ['sent', 'opened']);
    return { error: linkGone('expired') };
  }
  return { r };
}
/** where a link's files go before the form is signed: the business's folder, the employee's, the link's */
export const pendingFolder = (r: Pick<RequestRow, 'business_id' | 'employee_id' | 'id'>) => `${r.business_id}/${r.employee_id}/${r.id}`;
