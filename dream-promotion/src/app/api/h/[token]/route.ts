import { adminDb } from '@/lib/server/admin';
import { businessOpen, UNAVAILABLE } from '@/lib/server/business';
import { clientAddress, MINUTE, PUBLIC_LIMITS, rateLimited } from '@/lib/server/rate-limit';
import { pushToUser } from '@/lib/server/push';
import { signedPdfBytes } from '@/lib/server/sign-pdf';
import { businessName } from '@/lib/server/client-file';
import { buildDeclarationPdf, checkSignature, hashToken, isToken, sha256 } from '@/lib/server/declarations';
import { checkAnswers, firstName, type Field } from '@/features/client-file/declarations';
import { CLIENT_BUCKET } from '@/features/client-file/photos';

export const runtime = 'nodejs';

/**
 * The customer's link to a health declaration: /h/<token> (docs/CLIENT FILE ENGINEERING HE.md §5.3). No sign-in; the
 * token is 64 hex and only its sha-256 is in the database. The page gets only what it shows: the business's name, the
 * customer's FIRST name, and the templates' titles, fields and confirmations — never ids of the customer or the business.
 *   GET   the declarations to fill (the link is marked "opened")
 *   POST  the answers and signatures: checked again here (answers, a real signature, the confirmation), each declaration
 *         drawn as a PDF with the server's time, IP and user agent, signed by the platform (signedPdfBytes), its sha-256
 *         kept; files in client-files; the link becomes "signed" — a second POST on it is refused; a line on the customer's
 *         timeline; the owners are told. The customer gets the PDFs back once, in this answer.
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
const gone = (code: 'not_found' | 'expired' | 'signed' | 'cancelled') => json(code === 'not_found' ? 404 : 410, {
  code,
  message: code === 'expired' ? 'הקישור פג. בקשו מהקליניקה לשלוח קישור חדש.'
    : code === 'signed' ? 'ההצהרה כבר נחתמה. תודה!'
      : code === 'cancelled' ? 'הקישור בוטל. בקשו מהקליניקה לשלוח קישור חדש.' : 'הקישור לא נמצא.',
});

interface RequestRow { id: string; business_id: string; lead_id: string; template_ids: string[]; template_versions: number[]; status: string; expires_at: string; sent_by: string | null }
interface TemplateRow { id: string; title: string; version: number; fields: Field[]; acks: string[] }

async function load(token: string): Promise<{ error: Response } | { r: RequestRow; templates: TemplateRow[] }> {
  const db = adminDb();
  const { data } = await db.from('declaration_requests').select('id, business_id, lead_id, template_ids, template_versions, status, expires_at, sent_by')
    .eq('token_hash', hashToken(token)).maybeSingle();
  const r = data as RequestRow | null;
  if (!r) return { error: gone('not_found') };
  if (!(await businessOpen(r.business_id))) return { error: json(403, UNAVAILABLE) };
  if (r.status === 'signed') return { error: gone('signed') };
  if (r.status === 'cancelled') return { error: gone('cancelled') };
  if (r.status === 'expired' || !(Date.parse(r.expires_at) > Date.now())) {   // an unreadable time counts as expired
    if (r.status !== 'expired') await db.from('declaration_requests').update({ status: 'expired' }).eq('id', r.id).in('status', ['sent', 'opened']);
    return { error: gone('expired') };
  }
  const { data: ts } = await db.from('declaration_templates').select('id, title, version, fields, acks').eq('business_id', r.business_id).in('id', r.template_ids);
  const byId = new Map(((ts ?? []) as TemplateRow[]).map((t) => [t.id, t]));
  const templates = r.template_ids.map((id, i) => byId.get(id)).filter((t, i): t is TemplateRow => Boolean(t) && t!.version === r.template_versions[i]);
  if (templates.length !== r.template_ids.length) return { error: gone('not_found') };
  return { r, templates };
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const limited = rateLimited(req, 'declaration-read', PUBLIC_LIMITS.declarationRead, MINUTE);
  if (limited) return limited;
  if (!isToken(token)) return gone('not_found');
  const got = await load(token);
  if ('error' in got) return got.error;
  const { r, templates } = got;
  const db = adminDb();
  if (r.status === 'sent') await db.from('declaration_requests').update({ status: 'opened' }).eq('id', r.id).eq('status', 'sent');
  const { data: lead } = await db.from('leads').select('name').eq('id', r.lead_id).eq('business_id', r.business_id).maybeSingle();
  return json(200, {
    business: await businessName(r.business_id),
    firstName: firstName(String((lead as { name?: string } | null)?.name ?? '')),
    expiresAt: r.expires_at,
    declarations: templates.map((t, i) => ({ n: i, title: t.title, version: t.version, fields: t.fields, acks: t.acks })),
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const limited = rateLimited(req, 'declaration-sign', PUBLIC_LIMITS.declarationSign, MINUTE);
  if (limited) return limited;
  if (!isToken(token)) return gone('not_found');
  let body: any;
  try { body = await req.json(); } catch { return json(400, { code: 'bad_request', message: 'בקשה לא תקינה.' }); }
  const got = await load(token);
  if ('error' in got) return got.error;
  const { r, templates } = got;
  const sent: any[] = Array.isArray(body?.declarations) ? body.declarations : [];
  if (sent.length !== templates.length) return json(400, { code: 'bad_request', message: 'יש למלא ולחתום על כל ההצהרות בקישור.' });

  // ---- everything is checked before anything is written ----
  const ready: { t: TemplateRow; answers: Record<string, unknown>; marketingOk: boolean; hasMarketing: boolean; name: string; png: Buffer }[] = [];
  for (const [i, t] of templates.entries()) {
    const d = sent[i] ?? {};
    const a = checkAnswers(t.fields, t.acks, d.answers, d.acks);
    if (!a.ok) return json(400, { code: 'missing', declaration: i, missing: a.missing, message: a.message });
    const name = String(d.signerName ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (name.length < 2) return json(400, { code: 'missing', declaration: i, missing: 'signer_name', message: 'חסר שם מלא.' });
    if (d.confirm !== true) return json(400, { code: 'missing', declaration: i, missing: 'confirm', message: 'יש לסמן את שורת האישור לפני החתימה.' });
    const sig = await checkSignature(d.signature);
    if (!sig.ok) return json(400, { code: 'missing', declaration: i, missing: 'signature', message: sig.message });
    ready.push({ t, answers: a.answers, marketingOk: a.marketingOk, hasMarketing: t.fields.some((f) => f.type === 'marketing'), name, png: sig.png });
  }

  const db = adminDb();
  const storage = db.storage.from(CLIENT_BUCKET);
  const business = await businessName(r.business_id);
  const ip = clientAddress(req) === 'unknown' ? '' : clientAddress(req);
  const ua = (req.headers.get('user-agent') ?? '').slice(0, 1000);
  const software = `Dream Promotion ${process.env.NEXT_PUBLIC_APP_VERSION ?? ''}`.trim();
  const written: string[] = [];
  const pdfs: { title: string; file: string; pdf: string }[] = [];
  const undo = async () => { if (written.length) await storage.remove(written); };

  try {
    for (const x of ready) {
      const id = crypto.randomUUID();
      const signedAt = new Date().toISOString();
      const folder = `${r.business_id}/${r.lead_id}/declarations`;
      const sigPath = `${folder}/${id}-signature.png`, pdfPath = `${folder}/${id}.pdf`;
      const doc = await buildDeclarationPdf({
        business, templateTitle: x.t.title, templateVersion: x.t.version, number: id, requestId: r.id,
        fields: x.t.fields, acks: x.t.acks, answers: x.answers as any, marketingOk: x.hasMarketing ? x.marketingOk : null,
        signerName: x.name, signaturePng: x.png, signedAt, ip, userAgent: ua, software,
      });
      const { bytes } = await signedPdfBytes(doc, { name: business || 'Dream Promotion', reason: 'הצהרת בריאות חתומה', contactInfo: '' });
      const s1 = await storage.upload(sigPath, x.png, { contentType: 'image/png', upsert: false });
      if (s1.error) throw new Error('store');
      written.push(sigPath);
      const s2 = await storage.upload(pdfPath, bytes, { contentType: 'application/pdf', upsert: false });
      if (s2.error) throw new Error('store');
      written.push(pdfPath);
      const { error } = await db.from('declarations').insert({
        id, business_id: r.business_id, lead_id: r.lead_id, request_id: r.id, template_id: x.t.id, template_version: x.t.version,
        answers: x.answers, acks: x.t.acks.map(() => true), signer_name: x.name, signature_path: sigPath, pdf_path: pdfPath,
        pdf_sha256: sha256(bytes), ip: ip || null, user_agent: ua, marketing_ok: x.marketingOk,
      });
      if (error) throw Object.assign(new Error('row'), { db: error });
      pdfs.push({ title: x.t.title, file: `${x.t.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'הצהרה'}.pdf`, pdf: Buffer.from(bytes).toString('base64') });
    }
  } catch (e: any) {
    await undo();
    // the same link signed a moment ago (two taps, two phones): the unique key refused the second
    if (e?.db?.code === '23505' || /no longer valid|signed/i.test(String(e?.db?.message ?? ''))) return gone('signed');
    return json(500, { code: 'server_error', message: 'החתימה לא נשמרה. נסו שוב בעוד רגע.' });
  }

  const { error: doneErr } = await db.from('declaration_requests').update({ status: 'signed' }).eq('id', r.id).in('status', ['sent', 'opened']);
  if (doneErr) return json(500, { code: 'server_error', message: 'החתימה נשמרה, אבל לא הצלחנו לסיים. רעננו את הדף.' });

  // the customer's timeline, and the owners' phones (best effort: the declaration is already kept)
  try {
    const { data: owners } = await db.from('business_members').select('user_id').eq('business_id', r.business_id).eq('role', 'owner');
    const ownerIds = ((owners ?? []) as { user_id: string }[]).map((o) => o.user_id);
    const by = r.sent_by ?? ownerIds[0];
    const titles = ready.map((x) => x.t.title).join(', ');
    if (by) await db.from('lead_activities').insert({ user_id: by, business_id: r.business_id, lead_id: r.lead_id, kind: 'note', body: `📝 הצהרת בריאות נחתמה: ${titles}` });
    const { data: lead } = await db.from('leads').select('name').eq('id', r.lead_id).maybeSingle();
    for (const u of ownerIds) await pushToUser(u, { title: 'הצהרת בריאות נחתמה', body: `${String((lead as { name?: string } | null)?.name ?? 'לקוח/ה')} — ${titles}`, url: '/leads', tag: `declaration-${r.id}` });
  } catch { /* the signature is kept; the note and the push are extras */ }

  return json(200, { ok: true, pdfs });
}
