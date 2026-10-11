import { supabase } from '@/lib/supabase/client';
import { catalogError, toListPrice, toPriceList, toSkuSeries, type ListPrice, type PriceList, type SkuSeries } from './catalog';
import { MIGRATION_4800, serialError, toSerial, toSerialEvent, type Serial, type SerialEvent } from './serials';

/**
 * The database's side of the advanced items (2.93, migration 20261011004800 — T12ג): serial numbers, price lists, SKU series.
 * Written only through the database's functions (no table is written from here); read through the business's policies (a cashier
 * reads numbers and price lists — the register needs them). Before the migration there is nothing: every read answers "none"
 * (`ready: false`), and the screens look as before.
 */
type R<T> = { ok: true; data: T } | { ok: false; error: string };
const fail = (e: unknown, general = 'משהו השתבש. נסו שוב.'): { ok: false; error: string } =>
  ({ ok: false, error: serialError(e as any) ?? catalogError(e as any) ?? general });
const missing = (e: unknown) => serialError(e as any) === MIGRATION_4800 || /relation .* does not exist|schema cache|PGRST20[2-5]|42P01/i.test(`${(e as any)?.message ?? ''} ${(e as any)?.code ?? ''}`);

// ---- serial numbers ----------------------------------------------------------------------------------------------------------------
/** a product's numbers (every status) — null before the migration */
export async function loadItemSerials(itemId: string): Promise<R<Serial[]> | null> {
  const { data, error } = await supabase().from('catalog_serials').select('*').eq('item_id', itemId).order('received_at', { ascending: false }).limit(2000);
  if (error) return missing(error) ? null : fail(error);
  return { ok: true, data: ((data ?? []) as any[]).map(toSerial) };
}
/** the numbers in stock of these products at a location (the register's picker) — [] before the migration */
export async function loadSerialsInStock(itemIds: string[], locationId: string): Promise<Serial[]> {
  if (!itemIds.length) return [];
  const { data, error } = await supabase().from('catalog_serials').select('*').in('item_id', itemIds).eq('status', 'in_stock').eq('location_id', locationId).limit(5000);
  return error ? [] : ((data ?? []) as any[]).map(toSerial);
}
/** a number typed or scanned anywhere in the business (any case; part of it with 3 characters or more) */
export async function findSerials(q: string, exact = false): Promise<R<Serial[]> | null> {
  const t = q.trim();
  if (!t) return { ok: true, data: [] };
  const like = t.replace(/[\\%_]/g, (c) => `\\${c}`);
  const query = supabase().from('catalog_serials').select('*');
  const { data, error } = await (exact || t.length < 3 ? query.ilike('serial', like) : query.ilike('serial', `%${like}%`)).order('serial').limit(50);
  if (error) return missing(error) ? null : fail(error);
  return { ok: true, data: ((data ?? []) as any[]).map(toSerial) };
}
/** how many units with a number are in stock, by product and location (the stock screen's "מספרים סידוריים") — null before 4800 */
export async function loadSerialSummary(): Promise<{ itemId: string; variantId: string | null; locationId: string; count: number }[] | null> {
  const { data, error } = await supabase().from('catalog_serials').select('item_id, variant_id, location_id').eq('status', 'in_stock').limit(20000);
  if (error) return missing(error) ? null : [];
  const m = new Map<string, { itemId: string; variantId: string | null; locationId: string; count: number }>();
  for (const r of (data ?? []) as any[]) {
    const k = `${r.item_id}|${r.variant_id ?? ''}|${r.location_id}`;
    const cur = m.get(k) ?? { itemId: String(r.item_id), variantId: r.variant_id ? String(r.variant_id) : null, locationId: String(r.location_id), count: 0 };
    cur.count++; m.set(k, cur);
  }
  return [...m.values()];
}
/** one number's history, oldest first */
export async function loadSerialHistory(serialId: string): Promise<R<SerialEvent[]>> {
  const { data, error } = await supabase().from('catalog_serial_events').select('*').eq('serial_id', serialId).order('id');
  return error ? fail(error) : { ok: true, data: ((data ?? []) as any[]).map(toSerialEvent) };
}
export async function setSerialTracking(itemId: string, on: boolean): Promise<R<{ changed: boolean }>> {
  const { data, error } = await supabase().rpc('serial_tracking', { p_item: itemId, p_on: on });
  return error ? fail(error) : { ok: true, data: { changed: Boolean((data as any)?.changed) } };
}
/** units in with their numbers: new ones (the stock goes up) or ones already in stock (existing — the stock stays) */
export async function receiveSerials(itemId: string, variantId: string | null, locationId: string | null, serials: string[], existing: boolean, note = ''):
  Promise<R<{ count: number; stock: number }>> {
  const { data, error } = await supabase().rpc('serial_receive', {
    p_item: itemId, p_variant: variantId, p_location: locationId, p_serials: serials, p_existing: existing, p_note: note.trim(),
  });
  return error ? fail(error) : { ok: true, data: { count: Number((data as any)?.count ?? 0), stock: Number((data as any)?.stock ?? 0) } };
}
/** a unit written off (the owner only, with a reason) */
export async function removeSerial(serialId: string, reason: string): Promise<R<true>> {
  const { error } = await supabase().rpc('serial_remove', { p_serial: serialId, p_reason: reason.trim() });
  return error ? fail(error) : { ok: true, data: true };
}

// ---- price lists -------------------------------------------------------------------------------------------------------------------
export interface PriceBook { lists: PriceList[]; prices: ListPrice[] }
/** every list and its prices — null before the migration (the register and the documents price by the catalog, as before) */
export async function loadPriceBook(): Promise<PriceBook | null> {
  const sb = supabase();
  const [l, p] = await Promise.all([
    sb.from('price_lists').select('*').order('sort').order('name'),
    sb.from('price_list_items').select('list_id, item_id, variant_id, price').limit(20000),
  ]);
  if (l.error || p.error) return null;
  return { lists: ((l.data ?? []) as any[]).map(toPriceList), prices: ((p.data ?? []) as any[]).map(toListPrice) };
}
/** a list, new (its id chosen here: a second try is the same list) or changed — its kind and location never change */
export async function savePriceList(d: { id: string; name: string; kind: 'location' | 'group'; locationId: string | null; tag: string; active: boolean; sort: number }): Promise<R<true>> {
  const { error } = await supabase().rpc('price_list_save', {
    p_id: d.id, p_name: d.name.trim(), p_kind: d.kind, p_location: d.locationId, p_tag: d.tag.trim() || null, p_active: d.active, p_sort: d.sort,
  });
  return error ? fail(error) : { ok: true, data: true };
}
/** a list's prices: a number sets it, null takes it off (the base price again) — up to 500 a save */
export async function setListPrices(listId: string, lines: { itemId: string; variantId: string | null; price: number | null }[]): Promise<R<number>> {
  const { data, error } = await supabase().rpc('price_list_set', {
    p_list: listId, p_lines: lines.map((l) => ({ itemId: l.itemId, ...(l.variantId ? { variantId: l.variantId } : {}), price: l.price })),
  });
  return error ? fail(error) : { ok: true, data: Number((data as any)?.lines ?? 0) };
}

// ---- SKU series ----------------------------------------------------------------------------------------------------------------------
/** the series — null before the migration */
export async function loadSkuSeries(): Promise<SkuSeries[] | null> {
  const { data, error } = await supabase().from('sku_series').select('*').order('name');
  return error ? null : ((data ?? []) as any[]).map(toSkuSeries);
}
export async function saveSkuSeries(d: { id: string; name: string; prefix: string; digits: number; next: number | null; active: boolean }): Promise<R<true>> {
  const { error } = await supabase().rpc('sku_series_save', {
    p_id: d.id, p_name: d.name.trim(), p_prefix: d.prefix, p_digits: d.digits, p_next: d.next, p_active: d.active,
  });
  return error ? fail(error) : { ok: true, data: true };
}
/** the next free code of a series (never one a product has — the database decides) */
export async function nextSku(seriesId: string): Promise<R<string>> {
  const { data, error } = await supabase().rpc('sku_next', { p_series: seriesId });
  return error ? fail(error) : { ok: true, data: String(data) };
}
