import { adminDb } from '@/lib/server/admin';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { PhotoError, cleanPhoto, clientFileCaller, israelDayStart, notInstalled, NOT_READY } from '@/lib/server/client-file';
import {
  CLIENT_BUCKET, DAILY_PHOTO_LIMIT, MAX_PHOTO_BYTES, PHOTO_LINK_SECONDS, cleanTakenAt, inLead, incomingPath, isStage, isUuid, photoPath,
} from '@/features/client-file/photos';

export const runtime = 'nodejs';

/**
 * Client file — photos (docs/CLIENT FILE ENGINEERING HE.md §4). The bucket client-files has no browser policy, so every
 * read and write goes through here, for the owner and the practitioners the owner marked (clientFileCaller):
 *   list      → the customer's treatments and photos (no paths, no links) + the clinic's treatment types
 *   sign      → a signed upload link for ONE original, in <business>/<lead>/incoming/<id>
 *   commit    → the server reads what landed, removes EXIF/GPS, makes ≤2048px WebP at <business>/<lead>/<id>.webp, records
 *               the photo (id = the upload's id, so a retry from a weak network never makes a second photo) and removes
 *               the original
 *   discard   → the original of an upload that was given up
 *   open      → every photo asked: the view is written in the log FIRST, then a signed link for 5 minutes
 *   update    → stage / treatment of a photo (its file never moves; marketing consent is not set here)
 *   treatment → a new treatment for the customer (from the camera: "טיפול חדש")
 * The business is the one the user works in now — never one sent by the browser; every row and path is checked to be of it.
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string, code = 'bad_request', status = 400) => json(status, { code, message });
const PHOTO_COLUMNS = 'id, lead_id, treatment_id, session_id, stage, width, height, taken_at, by_user, marketing_ok';
const TREATMENT_COLUMNS = 'id, lead_id, title, area, started_at, status, treatment_type_id';
const WRITES = new Set(['sign', 'commit', 'discard', 'update', 'treatment']);

export async function POST(req: Request) {
  const limited = rateLimited(req, 'client-photos', 240, MINUTE);
  if (limited) return limited;
  let body: any;
  try { body = await req.json(); } catch { return bad('בקשה לא תקינה.'); }
  const action = String(body?.action ?? '');
  const caller = await clientFileCaller(req, { write: WRITES.has(action) });
  if (!caller.ok) return json(caller.status, caller.body);
  const { userId, business } = caller;
  const db = adminDb();
  const storage = db.storage.from(CLIENT_BUCKET);

  /** a customer of the business worked in now — the only customers this route touches */
  const ownLead = async (id: unknown) => {
    if (!isUuid(id)) return null;
    const { data } = await db.from('leads').select('id').eq('id', id).eq('business_id', business).maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };
  /** a treatment / session of this customer, or null; undefined when none was asked */
  const ownOf = async (table: 'client_treatments' | 'client_sessions', id: unknown, lead: string) => {
    if (id == null || id === '') return undefined;
    if (!isUuid(id)) return null;
    const { data } = await db.from(table).select('id').eq('id', id).eq('business_id', business).eq('lead_id', lead).maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };
  const removeIn = async (path: string, lead: string) => { if (inLead(path, business, lead)) await storage.remove([path]); };

  try {
    if (action === 'list') {
      const lead = await ownLead(body.leadId);
      if (!lead) return bad('הלקוח לא נמצא בעסק הזה.', 'not_found', 404);
      const [t, p, y] = await Promise.all([
        db.from('client_treatments').select(TREATMENT_COLUMNS).eq('business_id', business).eq('lead_id', lead).order('started_at', { ascending: false }),
        db.from('client_photos').select(PHOTO_COLUMNS).eq('business_id', business).eq('lead_id', lead).order('taken_at', { ascending: true }),
        db.from('treatment_types').select('id, name, active, sort').eq('business_id', business).order('sort', { ascending: true }),
      ]);
      const err = t.error ?? p.error ?? y.error;
      if (notInstalled(err)) return json(404, NOT_READY);
      if (err) return bad('לא הצלחנו לטעון את התיק — נסו שוב.', 'load_failed', 500);
      return json(200, { treatments: t.data ?? [], photos: p.data ?? [], types: y.data ?? [] });
    }

    if (action === 'sign') {
      const lead = await ownLead(body.leadId);
      if (!lead) return bad('הלקוח לא נמצא בעסק הזה.', 'not_found', 404);
      const id = isUuid(body.uploadId) ? body.uploadId : crypto.randomUUID();
      const path = incomingPath(business, lead, id);
      const { data, error } = await storage.createSignedUploadUrl(path, { upsert: true });
      if (error || !data?.token) return bad('לא הצלחנו להכין את ההעלאה — נסו שוב.', 'sign_failed', 502);
      return json(200, { uploadId: id, path, token: data.token, maxBytes: MAX_PHOTO_BYTES });
    }

    if (action === 'discard') {
      const lead = await ownLead(body.leadId);
      if (!lead || !isUuid(body.uploadId)) return bad('העלאה לא מוכרת.');
      await removeIn(incomingPath(business, lead, body.uploadId), lead);
      return json(200, { ok: true });
    }

    if (action === 'commit') {
      const lead = await ownLead(body.leadId);
      if (!lead) return bad('הלקוח לא נמצא בעסק הזה.', 'not_found', 404);
      if (!isUuid(body.uploadId)) return bad('העלאה לא מוכרת.');
      if (!isStage(body.stage)) return bad('בחרו לפני, אחרי או תהליך.');
      const id: string = body.uploadId;
      const incoming = incomingPath(business, lead, id);

      // a retry of an upload that was already kept: the same photo, never a second one
      const { data: had } = await db.from('client_photos').select(PHOTO_COLUMNS).eq('id', id).eq('business_id', business).maybeSingle();
      if (had) { await removeIn(incoming, lead); return json(200, { photo: had }); }

      const treatment = await ownOf('client_treatments', body.treatmentId, lead);
      const session = await ownOf('client_sessions', body.sessionId, lead);
      if (treatment === null || session === null) return bad('הטיפול לא שייך ללקוח הזה.');
      if (session && !treatment) return bad('סשן שייך לטיפול — בחרו גם את הטיפול.');

      const { data: today } = await db.from('client_photos').select('id').eq('business_id', business).gte('created_at', israelDayStart());
      if (((today ?? []) as unknown[]).length >= DAILY_PHOTO_LIMIT) {
        await removeIn(incoming, lead);
        return bad(`הגעתם למכסה של ${DAILY_PHOTO_LIMIT} תמונות ליום. אפשר להמשיך מחר.`, 'quota', 429);
      }

      const { data: blob, error: dlErr } = await storage.download(incoming);
      if (dlErr || !blob) return bad('התמונה עוד לא הגיעה לשרת — ננסה שוב.', 'not_uploaded', 409);
      let clean: Awaited<ReturnType<typeof cleanPhoto>>;
      try {
        clean = await cleanPhoto(new Uint8Array(await blob.arrayBuffer()));
      } catch (e) {
        await removeIn(incoming, lead);
        if (e instanceof PhotoError) return bad(e.message, e.code);
        throw e;
      }
      const path = photoPath(business, lead, id);
      const up = await storage.upload(path, clean.bytes, { contentType: 'image/webp', upsert: true, cacheControl: '0' });
      if (up.error) return bad('השמירה לא הצליחה — ננסה שוב.', 'store_failed', 502);
      const { data: row, error } = await db.from('client_photos').insert({
        id, business_id: business, lead_id: lead, treatment_id: treatment ?? null, session_id: session ?? null, stage: body.stage,
        path, width: clean.width, height: clean.height, taken_at: cleanTakenAt(body.takenAt), by_user: userId,
      }).select(PHOTO_COLUMNS).single();
      if (error || !row) {
        await removeIn(path, lead);
        if (notInstalled(error)) return json(404, NOT_READY);
        return bad('התמונה לא נשמרה — ננסה שוב.', 'row_failed', 500);
      }
      await removeIn(incoming, lead);   // the original, with its EXIF, is not kept
      return json(200, { photo: row });
    }

    if (action === 'open') {
      const ids: unknown[] = Array.isArray(body.photoIds) ? body.photoIds : [];
      if (!ids.length || ids.length > 40 || !ids.every(isUuid)) return bad('תמונות לא מוכרות.');
      const { data: rows } = await db.from('client_photos').select('id, lead_id, path').eq('business_id', business).in('id', ids as string[]);
      const urls: Record<string, string> = {};
      for (const r of (rows ?? []) as { id: string; lead_id: string; path: string }[]) {
        if (!inLead(r.path, business, r.lead_id)) continue;
        // the log first: no link without a line in it
        const { error: logErr } = await db.rpc('client_file_log_view', { p_user: userId, p_business: business, p_object: 'photo', p_id: r.id });
        if (logErr) continue;
        const { data } = await storage.createSignedUrl(r.path, PHOTO_LINK_SECONDS);
        if (data?.signedUrl) urls[r.id] = data.signedUrl;
      }
      return json(200, { urls, expiresIn: PHOTO_LINK_SECONDS });
    }

    if (action === 'update') {
      if (!isUuid(body.photoId)) return bad('תמונה לא מוכרת.');
      const { data: p } = await db.from('client_photos').select('id, lead_id').eq('id', body.photoId).eq('business_id', business).maybeSingle();
      if (!p) return bad('התמונה לא נמצאה בעסק הזה.', 'not_found', 404);
      const lead = (p as { lead_id: string }).lead_id;
      const patch: Record<string, unknown> = {};
      if (body.stage !== undefined) { if (!isStage(body.stage)) return bad('בחרו לפני, אחרי או תהליך.'); patch.stage = body.stage; }
      if (body.treatmentId !== undefined) {
        const t = await ownOf('client_treatments', body.treatmentId, lead);
        if (t === null) return bad('הטיפול לא שייך ללקוח הזה.');
        patch.treatment_id = t ?? null;
        patch.session_id = null;
      }
      if (!Object.keys(patch).length) return bad('אין מה לשנות.');
      const { data: row, error } = await db.from('client_photos').update(patch).eq('id', body.photoId).eq('business_id', business)
        .select(PHOTO_COLUMNS).maybeSingle();
      if (error || !row) return bad('השינוי לא נשמר — נסו שוב.', 'update_failed', 500);
      return json(200, { photo: row });
    }

    if (action === 'treatment') {
      const lead = await ownLead(body.leadId);
      if (!lead) return bad('הלקוח לא נמצא בעסק הזה.', 'not_found', 404);
      const title = String(body.title ?? '').trim().slice(0, 200);
      if (!title) return bad('תנו שם לטיפול.');
      let type: string | null = null;
      if (body.treatmentTypeId) {
        const { data: y } = isUuid(body.treatmentTypeId)
          ? await db.from('treatment_types').select('id').eq('id', body.treatmentTypeId).eq('business_id', business).maybeSingle()
          : { data: null };
        if (!y) return bad('סוג הטיפול לא נמצא בעסק הזה.');
        type = body.treatmentTypeId;
      }
      const { data: row, error } = await db.from('client_treatments').insert({
        business_id: business, lead_id: lead, title, area: String(body.area ?? '').trim().slice(0, 200), treatment_type_id: type, created_by: userId,
      }).select(TREATMENT_COLUMNS).single();
      if (error || !row) return bad('הטיפול לא נשמר — נסו שוב.', 'row_failed', 500);
      return json(200, { treatment: row });
    }

    return bad('פעולה לא מוכרת.');
  } catch {
    return bad('משהו השתבש — נסו שוב.', 'server_error', 500);
  }
}
