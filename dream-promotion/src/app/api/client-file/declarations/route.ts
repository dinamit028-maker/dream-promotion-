import { adminDb } from '@/lib/server/admin';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { businessName, clientFileCaller, isClientFileOwner, notInstalled, NOT_READY } from '@/lib/server/client-file';
import { newToken } from '@/lib/server/declarations';
import { canApprove, cleanAcks, cleanFields, firstName, LIMITS } from '@/features/client-file/declarations';
import { CLIENT_BUCKET, PHOTO_LINK_SECONDS, isUuid } from '@/features/client-file/photos';

export const runtime = 'nodejs';

/**
 * Health declarations — the business's side (docs/CLIENT FILE ENGINEERING HE.md §5.1, 5.2, 5.4), for the owner and the
 * practitioners the owner marked (clientFileCaller). The database enforces the same rules again (migration 4100).
 *   templates        every template of the business (all versions) + the clinic's treatment types
 *   type-add         a treatment type (free text — the clinic's own list)
 *   template-save    a new draft, a new version (a draft) of an approved template, or a change to a draft
 *   template-approve the owner only, after "הנוסח נבדק ומאושר לשימוש"; the version before it is archived
 *   template-archive the owner only; template-delete: a draft only
 *   lead             a customer's links (never their token) and signed declarations (never a path)
 *   send             a new link for approved templates: the token is returned ONCE (for the WhatsApp message), only its
 *                    hash is kept; resend = the old link cancelled + a new one; cancel
 *   open             a signed declaration's PDF: the view is written in the log first, then a link for 5 minutes
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string, code = 'bad_request', status = 400) => json(status, { code, message });
const TEMPLATE_COLUMNS = 'id, family_id, title, treatment_type_ids, version, status, fields, acks, valid_days, source_file_path, created_at, approved_by, approved_at, archived_at';
const REQUEST_COLUMNS = 'id, lead_id, template_ids, template_versions, status, sent_at, opened_at, signed_at, cancelled_at, expires_at';
const DECLARATION_COLUMNS = 'id, lead_id, request_id, template_id, template_version, signer_name, signed_at, valid_until, marketing_ok, pdf_sha256';
const READS = new Set(['templates', 'lead', 'open']);
const OWNER_ONLY = new Set(['template-approve', 'template-archive']);

export async function POST(req: Request) {
  const limited = rateLimited(req, 'client-declarations', 120, MINUTE);
  if (limited) return limited;
  let body: any;
  try { body = await req.json(); } catch { return bad('בקשה לא תקינה.'); }
  const action = String(body?.action ?? '');
  const caller = await clientFileCaller(req, { write: !READS.has(action) });
  if (!caller.ok) return json(caller.status, caller.body);
  const { userId, business } = caller;
  if (OWNER_ONLY.has(action) && !(await isClientFileOwner(userId, business))) {
    return bad('רק בעל/ת העסק מאשר/ת או מעביר/ה לארכיון הצהרה.', 'owner_only', 403);
  }
  const db = adminDb();

  const ownLead = async (id: unknown) => {
    if (!isUuid(id)) return null;
    const { data } = await db.from('leads').select('id, name, phone').eq('id', id).eq('business_id', business).maybeSingle();
    return data as { id: string; name: string; phone: string } | null;
  };
  const ownTemplate = async (id: unknown) => {
    if (!isUuid(id)) return null;
    const { data } = await db.from('declaration_templates').select(TEMPLATE_COLUMNS).eq('id', id).eq('business_id', business).maybeSingle();
    return data as any;
  };
  /** a link for these templates (all approved, of this business): the token once, its hash kept */
  const createRequest = async (lead: string, ids: string[]) => {
    const { data: ts } = await db.from('declaration_templates').select('id, version, status').eq('business_id', business).in('id', ids);
    const rows = (ts ?? []) as { id: string; version: number; status: string }[];
    if (rows.length !== ids.length || rows.some((t) => t.status !== 'approved')) return null;
    const { token, hash } = newToken();
    const { data, error } = await db.from('declaration_requests').insert({
      id: crypto.randomUUID(), business_id: business, lead_id: lead, template_ids: ids, template_versions: ids.map((id) => rows.find((t) => t.id === id)!.version),
      token_hash: hash, status: 'sent', sent_by: userId, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }).select(REQUEST_COLUMNS).single();
    if (error || !data) return null;
    const { token_hash: _hash, ...request } = data as Record<string, unknown>;   // never back to the browser, even as a hash
    return { request, token };
  };

  try {
    if (action === 'templates') {
      const [t, y] = await Promise.all([
        db.from('declaration_templates').select(TEMPLATE_COLUMNS).eq('business_id', business).order('created_at', { ascending: false }),
        db.from('treatment_types').select('id, name, active, sort').eq('business_id', business).order('sort', { ascending: true }),
      ]);
      if (notInstalled(t.error ?? y.error)) return json(404, NOT_READY);
      return json(200, { templates: t.data ?? [], types: y.data ?? [], owner: await isClientFileOwner(userId, business) });
    }

    if (action === 'type-add') {
      const name = String(body.name ?? '').trim().slice(0, 80);
      if (!name) return bad('תנו שם לסוג הטיפול.');
      const { data: have } = await db.from('treatment_types').select('id, name').eq('business_id', business);
      if (((have ?? []) as { name: string }[]).some((t) => t.name.trim().toLowerCase() === name.toLowerCase())) return bad('סוג הטיפול הזה כבר קיים.', 'exists', 409);
      const { data, error } = await db.from('treatment_types').insert({ business_id: business, name, sort: ((have ?? []) as unknown[]).length })
        .select('id, name, active, sort').single();
      if (error || !data) return bad('סוג הטיפול לא נשמר — נסו שוב.', 'row_failed', 500);
      return json(200, { type: data });
    }

    if (action === 'template-save') {
      const title = String(body.title ?? '').trim().slice(0, LIMITS.title);
      if (!title) return bad('תנו שם להצהרה.');
      const f = cleanFields(body.fields);
      if (!f.ok) return bad(f.error);
      const a = cleanAcks(body.acks);
      if (!a.ok) return bad(a.error);
      const days = body.validDays == null || body.validDays === '' ? null : Number(body.validDays);
      if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) return bad('תוקף: מספר ימים בין 1 ל-3650, או בלי הגבלה.');
      const typeIds: string[] = Array.isArray(body.treatmentTypeIds) ? [...new Set(body.treatmentTypeIds.filter(isUuid) as string[])] : [];
      if (typeIds.length) {
        const { data: ys } = await db.from('treatment_types').select('id').eq('business_id', business).in('id', typeIds);
        if (((ys ?? []) as unknown[]).length !== typeIds.length) return bad('סוג טיפול לא מוכר.');
      }
      const content = { title, treatment_type_ids: typeIds, fields: f.fields, acks: a.acks, valid_days: days };

      if (body.id) {   // a change to a draft
        const t = await ownTemplate(body.id);
        if (!t) return bad('ההצהרה לא נמצאה.', 'not_found', 404);
        if (t.status !== 'draft') return bad('הצהרה מאושרת לא נערכת — "עריכה" יוצרת גרסה חדשה.', 'not_draft', 409);
        const { data, error } = await db.from('declaration_templates').update(content).eq('id', t.id).eq('business_id', business).select(TEMPLATE_COLUMNS).maybeSingle();
        if (error || !data) return bad('השמירה לא הצליחה — נסו שוב.', 'save_failed', 500);
        return json(200, { template: data });
      }
      let family: string | null = null, version = 1;
      if (body.familyOf) {   // a new version of an approved (or archived) template
        const base = await ownTemplate(body.familyOf);
        if (!base) return bad('ההצהרה לא נמצאה.', 'not_found', 404);
        family = base.family_id ?? base.id;
        const { data: fam } = await db.from('declaration_templates').select('version, status').eq('business_id', business).eq('family_id', family);
        const list = (fam ?? []) as { version: number; status: string }[];
        if (list.some((x) => x.status === 'draft')) return bad('כבר יש טיוטה של ההצהרה הזו — המשיכו אותה.', 'draft_exists', 409);
        version = Math.max(0, ...list.map((x) => x.version)) + 1;
      }
      const id = crypto.randomUUID();
      const { data, error } = await db.from('declaration_templates').insert({
        id, business_id: business, family_id: family ?? id, version, status: 'draft', created_by: userId, ...content,
      }).select(TEMPLATE_COLUMNS).single();
      if (error || !data) return bad('השמירה לא הצליחה — נסו שוב.', 'save_failed', 500);
      return json(200, { template: data });
    }

    if (action === 'template-approve') {
      if (body.confirmed !== true) return bad('סמנו "הנוסח נבדק ומאושר לשימוש" לפני האישור.');
      const t = await ownTemplate(body.id);
      if (!t) return bad('ההצהרה לא נמצאה.', 'not_found', 404);
      if (t.status !== 'draft') return bad('ההצהרה כבר אושרה.', 'not_draft', 409);
      if (!canApprove(t.fields ?? [], t.acks ?? [])) return bad('הצהרה ריקה לא מאושרת — הוסיפו שאלה או אישור.');
      // the version before it is archived by the database in this same step (b_declaration_templates_check)
      const { data, error } = await db.from('declaration_templates').update({ status: 'approved', approved_by: userId, approved_at: new Date().toISOString() })
        .eq('id', t.id).eq('business_id', business).eq('status', 'draft').select(TEMPLATE_COLUMNS).maybeSingle();
      if (error || !data) return bad('האישור לא נשמר — נסו שוב.', 'approve_failed', 500);
      return json(200, { template: data });
    }

    if (action === 'template-archive') {
      const t = await ownTemplate(body.id);
      if (!t) return bad('ההצהרה לא נמצאה.', 'not_found', 404);
      if (t.status !== 'approved') return bad('רק הצהרה מאושרת עוברת לארכיון.', 'not_approved', 409);
      const { data, error } = await db.from('declaration_templates').update({ status: 'archived', archived_at: new Date().toISOString() })
        .eq('id', t.id).eq('business_id', business).select(TEMPLATE_COLUMNS).maybeSingle();
      if (error || !data) return bad('לא הצלחנו להעביר לארכיון — נסו שוב.', 'archive_failed', 500);
      return json(200, { template: data });
    }

    if (action === 'template-delete') {
      const t = await ownTemplate(body.id);
      if (!t) return bad('ההצהרה לא נמצאה.', 'not_found', 404);
      if (t.status !== 'draft') return bad('הצהרה מאושרת לא נמחקת — אפשר להעביר לארכיון.', 'not_draft', 409);
      const { error } = await db.from('declaration_templates').delete().eq('id', t.id).eq('business_id', business).eq('status', 'draft');
      if (error) return bad('המחיקה לא הצליחה — נסו שוב.', 'delete_failed', 500);
      return json(200, { ok: true });
    }

    if (action === 'lead') {
      const lead = await ownLead(body.leadId);
      if (!lead) return bad('הלקוח לא נמצא בעסק הזה.', 'not_found', 404);
      const [r, d, t, tr, y] = await Promise.all([
        db.from('declaration_requests').select(REQUEST_COLUMNS).eq('business_id', business).eq('lead_id', lead.id).order('sent_at', { ascending: false }),
        db.from('declarations').select(DECLARATION_COLUMNS).eq('business_id', business).eq('lead_id', lead.id).order('signed_at', { ascending: false }),
        db.from('declaration_templates').select('id, family_id, title, treatment_type_ids, version, status, valid_days').eq('business_id', business),
        db.from('client_treatments').select('id, treatment_type_id, status').eq('business_id', business).eq('lead_id', lead.id),
        db.from('treatment_types').select('id, name, active, sort').eq('business_id', business).order('sort', { ascending: true }),
      ]);
      const err = r.error ?? d.error ?? t.error ?? tr.error ?? y.error;
      if (notInstalled(err)) return json(404, NOT_READY);
      if (err) return bad('לא הצלחנו לטעון את ההצהרות — נסו שוב.', 'load_failed', 500);
      // the types of the customer's open treatments: their declarations are pre-selected when sending
      const openTypes = [...new Set(((tr.data ?? []) as { treatment_type_id: string | null; status: string }[])
        .filter((x) => x.status === 'active' && x.treatment_type_id).map((x) => x.treatment_type_id!))];
      const requests = ((r.data ?? []) as Record<string, unknown>[]).map(({ token_hash: _hash, ...x }) => x);   // never the hash
      const declarations = ((d.data ?? []) as Record<string, unknown>[]).map(({ pdf_path: _p, signature_path: _s, answers: _a, ip: _i, user_agent: _u, ...x }) => x);
      return json(200, { requests, declarations, templates: t.data ?? [], types: y.data ?? [], openTypes, business: await businessName(business) });
    }

    if (action === 'send') {
      const lead = await ownLead(body.leadId);
      if (!lead) return bad('הלקוח לא נמצא בעסק הזה.', 'not_found', 404);
      const ids: string[] = Array.isArray(body.templateIds) ? [...new Set(body.templateIds.filter(isUuid) as string[])] : [];
      if (!ids.length || ids.length > 20) return bad('בחרו הצהרה אחת לפחות.');
      const made = await createRequest(lead.id, ids);
      if (!made) return bad('אפשר לשלוח רק הצהרות מאושרות של העסק.', 'not_approved', 409);
      return json(200, { ...made, firstName: firstName(lead.name), phone: lead.phone, business: await businessName(business) });
    }

    if (action === 'resend' || action === 'cancel') {
      if (!isUuid(body.requestId)) return bad('קישור לא מוכר.');
      const { data: r } = await db.from('declaration_requests').select('id, lead_id, template_ids, status, expires_at').eq('id', body.requestId).eq('business_id', business).maybeSingle();
      const old = r as { id: string; lead_id: string; template_ids: string[]; status: string; expires_at: string } | null;
      if (!old) return bad('הקישור לא נמצא.', 'not_found', 404);
      if (old.status === 'signed') return bad('ההצהרה כבר נחתמה.', 'signed', 409);
      if (old.status === 'sent' || old.status === 'opened') {
        const { error } = await db.from('declaration_requests').update({ status: 'cancelled' }).eq('id', old.id).eq('business_id', business).in('status', ['sent', 'opened']);
        if (error) return bad('לא הצלחנו לבטל את הקישור — נסו שוב.', 'cancel_failed', 500);
      }
      if (action === 'cancel') return json(200, { ok: true });
      const lead = await ownLead(old.lead_id);
      if (!lead) return bad('הלקוח לא נמצא בעסק הזה.', 'not_found', 404);
      const made = await createRequest(lead.id, old.template_ids);
      if (!made) return bad('אחת ההצהרות עודכנה או הועברה לארכיון מאז — בחרו מחדש ב"שלח הצהרת בריאות".', 'not_approved', 409);
      return json(200, { ...made, firstName: firstName(lead.name), phone: lead.phone, business: await businessName(business) });
    }

    if (action === 'open') {
      if (!isUuid(body.declarationId)) return bad('הצהרה לא מוכרת.');
      const { data: d } = await db.from('declarations').select('id, lead_id, pdf_path').eq('id', body.declarationId).eq('business_id', business).maybeSingle();
      const row = d as { id: string; lead_id: string; pdf_path: string } | null;
      if (!row || !row.pdf_path.startsWith(`${business}/${row.lead_id}/`)) return bad('ההצהרה לא נמצאה.', 'not_found', 404);
      const { error: logErr } = await db.rpc('client_file_log_view', { p_user: userId, p_business: business, p_object: 'declaration', p_id: row.id });
      if (logErr) return bad('לא הצלחנו לרשום את הצפייה ביומן, ולכן ההצהרה לא נפתחה. נסו שוב.', 'log_failed', 500);
      const { data } = await db.storage.from(CLIENT_BUCKET).createSignedUrl(row.pdf_path, PHOTO_LINK_SECONDS);
      if (!data?.signedUrl) return bad('לא הצלחנו לפתוח את הקובץ — נסו שוב.', 'sign_failed', 502);
      return json(200, { url: data.signedUrl, expiresIn: PHOTO_LINK_SECONDS });
    }

    return bad('פעולה לא מוכרת.');
  } catch {
    return bad('משהו השתבש — נסו שוב.', 'server_error', 500);
  }
}
