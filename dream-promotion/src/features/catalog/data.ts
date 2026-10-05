import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import {
  MIGRATION_3300, catalogError, toCatalogItem, toFieldDef, toMedia, toOption, toVariant,
  type CatalogItem, type CatalogMedia, type CatalogOption, type CatalogVariant, type FieldDef,
} from './catalog';

/**
 * The catalog's reads and writes from the browser (row-level security decides what the signed-in member sees and may
 * change — a cashier reads, a viewer reads, the owner writes). Pictures go through the server (/api/store/media): the
 * bucket has no browser policy. Before migration 3300 runs, the new tables are missing: the catalog still loads (items
 * only, `ready: false`) so the register keeps working, and the editor says which migration to run.
 */
export interface CatalogData { items: CatalogItem[]; variants: CatalogVariant[]; options: CatalogOption[]; media: CatalogMedia[]; fields: FieldDef[]; ready: boolean }
type Result<T> = { ok: true; data: T } | { ok: false; error: string };
const fail = (e: any, general = 'משהו השתבש. נסו שוב.'): { ok: false; error: string } => ({
  ok: false,
  // an update that row-level security hid returns no row ("PGRST116"): a cashier, a viewer, or a row deleted meanwhile
  error: catalogError(e) ?? (e?.code === 'PGRST116' ? 'לא נשמר — אין הרשאה לשנות, או שהפריט נמחק בינתיים.' : general),
});

/** the new tables, when they exist; a missing table (migration not run yet) is "not ready", anything else is an error */
async function optional<T>(q: PromiseLike<{ data: any; error: any }>, map: (r: any) => T): Promise<{ rows: T[]; missing: boolean; error: any }> {
  const { data, error } = await q;
  if (!error) return { rows: ((data ?? []) as any[]).map(map), missing: false, error: null };
  return catalogError(error) === MIGRATION_3300 ? { rows: [], missing: true, error: null } : { rows: [], missing: false, error };
}

export async function loadCatalog(what: { options?: boolean; media?: boolean; fields?: boolean } = {}): Promise<Result<CatalogData>> {
  const sb = supabase();
  const none = Promise.resolve({ data: [], error: null });
  const [it, va, op, me, fd] = await Promise.all([
    sb.from('catalog_items').select('*').order('sort').order('created_at'),
    optional(sb.from('catalog_variants').select('*').order('position').order('created_at'), toVariant),
    optional(what.options ? sb.from('catalog_options').select('*').order('position') : none, toOption),
    optional(what.media ? sb.from('catalog_media').select('*').order('position').order('created_at') : none, toMedia),
    optional(what.fields ? sb.from('catalog_field_defs').select('*').order('position').order('created_at') : none, toFieldDef),
  ]);
  if (it.error) return fail(it.error, 'המחירון לא נטען — בדקו את החיבור ונסו שוב.');
  const bad = [va, op, me, fd].find((x) => x.error);
  if (bad) return fail(bad.error, 'המחירון לא נטען — בדקו את החיבור ונסו שוב.');
  return { ok: true, data: { items: ((it.data ?? []) as any[]).map(toCatalogItem), variants: va.rows, options: op.rows, media: me.rows, fields: fd.rows, ready: ![va, op, me, fd].some((x) => x.missing) } };
}

/** one item with everything of it (the editor) */
export async function loadProduct(id: string): Promise<Result<{ item: CatalogItem; variants: CatalogVariant[]; options: CatalogOption[]; media: CatalogMedia[]; fields: FieldDef[]; ready: boolean }>> {
  const sb = supabase();
  const [it, va, op, me, fd] = await Promise.all([
    sb.from('catalog_items').select('*').eq('id', id).maybeSingle(),
    optional(sb.from('catalog_variants').select('*').eq('item_id', id).order('position').order('created_at'), toVariant),
    optional(sb.from('catalog_options').select('*').eq('item_id', id).order('position'), toOption),
    optional(sb.from('catalog_media').select('*').eq('item_id', id).order('position').order('created_at'), toMedia),
    optional(sb.from('catalog_field_defs').select('*').order('position').order('created_at'), toFieldDef),
  ]);
  if (it.error) return fail(it.error, 'המוצר לא נטען — בדקו את החיבור ונסו שוב.');
  if (!it.data) return { ok: false, error: 'המוצר לא נמצא (אולי נמחק, או שהוא של עסק אחר).' };
  const bad = [va, op, me, fd].find((x) => x.error);
  if (bad) return fail(bad.error, 'המוצר לא נטען — בדקו את החיבור ונסו שוב.');
  return { ok: true, data: { item: toCatalogItem(it.data), variants: va.rows, options: op.rows, media: me.rows, fields: fd.rows, ready: ![va, op, me, fd].some((x) => x.missing) } };
}

/** a new item (the signed-in member is "who created it"; the database files it under the business they work in) */
export async function insertItem(userId: string, cols: Record<string, unknown>, sort: number): Promise<Result<CatalogItem>> {
  const { data, error } = await supabase().from('catalog_items').insert({ user_id: userId, sort, ...cols }).select('*').single();
  return error ? fail(error) : { ok: true, data: toCatalogItem(data) };
}
/** only the changed columns of an item (nothing changed → the item as it is) */
export async function updateItem(id: string, cols: Record<string, unknown>): Promise<Result<CatalogItem>> {
  const sb = supabase();
  const { data, error } = Object.keys(cols).length
    ? await sb.from('catalog_items').update(cols).eq('id', id).select('*').single()
    : await sb.from('catalog_items').select('*').eq('id', id).single();
  return error ? fail(error) : { ok: true, data: toCatalogItem(data) };
}
export async function setPublished(id: string, on: boolean): Promise<Result<CatalogItem>> { return updateItem(id, { publish_online: on }); }

/** the options of an item (positions 1–3): a filled one is saved, an emptied one is removed */
export async function saveOptions(itemId: string, options: { position: number; name: string; choices: string[] }[]): Promise<Result<true>> {
  const sb = supabase();
  const keep = options.filter((o) => o.name.trim() && o.choices.length);
  if (keep.length) {
    const { error } = await sb.from('catalog_options').upsert(keep.map((o) => ({ item_id: itemId, position: o.position, name: o.name.trim(), choices: o.choices })), { onConflict: 'item_id,position' });
    if (error) return fail(error);
  }
  const drop = [1, 2, 3].filter((p) => !keep.some((o) => o.position === p));
  if (drop.length) { const { error } = await sb.from('catalog_options').delete().eq('item_id', itemId).in('position', drop); if (error) return fail(error); }
  return { ok: true, data: true };
}
export async function createVariants(itemId: string, combos: string[][], firstPosition: number): Promise<Result<CatalogVariant[]>> {
  if (!combos.length) return { ok: true, data: [] };
  const { data, error } = await supabase().from('catalog_variants')
    .insert(combos.map((c, k) => ({ item_id: itemId, option1: c[0] ?? '', option2: c[1] ?? '', option3: c[2] ?? '', position: firstPosition + k })))
    .select('*');
  return error ? fail(error) : { ok: true, data: ((data ?? []) as any[]).map(toVariant) };
}
export async function updateVariant(id: string, cols: Record<string, unknown>): Promise<Result<CatalogVariant>> {
  const { data, error } = await supabase().from('catalog_variants').update(cols).eq('id', id).select('*').single();
  return error ? fail(error) : { ok: true, data: toVariant(data) };
}
export async function deleteVariant(id: string): Promise<Result<true>> {
  const { error } = await supabase().from('catalog_variants').delete().eq('id', id);
  return error ? fail(error) : { ok: true, data: true };
}
/** "קבלת סחורה" (add) / "ספירה" (set) of one variant — the variant and the item's sum move together, logged */
export async function adjustVariantStock(id: string, mode: 'add' | 'set', qty: number, note = ''): Promise<Result<number>> {
  const { data, error } = await supabase().rpc('adjust_variant_stock', { p_variant: id, p_mode: mode, p_qty: qty, p_note: note });
  return error ? fail(error) : { ok: true, data: Number(data) };
}
/** after counting every variant: the item's sum becomes the sum of its variants (units not assigned are dropped, logged) */
export async function reconcileVariantStock(itemId: string): Promise<Result<number>> {
  const { data, error } = await supabase().rpc('reconcile_variant_stock', { p_item: itemId, p_note: '' });
  return error ? fail(error) : { ok: true, data: Number(data) };
}
/** an item without variants: the stock functions of 2.50, unchanged */
export async function adjustItemStock(id: string, mode: 'add' | 'set', qty: number, note = ''): Promise<Result<number>> {
  const { data, error } = await supabase().rpc('adjust_stock', { p_item: id, p_mode: mode, p_qty: qty, p_note: note });
  return error ? fail(error) : { ok: true, data: Number(data) };
}

export async function addFieldDef(key: string, label: string, kind: 'text' | 'multiline', position: number): Promise<Result<FieldDef>> {
  const { data, error } = await supabase().from('catalog_field_defs').insert({ field_key: key, label: label.trim(), kind, position }).select('*').single();
  return error ? fail(error) : { ok: true, data: toFieldDef(data) };
}

/** a picture's alt text, order or variant (the browser may change these three; the picture itself is the server's) */
export async function updateMedia(id: string, cols: { alt?: string; position?: number; variant_id?: string | null }): Promise<Result<true>> {
  const { error } = await supabase().from('catalog_media').update(cols).eq('id', id);
  return error ? fail(error) : { ok: true, data: true };
}
/** pictures: through the server (signed uploads; deleting removes the files too) */
export async function mediaApi<T = any>(body: Record<string, unknown>): Promise<Result<T>> {
  try {
    const r = await fetch('/api/store/media', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data: j as T } : { ok: false, error: j.message || 'התמונות לא נשמרו — נסו שוב.' };
  } catch { return { ok: false, error: 'אין חיבור לשרת — בדקו את האינטרנט ונסו שוב.' }; }
}
/** an item and its pictures' files (the rows go with the item; the files would stay behind in the bucket) */
export async function deleteItem(id: string, hasPictures: boolean): Promise<Result<true>> {
  if (hasPictures) await mediaApi({ action: 'purge', itemId: id });
  const { error } = await supabase().from('catalog_items').delete().eq('id', id);
  return error ? fail(error) : { ok: true, data: true };
}

/** the business's own fields (a new product's editor) — and whether migration 3300 ran */
export async function loadFieldDefs(): Promise<Result<{ fields: FieldDef[]; ready: boolean }>> {
  const r = await optional(supabase().from('catalog_field_defs').select('*').order('position').order('created_at'), toFieldDef);
  return r.error ? fail(r.error) : { ok: true, data: { fields: r.rows, ready: !r.missing } };
}
/** the addresses already used in the store by this business's products (a new address must not repeat one) */
export async function takenSlugs(exceptId?: string): Promise<string[]> {
  const { data } = await supabase().from('catalog_items').select('id, slug').not('slug', 'is', null);
  return ((data ?? []) as { id: string; slug: string | null }[]).filter((r) => r.id !== exceptId && r.slug).map((r) => r.slug as string);
}
/** an item's alert level ("התראה מתחת ל-") — as the register's price list saves it */
export async function setLowStock(id: string, low: number): Promise<Result<true>> {
  const { error } = await supabase().from('catalog_items').update({ low_stock: low }).eq('id', id);
  return error ? fail(error) : { ok: true, data: true };
}
