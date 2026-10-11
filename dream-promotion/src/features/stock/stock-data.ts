import { supabase } from '@/lib/supabase/client';
import {
  stockErrorHe, toCount, toCountResult, toStockRow, toTransfer, type Count, type CountResult, type DraftLine, type StockRow, type Transfer,
} from './stock-locations';

/**
 * The database's side of stock by location (migration 20261011004700): every location's count (stock_by_location), deliveries
 * and counts at a location, transfers and counts. Before the migration there is nothing — the stock screens work as before.
 */
type R<T> = { ok: true; data: T } | { ok: false; error: string };
const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: stockErrorHe(e) });

/** every location's count of every tracked item and variant (null: the migration is not in the database). The server answers up
 *  to 1000 rows at a time — a business with many products and locations has more, so they come page by page. */
export async function loadStockRows(): Promise<StockRow[] | null> {
  const PAGE = 1000, out: StockRow[] = [];
  for (let from = 0; from < 100_000; from += PAGE) {
    const { data, error } = await supabase().from('stock_by_location').select('location_id, item_id, variant_id, qty')
      .order('location_id').order('item_id').order('variant_id', { nullsFirst: true }).range(from, from + PAGE - 1);
    if (error) return null;
    out.push(...((data ?? []) as any[]).map(toStockRow));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

/** what is left at one location (null: the migration is not in the database) */
export async function loadStockAt(locationId: string): Promise<StockRow[] | null> {
  const { data, error } = await supabase().from('stock_by_location').select('location_id, item_id, variant_id, qty').eq('location_id', locationId).is('variant_id', null);
  return error ? null : ((data ?? []) as any[]).map(toStockRow);
}

/** one product's count at every location (null: the migration is not in the database) */
export async function loadItemStock(itemId: string): Promise<StockRow[] | null> {
  const { data, error } = await supabase().from('stock_by_location').select('location_id, item_id, variant_id, qty').eq('item_id', itemId);
  return error ? null : ((data ?? []) as any[]).map(toStockRow);
}

/** "+ קבלת סחורה" (add) / "ספירה" (set) at a location — returns the count there after */
export async function adjustAt(location: string, itemId: string, variantId: string | null, mode: 'add' | 'set', qty: number, note = ''): Promise<R<number>> {
  const { data, error } = await supabase().rpc('stock_adjust', { p_location: location, p_item: itemId, p_variant: variantId, p_mode: mode, p_qty: qty, p_note: note });
  return error ? fail(error) : { ok: true, data: Number(data) };
}

export async function loadTransfers(): Promise<R<Transfer[]>> {
  const { data, error } = await supabase().from('stock_transfers').select('*').order('sent_at', { ascending: false }).limit(100);
  return error ? fail(error) : { ok: true, data: ((data ?? []) as any[]).map(toTransfer) };
}
/** send: the id is chosen here — a second try is the same transfer */
export async function sendTransfer(from: string, to: string, lines: DraftLine[], note: string, id = crypto.randomUUID()): Promise<R<{ id: string; number: number }>> {
  const { data, error } = await supabase().rpc('stock_transfer_send', {
    p_id: id, p_from: from, p_to: to, p_lines: lines.map((l) => ({ itemId: l.itemId, variantId: l.variantId, qty: l.qty })), p_note: note.trim(),
  });
  return error ? fail(error) : { ok: true, data: { id: String((data as any)?.id ?? id), number: Number((data as any)?.number) } };
}
export async function receiveTransfer(id: string, lines: { itemId: string; variantId: string | null; received: number; reason: string }[], note = ''): Promise<R<{ gaps: number }>> {
  const { data, error } = await supabase().rpc('stock_transfer_receive', { p_id: id, p_lines: lines, p_note: note.trim() });
  return error ? fail(error) : { ok: true, data: { gaps: Number((data as any)?.gaps ?? 0) } };
}
export async function cancelTransfer(id: string, reason: string): Promise<R<true>> {
  const { error } = await supabase().rpc('stock_transfer_cancel', { p_id: id, p_reason: reason.trim() });
  return error ? fail(error) : { ok: true, data: true };
}

export async function loadCounts(): Promise<R<Count[]>> {
  const { data, error } = await supabase().from('stock_counts').select('*').order('created_at', { ascending: false }).limit(50);
  return error ? fail(error) : { ok: true, data: ((data ?? []) as any[]).map(toCount) };
}
export async function startCount(location: string, note = '', id = crypto.randomUUID()): Promise<R<{ id: string; number: number }>> {
  const { data, error } = await supabase().rpc('stock_count_start', { p_id: id, p_location: location, p_note: note.trim() });
  return error ? fail(error) : { ok: true, data: { id: String((data as any)?.id ?? id), number: Number((data as any)?.number) } };
}
/** one line of the count, as counted now (null: take it off) */
export async function setCountLine(count: string, itemId: string, variantId: string | null, counted: number | null): Promise<R<true>> {
  const { error } = await supabase().rpc('stock_count_set', { p_count: count, p_item: itemId, p_variant: variantId, p_counted: counted });
  return error ? fail(error) : { ok: true, data: true };
}
/** what the system expected when each line was counted, and the difference */
export async function countResults(count: string): Promise<R<CountResult[]>> {
  const { data, error } = await supabase().rpc('stock_count_lines', { p_count: count });
  return error ? fail(error) : { ok: true, data: ((data ?? []) as any[]).map(toCountResult) };
}
export async function approveCount(count: string, note = ''): Promise<R<{ moved: number }>> {
  const { data, error } = await supabase().rpc('stock_count_approve', { p_count: count, p_note: note.trim() });
  return error ? fail(error) : { ok: true, data: { moved: Number((data as any)?.moved ?? 0) } };
}
export async function cancelCount(count: string): Promise<R<true>> {
  const { error } = await supabase().rpc('stock_count_cancel', { p_count: count });
  return error ? fail(error) : { ok: true, data: true };
}

/** the products and variants the stock screens list (names, alert levels, codes) */
export interface StockCatalog {
  items: { id: string; name: string; kind: string; trackStock: boolean; lowStock: number; hasVariants: boolean; active: boolean; sku: string; barcode: string }[];
  variants: { id: string; itemId: string; label: string; lowStock: number | null; active: boolean; sku: string; barcode: string }[];
}
export async function loadStockCatalog(): Promise<R<StockCatalog>> {
  const [i, v] = await Promise.all([
    supabase().from('catalog_items').select('id, name, kind, track_stock, low_stock, has_variants, active, sku, barcode, sort').order('sort').order('name'),
    supabase().from('catalog_variants').select('id, item_id, option1, option2, option3, low_stock, active, sku, barcode, position').order('position'),
  ]);
  if (i.error) return fail(i.error);
  return { ok: true, data: {
    items: ((i.data ?? []) as any[]).filter((r) => r.kind === 'product' || r.track_stock).map((r) => ({
      id: String(r.id), name: String(r.name ?? ''), kind: String(r.kind ?? ''), trackStock: Boolean(r.track_stock), lowStock: Number(r.low_stock ?? 2),
      hasVariants: Boolean(r.has_variants), active: r.active !== false, sku: String(r.sku ?? ''), barcode: String(r.barcode ?? '') })),
    variants: v.error ? [] : ((v.data ?? []) as any[]).map((r) => ({
      id: String(r.id), itemId: String(r.item_id), label: [r.option1, r.option2, r.option3].filter((x: string) => x).join(' / '),
      lowStock: r.low_stock == null ? null : Number(r.low_stock), active: r.active !== false, sku: String(r.sku ?? ''), barcode: String(r.barcode ?? '') })),
  } };
}
