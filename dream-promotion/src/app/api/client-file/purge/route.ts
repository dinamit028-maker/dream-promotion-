import { adminDb } from '@/lib/server/admin';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { clientFileCaller, isClientFileOwner } from '@/lib/server/client-file';
import { CLIENT_BUCKET, inLead, isUuid } from '@/features/client-file/photos';

export const runtime = 'nodejs';

/**
 * Deleting a customer's whole client file, on their request (docs/CLIENT FILE ENGINEERING HE.md §2): the owner only, after
 * typing the customer's name. The database deletes the rows (client_file_purge — treatments, sessions, photos, links,
 * signed declarations) and writes "purge" in the view log, without the content; then the files go from client-files —
 * the ones the database named and anything else left in the customer's folder (an upload that never finished).
 * A line on the customer's timeline says the file was deleted — never what was in it.
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string, code = 'bad_request', status = 400) => json(status, { code, message });

export async function POST(req: Request) {
  const limited = rateLimited(req, 'client-file-purge', 10, MINUTE);
  if (limited) return limited;
  let body: any;
  try { body = await req.json(); } catch { return bad('בקשה לא תקינה.'); }
  const caller = await clientFileCaller(req, { write: true });
  if (!caller.ok) return json(caller.status, caller.body);
  const { userId, business } = caller;
  if (!(await isClientFileOwner(userId, business))) return bad('רק בעל/ת העסק מוחק/ת תיק לקוח.', 'owner_only', 403);
  const db = adminDb();
  if (!isUuid(body?.leadId)) return bad('הלקוח לא נמצא בעסק הזה.', 'not_found', 404);
  const { data: lead } = await db.from('leads').select('id, name').eq('id', body.leadId).eq('business_id', business).maybeSingle();
  const l = lead as { id: string; name: string } | null;
  if (!l) return bad('הלקוח לא נמצא בעסק הזה.', 'not_found', 404);
  if (String(body.confirmName ?? '').trim() !== l.name.trim()) return bad('כדי למחוק, הקלידו את שם הלקוח/ה בדיוק כמו בכרטיס.', 'confirm');

  const { data, error } = await db.rpc('client_file_purge', { p_user: userId, p_business: business, p_lead: l.id });
  if (error || !data) return bad('המחיקה לא הצליחה — נסו שוב.', 'purge_failed', 500);
  const r = data as { paths: string[]; counts: { photos: number; declarations: number; treatments: number } };

  // the files: what the database named, and whatever else is in the customer's folders (best effort — the rows are gone)
  const storage = db.storage.from(CLIENT_BUCKET);
  const folder = `${business}/${l.id}`;
  const names = new Set((r.paths ?? []).filter((p) => inLead(p, business, l.id)));
  for (const sub of [folder, `${folder}/incoming`, `${folder}/declarations`]) {
    const { data: listed } = await storage.list(sub, { limit: 1000 });
    for (const o of (listed ?? []) as { name: string; id?: string | null }[]) if (o.id !== null) names.add(`${sub}/${o.name}`);
  }
  const all = [...names].filter((p) => inLead(p, business, l.id));
  let removed = 0;
  for (let i = 0; i < all.length; i += 100) {
    const { data: gone } = await storage.remove(all.slice(i, i + 100));
    removed += ((gone ?? []) as unknown[]).length;
  }
  await db.from('lead_activities').insert({ user_id: userId, business_id: business, lead_id: l.id, kind: 'note', body: '🗑️ תיק הלקוח נמחק (צילומים, טיפולים והצהרות) לבקשת הלקוח/ה' });
  return json(200, { ok: true, counts: r.counts, files: { asked: all.length, removed } });
}
