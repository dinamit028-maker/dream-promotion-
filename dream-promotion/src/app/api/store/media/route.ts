import { randomUUID } from 'node:crypto';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { blockedFor, workBusiness } from '@/lib/server/business';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { BUCKET, cleanSizes, cleanType, inBusiness, isUuid, mediaFolder, sizeFile } from '@/features/catalog/images';
import { LIMITS, MAX_PICTURES } from '@/features/catalog/catalog';

export const runtime = 'nodejs';

/**
 * Product pictures (Dream Commerce 2.54) — the bucket store-media has no browser policy, so every write goes through here:
 *   sign     → signed upload links for the sizes of ONE picture, in <business>/<item>/<upload>/ (the browser made the sizes)
 *   register → after the upload: the files are checked in storage (type, size — what landed, not what the browser says),
 *              and the picture is recorded (catalog_media; the database makes the first one the item's image_url)
 *   delete   → a picture: its files and its row
 *   purge    → every picture of an item, before the item is deleted (its rows would go with it; its files would stay)
 * Service role, so this route checks everything itself: a signed-in member who may write (not a cashier, not a viewer,
 * not a locked business), the business they work in NOW (never one sent by the browser), and an item of that business.
 */
const MAX_FILE = 5 * 1024 * 1024; // the bucket's own limit too
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string, code = 'bad_request', status = 400) => json(status, { code, message });

export async function POST(req: Request) {
  const limited = rateLimited(req, 'store-media', 120, MINUTE);
  if (limited) return limited;
  const userId = await userFromRequest(req);
  if (!userId) return bad('צריך להתחבר מחדש.', 'no_session', 401);
  const blocked = await blockedFor(userId);
  if (blocked) return json(403, blocked);
  const business = await workBusiness(userId);
  if (!isUuid(business)) return bad('החשבון לא משויך לעסק.', 'no_business', 403);
  let body: any;
  try { body = await req.json(); } catch { return bad('בקשה לא תקינה.'); }
  const db = adminDb();
  const storage = db.storage.from(BUCKET);

  /** an item of the business worked in now — the only items this route touches */
  const ownItem = async (id: unknown) => {
    if (!isUuid(id)) return null;
    const { data } = await db.from('catalog_items').select('id').eq('id', id).eq('business_id', business).maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };
  /** the files of a picture's folder (never outside this business) */
  const removeFolder = async (folder: string) => {
    if (!inBusiness(folder, business)) return;
    const { data } = await storage.list(folder, { limit: 20 });
    const names = ((data ?? []) as { name: string }[]).map((o) => `${folder}/${o.name}`);
    if (names.length) await storage.remove(names);
  };

  try {
    if (body.action === 'sign' || body.action === 'register') {
      const item = await ownItem(body.itemId);
      if (!item) return bad('המוצר לא נמצא בעסק הזה.', 'not_found', 404);
      const sizes = cleanSizes(body.sizes), type = cleanType(body.type);
      if (!sizes || !type) return bad('גדלים או סוג תמונה לא תקינים.');

      if (body.action === 'sign') {
        const { data: have } = await db.from('catalog_media').select('id').eq('item_id', item).eq('business_id', business);
        if (((have ?? []) as unknown[]).length >= MAX_PICTURES) return bad(`עד ${MAX_PICTURES} תמונות למוצר.`, 'too_many', 409);
        const upload = randomUUID();
        const uploads: { size: number; path: string; token: string }[] = [];
        for (const size of sizes) {
          const path = `${mediaFolder(business, item, upload)}/${sizeFile(size, type)}`;
          const { data, error } = await storage.createSignedUploadUrl(path);
          if (error || !data?.token) return bad('לא הצלחנו להכין את ההעלאה — נסו שוב.', 'sign_failed', 502);
          uploads.push({ size, path, token: data.token });
        }
        return json(200, { uploadId: upload, uploads });
      }

      // register: what landed in storage, size by size
      if (!isUuid(body.uploadId)) return bad('העלאה לא מוכרת.');
      const folder = mediaFolder(business, item, body.uploadId);
      const { data: listed } = await storage.list(folder, { limit: 20 });
      const files = new Map(((listed ?? []) as { name: string; metadata?: any }[]).map((o) => [o.name, o]));
      const urls: Record<string, string> = {};
      for (const size of sizes) {
        const f = files.get(sizeFile(size, type));
        const mime = String(f?.metadata?.mimetype ?? '').toLowerCase(), bytes = Number(f?.metadata?.size ?? 0);
        if (!f || mime !== type || !(bytes > 0 && bytes <= MAX_FILE)) {
          await removeFolder(folder);
          return bad('התמונה לא הועלתה במלואה (או שהקובץ לא תקין) — נסו שוב.', 'bad_file');
        }
        urls[String(size)] = storage.getPublicUrl(`${folder}/${sizeFile(size, type)}`).data.publicUrl;
      }
      const main = urls[String(sizes[sizes.length - 1])];
      if (!/^https:\/\//.test(main)) return bad('כתובת התמונה לא תקינה.', 'bad_url', 500);
      let variant: string | null = null;
      if (body.variantId != null) {
        const { data: v } = isUuid(body.variantId)
          ? await db.from('catalog_variants').select('id').eq('id', body.variantId).eq('item_id', item).eq('business_id', business).maybeSingle()
          : { data: null };
        if (!v) return bad('הווריאנט לא שייך למוצר הזה.');
        variant = body.variantId;
      }
      const { data: last } = await db.from('catalog_media').select('position').eq('item_id', item).eq('business_id', business).order('position', { ascending: false }).limit(1);
      const position = Number(((last ?? []) as { position: number }[])[0]?.position ?? -1) + 1;
      const dim = (n: unknown) => (Number.isInteger(n) && (n as number) > 0 && (n as number) < 20000 ? n as number : null);
      const { data: row, error } = await db.from('catalog_media').insert({
        business_id: business, item_id: item, variant_id: variant, kind: 'image', path: folder, url: main, sizes: urls,
        width: dim(body.width), height: dim(body.height), alt: String(body.alt ?? '').trim().slice(0, LIMITS.alt), position, created_by: userId,
      }).select('*').single();
      if (error || !row) { await removeFolder(folder); return bad('התמונה לא נשמרה — נסו שוב.', 'row_failed', 500); }
      return json(200, { media: row });
    }

    if (body.action === 'delete') {
      if (!isUuid(body.mediaId)) return bad('תמונה לא מוכרת.');
      const { data: m } = await db.from('catalog_media').select('id, path').eq('id', body.mediaId).eq('business_id', business).maybeSingle();
      if (!m) return bad('התמונה לא נמצאה בעסק הזה.', 'not_found', 404);
      await removeFolder((m as { path: string }).path);
      const { error } = await db.from('catalog_media').delete().eq('id', body.mediaId).eq('business_id', business);
      if (error) return bad('התמונה לא נמחקה — נסו שוב.', 'delete_failed', 500);
      return json(200, { deleted: 1 });
    }

    if (body.action === 'purge') {
      const item = await ownItem(body.itemId);
      if (!item) return bad('המוצר לא נמצא בעסק הזה.', 'not_found', 404);
      const { data: all } = await db.from('catalog_media').select('id, path').eq('item_id', item).eq('business_id', business);
      const rows = (all ?? []) as { id: string; path: string }[];
      for (const m of rows) await removeFolder(m.path);
      if (rows.length) await db.from('catalog_media').delete().eq('item_id', item).eq('business_id', business);
      return json(200, { deleted: rows.length });
    }

    return bad('פעולה לא מוכרת.');
  } catch {
    return bad('משהו השתבש בשמירת התמונה — נסו שוב.', 'media_error', 500);
  }
}
