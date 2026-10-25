import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { attendanceCaller } from '@/lib/server/attendance';
import { newToken } from '@/lib/server/declarations';
import { ATTACH_TYPES, FORM101_BUCKET, MAX_FILE_BYTES, employerOf, form101Ready } from '@/lib/server/form101';
import { LINK_DAYS, cleanForm, missingAttachments, taxYearOf, warnings, type AttachKind } from '@/features/attendance/form101';
import { israelParts } from '@/lib/il-time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * טופס 101 of the employees, for the employer (docs/FORM101_REQUIREMENTS_HE.md). Read: the attendance admin and payroll (the
 * accountant) — never an approver or a viewer. Write: the admin (send, cancel, the hand-signed paper); the review — admin or payroll.
 *   GET  ?employeeId=…     the employee's links and signed forms (every year, every version), what is missing, the form's warnings
 *   GET  ?year=YYYY        every employee's state for the tax year (the yearly renewal)
 *   GET  ?file=<id>&part=pdf|paper|attachment&n=…   a short-lived link to the file (the bucket has no browser policy)
 *   POST {action:'send', employeeId, kind:'year'|'update', year?}   a new link (30 days) — the token once, in this answer
 *   POST {action:'cancel', requestId}
 *   POST {action:'review', submissionId, note}
 *   POST multipart {action:'paper', submissionId, file}             a scan of the form signed by hand
 *   POST {action:'employer', deductionsFile, phone}                  חלק א of the form (the employer's)
 */
const bad = (status: number, code: string, message: string) => NextResponse.json({ code, message }, { status });
const readsForms = (role: string) => role === 'admin' || role === 'payroll';
const thisYear = () => taxYearOf(israelParts(Date.now()).date);

export async function GET(req: Request) {
  const c = await attendanceCaller(req, 'read');
  if (!c.ok) return NextResponse.json(c.body, { status: c.status });
  if (!readsForms(c.role)) return bad(403, 'forbidden', 'טופס 101 — רק למנהל הנוכחות ולרואה החשבון.');
  if (!(await form101Ready())) return bad(503, 'not_ready', 'צריך להריץ את מיגרציה 20261025005900 (טופס 101).');
  const db = adminDb();
  const url = new URL(req.url);

  const fileId = url.searchParams.get('file');
  if (fileId) {
    const { data: s } = await db.from('form101_submissions').select('pdf_path, paper_path, attachments').eq('id', fileId).eq('business_id', c.businessId).maybeSingle();
    if (!s) return bad(404, 'not_found', 'הטופס לא נמצא.');
    const part = url.searchParams.get('part');
    const row = s as { pdf_path: string; paper_path: string | null; attachments: { path: string }[] };
    const path = part === 'paper' ? row.paper_path : part === 'attachment' ? row.attachments[Number(url.searchParams.get('n'))]?.path : row.pdf_path;
    if (!path || !path.startsWith(`${c.businessId}/`)) return bad(404, 'not_found', 'הקובץ לא נמצא.');
    const { data: signed, error } = await db.storage.from(FORM101_BUCKET).createSignedUrl(path, 60);
    if (error || !signed) return bad(500, 'server_error', 'לא הצלחנו לפתוח את הקובץ.');
    return NextResponse.json({ url: signed.signedUrl }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const year = Number(url.searchParams.get('year'));
  if (year) {
    const [{ data: subs }, { data: reqs }] = await Promise.all([
      db.from('form101_submissions').select('employee_id, version, submitted_at, reviewed_at').eq('business_id', c.businessId).eq('tax_year', year),
      db.from('form101_requests').select('employee_id, status, created_at').eq('business_id', c.businessId).eq('tax_year', year).in('status', ['sent', 'opened']),
    ]);
    return NextResponse.json({ year, submitted: subs ?? [], open: reqs ?? [] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const employeeId = url.searchParams.get('employeeId');
  if (!employeeId) return bad(400, 'bad_request', 'חסר עובד.');
  const [{ data: reqs }, { data: subs }, employer] = await Promise.all([
    db.from('form101_requests').select('id, tax_year, kind, status, expires_at, created_at, opened_at, done_at, sent_by').eq('business_id', c.businessId).eq('employee_id', employeeId).order('created_at', { ascending: false }),
    db.from('form101_submissions').select('id, request_id, tax_year, version, form_code, data, signer_name, attachments, submitted_at, paper_at, paper_path, reviewed_at, reviewed_by, review_note, pdf_sha256')
      .eq('business_id', c.businessId).eq('employee_id', employeeId).order('tax_year', { ascending: false }).order('version', { ascending: false }),
    employerOf(c.businessId),
  ]);
  // the names of who sent / reviewed — only those people
  const people = [...new Set([...((reqs ?? []) as any[]).map((r) => r.sent_by), ...((subs ?? []) as any[]).map((s) => s.reviewed_by)].filter(Boolean))];
  const { data: who } = people.length ? await db.from('profiles').select('id, full_name').in('id', people) : { data: [] };
  const names = new Map(((who ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name]));
  const forms = ((subs ?? []) as any[]).map((s) => {
    const data = cleanForm(s.data);
    const attached = (s.attachments ?? []).map((a: { kind: AttachKind }) => a.kind) as AttachKind[];
    return {
      id: s.id, requestId: s.request_id, taxYear: s.tax_year, version: s.version, formCode: s.form_code, signerName: s.signer_name,
      submittedAt: s.submitted_at, paperAt: s.paper_at, hasPaper: Boolean(s.paper_path), reviewedAt: s.reviewed_at,
      reviewedBy: s.reviewed_by ? names.get(s.reviewed_by) ?? '' : '', reviewNote: s.review_note, sha256: s.pdf_sha256,
      attachments: (s.attachments ?? []).map((a: any) => ({ kind: a.kind, name: a.name, type: a.type, size: a.size })),
      missing: missingAttachments(data, attached), warnings: warnings(data), changeNote: data.changeNote,
      summary: { city: data.employee.city, marital: data.employee.marital, children: data.children.length },
    };
  });
  const links = ((reqs ?? []) as any[]).map((r) => ({ id: r.id, taxYear: r.tax_year, kind: r.kind, status: r.status, expiresAt: r.expires_at,
    createdAt: r.created_at, openedAt: r.opened_at, doneAt: r.done_at, sentBy: r.sent_by ? names.get(r.sent_by) ?? '' : '' }));
  return NextResponse.json({ forms, links, employerReady: Boolean(employer.deductionsFile), thisYear: thisYear() }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  const c = await attendanceCaller(req, 'read');
  if (!c.ok) return NextResponse.json(c.body, { status: c.status });
  if (!readsForms(c.role)) return bad(403, 'forbidden', 'טופס 101 — רק למנהל הנוכחות ולרואה החשבון.');
  if (!(await form101Ready())) return bad(503, 'not_ready', 'צריך להריץ את מיגרציה 20261025005900 (טופס 101).');
  const db = adminDb();
  const multipart = (req.headers.get('content-type') ?? '').startsWith('multipart/form-data');
  let body: any, form: FormData | null = null;
  try { if (multipart) { form = await req.formData(); body = Object.fromEntries(form.entries()); } else body = await req.json(); }
  catch { return bad(400, 'bad_request', 'בקשה לא תקינה.'); }
  const admin = c.role === 'admin';
  const noAdmin = () => bad(403, 'forbidden', 'רק מנהל הנוכחות.');

  if (body?.action === 'send') {
    if (!admin) return noAdmin();
    const { data: emp } = await db.from('employees').select('id, active').eq('id', String(body.employeeId ?? '')).eq('business_id', c.businessId).maybeSingle();
    if (!emp) return bad(404, 'not_found', 'העובד/ת לא נמצא/ה.');
    if ((emp as { active: boolean }).active === false) return bad(409, 'inactive', 'העובד/ת בארכיון.');
    const year = Number(body.year) || thisYear();
    if (year < 2020 || year > thisYear() + 1) return bad(400, 'bad_year', 'שנת מס לא תקינה.');
    const kind = body.kind === 'update' ? 'update' : 'year';
    // one open link per employee and year: a new one cancels the one before it
    await db.from('form101_requests').update({ status: 'cancelled' }).eq('business_id', c.businessId).eq('employee_id', (emp as { id: string }).id)
      .eq('tax_year', year).in('status', ['sent', 'opened']);
    const { token, hash } = newToken();
    const { data: row, error } = await db.from('form101_requests').insert({
      business_id: c.businessId, employee_id: (emp as { id: string }).id, tax_year: year, kind, token_hash: hash,
      expires_at: new Date(Date.now() + LINK_DAYS * 864e5).toISOString(), sent_by: c.userId,
    }).select('id').single();
    if (error || !row) return bad(500, 'server_error', 'הקישור לא נוצר. נסו שוב.');
    return NextResponse.json({ ok: true, requestId: (row as { id: string }).id, path: `/f/${token}`, year, kind });
  }
  if (body?.action === 'cancel') {
    if (!admin) return noAdmin();
    const { data, error } = await db.from('form101_requests').update({ status: 'cancelled' }).eq('id', String(body.requestId ?? '')).eq('business_id', c.businessId)
      .in('status', ['sent', 'opened']).select('id');
    if (error) return bad(500, 'server_error', 'לא בוטל. נסו שוב.');
    if (!data?.length) return bad(409, 'closed', 'הקישור כבר סגור.');
    return NextResponse.json({ ok: true });
  }
  if (body?.action === 'review') {
    const note = String(body.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const { data, error } = await db.from('form101_submissions').update({ reviewed_at: new Date().toISOString(), reviewed_by: c.userId, review_note: note })
      .eq('id', String(body.submissionId ?? '')).eq('business_id', c.businessId).is('reviewed_at', null).select('id');
    if (error) return bad(500, 'server_error', 'לא נשמר. נסו שוב.');
    if (!data?.length) return bad(409, 'done', 'הטופס כבר סומן כנבדק.');
    return NextResponse.json({ ok: true });
  }
  if (body?.action === 'paper') {
    if (!admin) return noAdmin();
    const file = form?.get('file');
    if (!(file instanceof File)) return bad(400, 'bad_request', 'חסר קובץ.');
    if (file.size > MAX_FILE_BYTES) return bad(413, 'too_big', 'הקובץ גדול מדי (עד 4MB).');
    const type = ATTACH_TYPES[file.type] ? file.type : '';
    if (!type) return bad(415, 'bad_type', 'אפשר לצרף רק תמונה או PDF.');
    const { data: s } = await db.from('form101_submissions').select('id, employee_id, paper_path').eq('id', String(body.submissionId ?? '')).eq('business_id', c.businessId).maybeSingle();
    if (!s) return bad(404, 'not_found', 'הטופס לא נמצא.');
    if ((s as { paper_path: string | null }).paper_path) return bad(409, 'done', 'הטופס החתום ביד כבר צורף.');
    const path = `${c.businessId}/${(s as { employee_id: string }).employee_id}/paper-${(s as { id: string }).id}.${ATTACH_TYPES[type]}`;
    const up = await db.storage.from(FORM101_BUCKET).upload(path, Buffer.from(await file.arrayBuffer()), { contentType: type, upsert: false });
    if (up.error) return bad(500, 'server_error', 'הקובץ לא נשמר. נסו שוב.');
    const { error } = await db.from('form101_submissions').update({ paper_path: path, paper_by: c.userId }).eq('id', (s as { id: string }).id).is('paper_path', null);
    if (error) return bad(500, 'server_error', 'לא נשמר. נסו שוב.');
    return NextResponse.json({ ok: true });
  }
  if (body?.action === 'employer') {
    if (!admin) return noAdmin();
    const file = String(body.deductionsFile ?? '').replace(/\D/g, '');
    if (file && !/^9\d{8}$/.test(file)) return bad(400, 'bad_file', 'מספר תיק ניכויים: 9 ספרות, מתחיל ב-9.');
    const phone = String(body.phone ?? '').trim().slice(0, 20);
    // one row per business (as setExportsPdfOnly); a new row is the caller's
    const { data: row } = await db.from('timeclock_settings').select('business_id').eq('business_id', c.businessId).limit(1).maybeSingle();
    const { error } = row
      ? await db.from('timeclock_settings').update({ employer_deductions_file: file, employer_phone: phone }).eq('business_id', c.businessId)
      : await db.from('timeclock_settings').upsert({ user_id: c.userId, business_id: c.businessId, employer_deductions_file: file, employer_phone: phone }, { onConflict: 'business_id' });
    if (error) return bad(500, 'server_error', 'לא נשמר. נסו שוב.');
    return NextResponse.json({ ok: true, employer: await employerOf(c.businessId) });
  }
  return bad(400, 'bad_request', 'פעולה לא מוכרת.');
}
