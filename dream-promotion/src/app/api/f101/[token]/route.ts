import { adminDb } from '@/lib/server/admin';
import { businessOpen } from '@/lib/server/business';
import { clientAddress, MINUTE, PUBLIC_LIMITS, rateLimited } from '@/lib/server/rate-limit';
import { pushToUser } from '@/lib/server/push';
import { signedPdfBytes } from '@/lib/server/sign-pdf';
import { checkSignature, hashToken, isToken, sha256 } from '@/lib/server/declarations';
import {
  FORM101_BUCKET, FORM_CODE, buildForm101Pdf, employerOf, linkGone, linkJson, openRequest, pendingFolder, prefillSource,
} from '@/lib/server/form101';
import { ATTACH_LABEL, FORM, cleanForm, prefill, problems, type AttachKind } from '@/features/attendance/form101';

export const runtime = 'nodejs';

/**
 * The employee's link to טופס 101: /f/<token> (docs/FORM101_REQUIREMENTS_HE.md). No sign-in; the token is 64 hex and only its
 * sha-256 is in the database. The page gets only what it shows: the employer's name, the tax year, and the form prefilled from
 * the employee's card and the last form they signed — never an id of the employee or the business.
 *   GET   the form to fill (the link becomes "opened")
 *   POST  the answers, the attachments (uploaded before through ./file) and the signature: checked again here (cleanForm,
 *         problems, a real signature, the confirmation), the PDF drawn with the server's time, IP and browser and signed by the
 *         platform when it has a certificate, kept in the private bucket; the database gives it its version and closes the link
 *         (a second POST is refused); the attendance admins are told. The employee gets the PDF back once, in this answer.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const limited = rateLimited(req, 'form101-read', PUBLIC_LIMITS.form101Read, MINUTE);
  if (limited) return limited;
  if (!isToken(token)) return linkGone('not_found');
  const got = await openRequest(hashToken(token), businessOpen);
  if ('error' in got) return got.error;
  const { r } = got;
  const db = adminDb();
  if (r.status === 'sent') await db.from('form101_requests').update({ status: 'opened' }).eq('id', r.id).eq('status', 'sent');
  const [employer, src] = await Promise.all([employerOf(r.business_id), prefillSource(r.business_id, r.employee_id)]);
  return linkJson(200, {
    employer: employer.name, taxYear: r.tax_year, update: r.kind === 'update', expiresAt: r.expires_at,
    form: { code: FORM.code, updated: FORM.updated, year: FORM.taxYear },
    data: prefill(src.base, src.last, r.tax_year, src.lastYear),
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const limited = rateLimited(req, 'form101-sign', PUBLIC_LIMITS.form101Sign, MINUTE);
  if (limited) return limited;
  if (!isToken(token)) return linkGone('not_found');
  let body: any;
  try { body = await req.json(); } catch { return linkJson(400, { code: 'bad_request', message: 'בקשה לא תקינה.' }); }
  const got = await openRequest(hashToken(token), businessOpen);
  if ('error' in got) return got.error;
  const { r } = got;

  // ---- everything is checked before anything is written ----
  const data = cleanForm(body?.data);
  const missing = problems(data);
  if (missing.length) return linkJson(400, { code: 'missing', step: missing[0].step, field: missing[0].field, message: missing[0].message });
  const signerName = String(body?.signerName ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (signerName.length < 2) return linkJson(400, { code: 'missing', step: 'sign', field: 'signerName', message: 'חסר שם מלא.' });
  if (body?.confirm !== true) return linkJson(400, { code: 'missing', step: 'sign', field: 'confirm', message: 'יש לסמן את ההצהרה לפני החתימה.' });
  const sig = await checkSignature(body?.signature);
  if (!sig.ok) return linkJson(400, { code: 'missing', step: 'sign', field: 'signature', message: sig.message });
  // the attachments: only files uploaded to this link's own folder, each with a kind the form knows
  const folder = pendingFolder(r);
  const db = adminDb();
  const storage = db.storage.from(FORM101_BUCKET);
  const sent: { kind: string; path: string; name: string; sha256: string; type: string; size: number }[] = Array.isArray(body?.attachments) ? body.attachments.slice(0, 20) : [];
  const { data: listed } = await storage.list(folder, { limit: 100 });
  const present = new Set((listed ?? []).map((f) => `${folder}/${f.name}`));
  const attachments = sent.filter((a) => typeof a?.path === 'string' && present.has(a.path) && a.kind in ATTACH_LABEL)
    .map((a) => ({ kind: a.kind as AttachKind, path: a.path, name: String(a.name ?? '').slice(0, 120), sha256: /^[0-9a-f]{64}$/.test(String(a.sha256)) ? a.sha256 : '',
      type: String(a.type ?? '').slice(0, 40), size: Number(a.size) || 0 }));

  const employer = await employerOf(r.business_id);
  const ip = clientAddress(req) === 'unknown' ? '' : clientAddress(req);
  const ua = (req.headers.get('user-agent') ?? '').slice(0, 1000);
  const software = `Dream Promotion ${process.env.NEXT_PUBLIC_APP_VERSION ?? ''}`.trim();
  const id = crypto.randomUUID();
  const signedAt = new Date().toISOString();
  const { data: prev } = await db.from('form101_submissions').select('version').eq('business_id', r.business_id).eq('employee_id', r.employee_id)
    .eq('tax_year', r.tax_year).order('version', { ascending: false }).limit(1).maybeSingle();
  const version = Number((prev as { version?: number } | null)?.version ?? 0) + 1;   // the database sets it again (the same rule)
  const sigPath = `${folder}/${id}-signature.png`, pdfPath = `${folder}/${id}.pdf`;
  const written: string[] = [];
  try {
    const doc = await buildForm101Pdf({
      data, employer, attached: attachments.map((a) => a.kind), taxYear: r.tax_year, version, number: id, requestId: r.id,
      signerName, signaturePng: sig.png, signedAt, ip, userAgent: ua, software,
    });
    const { bytes } = await signedPdfBytes(doc, { name: employer.name || 'Dream Promotion', reason: `טופס 101 לשנת ${r.tax_year}`, contactInfo: '' });
    const s1 = await storage.upload(sigPath, sig.png, { contentType: 'image/png', upsert: false });
    if (s1.error) throw new Error('store');
    written.push(sigPath);
    const s2 = await storage.upload(pdfPath, bytes, { contentType: 'application/pdf', upsert: false });
    if (s2.error) throw new Error('store');
    written.push(pdfPath);
    const { error } = await db.from('form101_submissions').insert({
      id, business_id: r.business_id, employee_id: r.employee_id, request_id: r.id, tax_year: r.tax_year, version, form_code: FORM_CODE,
      data, signer_name: signerName, signature_path: sigPath, pdf_path: pdfPath, pdf_sha256: sha256(bytes), attachments,
      ip: ip || null, user_agent: ua,
    });
    if (error) throw Object.assign(new Error('row'), { db: error });

    // the attendance admins are told (best effort: the form is already kept)
    try {
      const { data: m } = await db.from('business_members').select('user_id, role, attendance_role').eq('business_id', r.business_id);
      const admins = ((m ?? []) as { user_id: string; role: string; attendance_role: string | null }[])
        .filter((x) => x.attendance_role === 'admin' || (!x.attendance_role && (x.role === 'owner' || x.role === 'editor'))).map((x) => x.user_id);
      const who = `${data.employee.firstName} ${data.employee.lastName}`.trim();
      for (const u of admins) await pushToUser(u, { title: 'טופס 101 נחתם', body: `${who} — שנת המס ${r.tax_year}`, url: `/attendance/employees/${r.employee_id}?tab=form101`, tag: `form101-${id}` });
    } catch { /* the form is kept; the push is an extra */ }
    return linkJson(200, { ok: true, version, pdf: Buffer.from(bytes).toString('base64'), file: `טופס-101-${r.tax_year}.pdf` });
  } catch (e: any) {
    if (written.length) await storage.remove(written);
    if (/no longer valid/i.test(String(e?.db?.message ?? '')) || e?.db?.code === '23505') return linkGone('submitted');
    return linkJson(500, { code: 'server_error', message: 'הטופס לא נשמר. נסו שוב בעוד רגע.' });
  }
}
