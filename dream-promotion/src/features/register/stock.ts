import type { Line } from './money';

/**
 * Stock of products ("מלאי"). Only items with track_stock count; quantities are whole units.
 * The database moves the stock (a trigger on every sale, refund with "back to stock", cancel) and logs
 * every movement — this module mirrors the same rules for the screen (instant update, alerts).
 */
export interface StockItem { id: string; name: string; trackStock: boolean; stockQty: number; lowStock: number }
export type StockLevel = 'ok' | 'low' | 'out';

/** units per price-list item in these lines (lines without an item — free amounts — do not count) */
export function stockDeltas(lines: Pick<Line, 'itemId' | 'qty'>[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) if (l.itemId && l.qty > 0) m.set(l.itemId, (m.get(l.itemId) ?? 0) + Math.floor(l.qty));
  return m;
}

/** the price list after a sale (sign 1) or a return to stock (sign -1) — what the database does, for the screen */
export function applyStock<T extends StockItem>(items: T[], lines: Pick<Line, 'itemId' | 'qty'>[], sign: 1 | -1 = 1): T[] {
  const d = stockDeltas(lines);
  return items.map((i) => (i.trackStock && d.has(i.id) ? { ...i, stockQty: i.stockQty - sign * d.get(i.id)! } : i));
}

export function stockLevel(i: Pick<StockItem, 'trackStock' | 'stockQty' | 'lowStock'>): StockLevel {
  if (!i.trackStock) return 'ok';
  if (i.stockQty <= 0) return 'out';
  return i.stockQty <= i.lowStock ? 'low' : 'ok';
}

/** tracked items that are running out — the alert list, emptiest first */
export const lowStockList = <T extends StockItem>(items: T[]) =>
  items.filter((i) => stockLevel(i) !== 'ok').sort((a, b) => a.stockQty - b.stockQty || a.name.localeCompare(b.name, 'he'));

export function stockText(i: Pick<StockItem, 'trackStock' | 'stockQty' | 'lowStock'>): string {
  if (!i.trackStock) return '';
  if (i.stockQty < 0) return `חסר במלאי (${i.stockQty})`;
  if (i.stockQty === 0) return 'אזל מהמלאי';
  return i.stockQty === 1 ? 'נשארה יחידה אחת' : `${stockLevel(i) === 'low' ? 'נשארו' : 'במלאי'} ${i.stockQty}`;
}

/** "+ קבלת סחורה" adds units; "ספירת מלאי" sets the counted number. Whole, non-negative units only. */
export function planAdjust(current: number, mode: 'add' | 'set', qty: number): { ok: true; delta: number; after: number } | { ok: false; error: string } {
  if (!Number.isFinite(qty) || Math.floor(qty) !== qty) return { ok: false, error: 'כמות בשלמים בלבד' };
  if (mode === 'add') return qty > 0 ? { ok: true, delta: qty, after: current + qty } : { ok: false, error: 'כמה יחידות התקבלו?' };
  return qty >= 0 ? { ok: true, delta: qty - current, after: qty } : { ok: false, error: 'הספירה לא יכולה להיות שלילית' };
}

export const MOVE_HE: Record<string, string> = { sale: 'מכירה', refund: 'החזר למלאי', cancel: 'ביטול מכירה', receive: 'קבלת סחורה', count: 'ספירת מלאי', adjust: 'תיקון' };

// ---- units held for orders on the site (2.56) ----------------------------------------------------------------------------------
/**
 * The owner's decision (6.10.2026): a unit held for an order on the site is not sold at the register. The database refuses
 * such a sale (c_sales_reserved); these give the screen the same answer first. A sale that touches no held unit behaves
 * exactly as before — negative stock included.
 */
export interface Held { item_id: string; variant_id: string | null; qty: number }
export interface HeldMap { byItem: Map<string, number>; byVariant: Map<string, number> }
export function heldMap(rows: Held[] | null | undefined): HeldMap {
  const byItem = new Map<string, number>(), byVariant = new Map<string, number>();
  for (const r of rows ?? []) {
    const q = Math.max(0, Math.floor(Number(r.qty) || 0));
    if (!r.item_id || !q) continue;
    byItem.set(r.item_id, (byItem.get(r.item_id) ?? 0) + q);
    if (r.variant_id) byVariant.set(r.variant_id, (byVariant.get(r.variant_id) ?? 0) + q);
  }
  return { byItem, byVariant };
}
export const heldOf = (h: HeldMap, itemId: string, variantId?: string | null) => (variantId ? h.byVariant.get(variantId) ?? 0 : h.byItem.get(itemId) ?? 0);

/** the first line ("name") that would take held units, or null — the database's rule, line by item and variant */
export function heldConflict(
  lines: Pick<Line, 'itemId' | 'variantId' | 'qty' | 'name'>[],
  items: Pick<StockItem, 'id' | 'trackStock' | 'stockQty'>[],
  variants: { id: string; itemId: string; stockQty: number }[],
  h: HeldMap,
): string | null {
  const want = new Map<string, { item: string; variant: string | null; qty: number; name: string }>();
  for (const l of lines) {
    if (!l.itemId || !(l.qty > 0)) continue;
    const v = l.variantId ?? null, k = `${l.itemId}|${v ?? ''}`;
    const w = want.get(k) ?? { item: l.itemId, variant: v, qty: 0, name: l.name };
    w.qty += Math.floor(l.qty); want.set(k, w);
  }
  for (const w of want.values()) {
    const it = items.find((i) => i.id === w.item);
    if (!it?.trackStock) continue;
    const v = w.variant ? variants.find((x) => x.id === w.variant && x.itemId === it.id) : undefined;
    const held = heldOf(h, it.id, v?.id ?? null);
    if (!held) continue;
    const have = v ? v.stockQty : it.stockQty;
    if (w.qty > have - held) return w.name;
  }
  return null;
}
