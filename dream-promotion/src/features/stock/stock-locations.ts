/**
 * Stock by location (docs/FINANCE_ADDITIONS_HE.md T12ב; migration 20261011004700) — the rules the screens follow, in one place.
 *   a count      each location's count of each tracked item (no variant: all its units there) and of each of its variants
 *                (stock_by_location). An item's total is the sum of its locations; the main location's count is the rest.
 *   a transfer   an internal transfer note (not a tax document): sent — the units leave the source at once and are on the way —,
 *                then received at the destination (what arrived otherwise is a difference, with its reason), or cancelled (back).
 *   a count      a count of one location, line by line (from the phone); the owner approves, and only then the differences move.
 * Pure functions: the database moves the stock and decides (stock_move_at, the transfer and count functions); the screens ask.
 */
export interface StockRow { locationId: string; itemId: string; variantId: string | null; qty: number }
export const toStockRow = (r: any): StockRow => ({
  locationId: String(r.location_id), itemId: String(r.item_id), variantId: r.variant_id ? String(r.variant_id) : null, qty: Number(r.qty) || 0,
});
/** the key of an item (no variant) or of one of its variants */
export const stockKey = (itemId: string, variantId?: string | null) => `${itemId}|${variantId ?? ''}`;

/** one location's counts: key → units */
export function countsAt(rows: StockRow[], locationId: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) if (r.locationId === locationId) m.set(stockKey(r.itemId, r.variantId), r.qty);
  return m;
}
/** the count at a location (none there: 0) */
export const qtyAt = (rows: StockRow[], locationId: string, itemId: string, variantId: string | null = null) =>
  rows.find((r) => r.locationId === locationId && r.itemId === itemId && r.variantId === (variantId ?? null))?.qty ?? 0;
/** the total of an item (or a variant): the sum of its locations */
export const totalOf = (rows: StockRow[], itemId: string, variantId: string | null = null) =>
  rows.filter((r) => r.itemId === itemId && r.variantId === (variantId ?? null)).reduce((a, r) => a + r.qty, 0);

export type Level = 'ok' | 'low' | 'out';
/** at or under the alert level: low; nothing (or less): out */
export const levelOf = (qty: number, low: number): Level => (qty <= 0 ? 'out' : qty <= low ? 'low' : 'ok');

// ---- the register: the stock of its location -----------------------------------------------------------------------------------
/**
 * Does the register show the stock of its own location instead of the total? When the business works in more than one location,
 * when the caller is limited to some of them, or when the register is not at the main location. A business with one location
 * sees exactly what it saw before (its main location's count is the total anyway).
 */
export const registerAtLocation = (s: { multi: boolean; limited: boolean; businessId: string | null }, registerLocation: string | null) =>
  Boolean(registerLocation) && (s.multi || s.limited || registerLocation !== s.businessId);

/** the price list as a register sees it: a tracked item's (and its variants') units at the register's location */
export function atLocationStock<I extends { id: string; trackStock: boolean; stockQty: number }, V extends { id: string; itemId: string; stockQty: number }>(
  items: I[], variants: V[], rows: StockRow[], locationId: string,
): { items: I[]; variants: V[] } {
  const tracked = new Set(items.filter((i) => i.trackStock).map((i) => i.id));
  return {
    items: items.map((i) => (tracked.has(i.id) ? { ...i, stockQty: qtyAt(rows, locationId, i.id) } : i)),
    variants: variants.map((v) => (tracked.has(v.itemId) ? { ...v, stockQty: qtyAt(rows, locationId, v.itemId, v.id) } : v)),
  };
}

/**
 * The counts after a sale at a location (sign 1) or units back there (sign -1) — what stock_move_at does, for the screen at once:
 * the item's row there and, for a line of a variant, the variant's. A product with no row anywhere is not counted (nothing moves).
 */
export function moveRows(rows: StockRow[], locationId: string, lines: { itemId?: string | null; variantId?: string | null; qty: number }[], sign: 1 | -1 = 1): StockRow[] {
  const out = rows.map((r) => ({ ...r }));
  const counted = new Set(rows.map((r) => r.itemId));
  const variantsOf = new Set(rows.filter((r) => r.variantId).map((r) => stockKey(r.itemId, r.variantId)));
  const add = (itemId: string, variantId: string | null, d: number) => {
    const r = out.find((x) => x.locationId === locationId && x.itemId === itemId && x.variantId === variantId);
    if (r) r.qty += d; else out.push({ locationId, itemId, variantId, qty: d });
  };
  for (const l of lines) {
    const q = Math.floor(l.qty);
    if (!l.itemId || !(q > 0) || !counted.has(l.itemId)) continue;
    add(l.itemId, null, -sign * q);
    if (l.variantId && variantsOf.has(stockKey(l.itemId, l.variantId))) add(l.itemId, l.variantId, -sign * q);
  }
  return out;
}

// ---- low stock at each location, and where to bring it from -------------------------------------------------------------------
export interface StockItemLite { id: string; name: string; trackStock: boolean; lowStock: number; hasVariants: boolean; active?: boolean }
export interface StockVariantLite { id: string; itemId: string; label: string; lowStock: number | null; active: boolean }
export interface PlaceLite { id: string; name: string; active: boolean }
export interface LowAt {
  locationId: string; itemId: string; variantId: string | null; name: string; qty: number; low: number; level: Level;
  /** a transfer that would bring it over its alert level: from the location with the most to spare (above its own level) */
  suggest: { from: string; qty: number } | null;
}
/** what can be sent from a location without taking it to (or under) its own alert level */
const spare = (qty: number, low: number) => Math.max(0, qty - low);

/**
 * Every tracked product (each active variant of one that has them) at or under its alert level in an active location — the variant's
 * level, else the item's — emptiest first; with a suggestion: from the active location that has the most to spare, enough to bring it
 * over its level (or what there is to spare).
 */
export function lowStock(rows: StockRow[], items: StockItemLite[], variants: StockVariantLite[], places: PlaceLite[]): LowAt[] {
  const open = places.filter((p) => p.active);
  const out: LowAt[] = [];
  for (const it of items) {
    if (!it.trackStock || it.active === false) continue;
    const lines = it.hasVariants
      ? variants.filter((v) => v.itemId === it.id && v.active).map((v) => ({ variantId: v.id as string | null, name: `${it.name} · ${v.label}`, low: v.lowStock ?? it.lowStock }))
      : [{ variantId: null as string | null, name: it.name, low: it.lowStock }];
    for (const l of lines) {
      for (const p of open) {
        const qty = qtyAt(rows, p.id, it.id, l.variantId);
        const level = levelOf(qty, l.low);
        if (level === 'ok') continue;
        const need = l.low + 1 - qty;
        const best = open.filter((o) => o.id !== p.id)
          .map((o) => ({ from: o.id, spare: spare(qtyAt(rows, o.id, it.id, l.variantId), l.low) }))
          .filter((o) => o.spare > 0)
          .sort((a, b) => b.spare - a.spare || a.from.localeCompare(b.from))[0];
        out.push({ locationId: p.id, itemId: it.id, variantId: l.variantId, name: l.name, qty, low: l.low, level,
          suggest: best ? { from: best.from, qty: Math.min(need, best.spare) } : null });
      }
    }
  }
  return out.sort((a, b) => a.qty - b.qty || a.name.localeCompare(b.name, 'he') || a.locationId.localeCompare(b.locationId));
}

// ---- transfers -------------------------------------------------------------------------------------------------------------------
export type TransferStatus = 'sent' | 'received' | 'cancelled';
export const TRANSFER_STATUS_HE: Record<TransferStatus, string> = { sent: 'בדרך', received: 'התקבלה', cancelled: 'בוטלה' };
export interface TransferLine { itemId: string; variantId: string | null; name: string; variant: string; qty: number; received?: number; reason?: string }
export interface Transfer {
  id: string; number: number; from: string; to: string; status: TransferStatus; lines: TransferLine[]; note: string;
  sentAt: string; receivedAt: string | null; receivedNote: string; cancelledAt: string | null; cancelReason: string;
}
const toLine = (l: any): TransferLine => ({
  itemId: String(l.itemId), variantId: l.variantId ? String(l.variantId) : null, name: String(l.name ?? ''), variant: String(l.variant ?? ''),
  qty: Number(l.qty) || 0, ...(l.received != null ? { received: Number(l.received) } : {}), ...(l.reason ? { reason: String(l.reason) } : {}),
});
export const toTransfer = (r: any): Transfer => ({
  id: String(r.id), number: Number(r.number), from: String(r.from_location), to: String(r.to_location),
  status: (['sent', 'received', 'cancelled'].includes(r.status) ? r.status : 'sent') as TransferStatus,
  lines: Array.isArray(r.lines) ? r.lines.map(toLine) : [], note: String(r.note ?? ''), sentAt: String(r.sent_at ?? ''),
  receivedAt: r.received_at ?? null, receivedNote: String(r.received_note ?? ''), cancelledAt: r.cancelled_at ?? null, cancelReason: String(r.cancel_reason ?? ''),
});
export const lineName = (l: Pick<TransferLine, 'name' | 'variant'>) => (l.variant ? `${l.name} · ${l.variant}` : l.name);
/** "3 פריטים · 7 יחידות" */
export function transferSummary(t: Pick<Transfer, 'lines'>): string {
  const units = t.lines.reduce((a, l) => a + l.qty, 0);
  return `${t.lines.length === 1 ? 'פריט אחד' : `${t.lines.length} פריטים`} · ${units === 1 ? 'יחידה אחת' : `${units} יחידות`}`;
}
/** units on the way (sent, not yet received), by product */
export function onTheWay(transfers: Transfer[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of transfers) if (t.status === 'sent') for (const l of t.lines) m.set(stockKey(l.itemId, l.variantId), (m.get(stockKey(l.itemId, l.variantId)) ?? 0) + l.qty);
  return m;
}

export interface DraftLine { itemId: string; variantId: string | null; qty: number }
/** the checks before sending (the database checks them again) */
export function transferError(from: string | null, to: string | null, lines: DraftLine[], items: Pick<StockItemLite, 'id' | 'name' | 'trackStock' | 'hasVariants'>[]): string | null {
  if (!from || !to) return 'בוחרים מאיפה ולאן.';
  if (from === to) return 'מעבירים מסניף אחד לסניף אחר.';
  if (!lines.length) return 'מוסיפים לפחות מוצר אחד.';
  if (lines.length > 200) return 'עד 200 שורות בהעברה.';
  for (const l of lines) {
    const it = items.find((i) => i.id === l.itemId);
    if (!it) return 'מוצר שלא נמצא.';
    if (!Number.isInteger(l.qty) || l.qty <= 0 || l.qty > 999999) return `${it.name}: כמות ביחידות שלמות, יותר מאפס.`;
    if (!it.trackStock) return `${it.name}: המלאי שלו לא נספר — סופרים אותו קודם.`;
    if (it.hasVariants && !l.variantId) return `${it.name}: בוחרים מידה / צבע.`;
  }
  const keys = lines.map((l) => stockKey(l.itemId, l.variantId));
  if (new Set(keys).size !== keys.length) return 'אותו מוצר פעמיים — מאחדים לשורה אחת.';
  return null;
}

export interface Received { received: number; reason: string }
/** the receipt's differences: every line where what arrived is not what was sent — each needs its reason */
export function receiptGaps(lines: TransferLine[], got: Record<string, Received | undefined>): { key: string; name: string; gap: number; reason: string }[] {
  return lines.map((l) => {
    const k = stockKey(l.itemId, l.variantId), g = got[k];
    const received = g ? g.received : l.qty;
    return { key: k, name: lineName(l), gap: received - l.qty, reason: (g?.reason ?? '').trim() };
  }).filter((x) => x.gap !== 0);
}
export function receiptError(lines: TransferLine[], got: Record<string, Received | undefined>): string | null {
  for (const l of lines) {
    const g = got[stockKey(l.itemId, l.variantId)];
    if (g && (!Number.isInteger(g.received) || g.received < 0 || g.received > 999999)) return `${lineName(l)}: כמה הגיע — ביחידות שלמות.`;
  }
  const missing = receiptGaps(lines, got).find((x) => !x.reason);
  return missing ? `${missing.name}: ${missing.gap < 0 ? `חסרות ${-missing.gap}` : `הגיעו ${missing.gap} יותר`} — כותבים למה.` : null;
}
/** what the database is sent: only the lines that differ (the rest arrived as sent) */
export const receiptPayload = (lines: TransferLine[], got: Record<string, Received | undefined>) =>
  receiptGaps(lines, got).map((x) => {
    const l = lines.find((y) => stockKey(y.itemId, y.variantId) === x.key)!;
    return { itemId: l.itemId, variantId: l.variantId, received: l.qty + x.gap, reason: x.reason };
  });

// ---- counts ----------------------------------------------------------------------------------------------------------------------
export type CountStatus = 'open' | 'approved' | 'cancelled';
export const COUNT_STATUS_HE: Record<CountStatus, string> = { open: 'פתוחה', approved: 'אושרה', cancelled: 'בוטלה' };
export interface CountLine { itemId: string; variantId: string | null; counted: number; at: string }
export interface CountResult { itemId: string; variantId: string | null; counted: number; expected: number; gap: number }
export interface Count {
  id: string; number: number; locationId: string; status: CountStatus; lines: CountLine[]; note: string; createdBy: string | null;
  createdAt: string; approvedAt: string | null; result: CountResult[] | null;
}
export const toCount = (r: any): Count => ({
  id: String(r.id), number: Number(r.number), locationId: String(r.location_id),
  status: (['open', 'approved', 'cancelled'].includes(r.status) ? r.status : 'open') as CountStatus,
  lines: r.lines && typeof r.lines === 'object' ? Object.values(r.lines as Record<string, any>).map((l) => ({
    itemId: String(l.itemId), variantId: l.variantId ? String(l.variantId) : null, counted: Number(l.counted) || 0, at: String(l.at ?? ''),
  })) : [],
  note: String(r.note ?? ''), createdBy: r.created_by ?? null, createdAt: String(r.created_at ?? ''), approvedAt: r.approved_at ?? null,
  result: Array.isArray(r.result) ? r.result.map((x: any) => ({ itemId: String(x.itemId), variantId: x.variantId ? String(x.variantId) : null,
    counted: Number(x.counted), expected: Number(x.expected), gap: Number(x.gap) })) : null,
});
export const toCountResult = (r: any): CountResult => ({
  itemId: String(r.item_id), variantId: r.variant_id ? String(r.variant_id) : null, counted: Number(r.counted), expected: Number(r.expected), gap: Number(r.gap),
});

export interface CountRow { key: string; itemId: string; variantId: string | null; name: string; counted: number | null }
/**
 * The count's list: every product whose stock is counted — each active variant of one that has them — and products that are
 * not counted yet (counting starts it); with what was counted so far. In the catalog's order: a person walking the shelves finds
 * the next one; the screen marks what is done.
 */
export function countList(items: (StockItemLite & { kind?: string })[], variants: StockVariantLite[], count: Pick<Count, 'lines'>): CountRow[] {
  const got = new Map(count.lines.map((l) => [stockKey(l.itemId, l.variantId), l.counted]));
  const out: CountRow[] = [];
  for (const it of items) {
    if (it.active === false || !(it.trackStock || it.kind === 'product')) continue;
    if (it.hasVariants) {
      for (const v of variants.filter((x) => x.itemId === it.id && x.active)) {
        const k = stockKey(it.id, v.id);
        out.push({ key: k, itemId: it.id, variantId: v.id, name: `${it.name} · ${v.label}`, counted: got.get(k) ?? null });
      }
    } else {
      const k = stockKey(it.id, null);
      out.push({ key: k, itemId: it.id, variantId: null, name: it.name, counted: got.get(k) ?? null });
    }
  }
  return out;
}
/** the summary before approval: what matched, what is short or over, and how many were not counted (they stay as they are) */
export function countSummary(results: CountResult[], listed: number) {
  const short = results.filter((r) => r.gap < 0), over = results.filter((r) => r.gap > 0);
  return { counted: results.length, matched: results.length - short.length - over.length, short: short.length, over: over.length,
    unitsShort: short.reduce((a, r) => a - r.gap, 0), unitsOver: over.reduce((a, r) => a + r.gap, 0), notCounted: Math.max(0, listed - results.length) };
}

export interface CodeItem { id: string; name: string; sku?: string; barcode?: string; hasVariants: boolean; active?: boolean }
export interface CodeVariant { id: string; itemId: string; sku?: string; barcode?: string; active: boolean }
/** what was scanned or typed: a barcode or a SKU — of a variant first, then of an item (one without variants); else nothing */
export function findByCode(code: string, items: CodeItem[], variants: CodeVariant[]): { itemId: string; variantId: string | null } | null {
  const c = code.trim().toLowerCase();
  if (!c) return null;
  const same = (x?: string) => Boolean(x) && x!.trim().toLowerCase() === c;
  const v = variants.find((x) => x.active && (same(x.barcode) || same(x.sku)));
  if (v && items.some((i) => i.id === v.itemId && i.active !== false)) return { itemId: v.itemId, variantId: v.id };
  const it = items.find((i) => i.active !== false && !i.hasVariants && (same(i.barcode) || same(i.sku)));
  return it ? { itemId: it.id, variantId: null } : null;
}

// ---- the database's refusals in Hebrew ---------------------------------------------------------------------------------------------
export const STOCK_MIGRATION = 'מלאי לפי סניף עוד לא הופעל במסד הנתונים (מיגרציה 20261011004700).';
export function stockErrorHe(e: unknown): string {
  const m = `${(e as any)?.message ?? e ?? ''}\n${(e as any)?.code ?? ''}\n${(e as any)?.details ?? ''}`;
  const named = (k: string) => new RegExp(`${k}: ?([^\\n]*)`).exec(m)?.[1]?.trim() ?? '';
  if (/stock_by_location|stock_adjust|stock_transfer_|stock_count_|stock_transfers|stock_counts|PGRST202|PGRST205|42883|42P01|schema cache/i.test(m)) return STOCK_MIGRATION;
  if (/transfer_same/.test(m)) return 'מעבירים מסניף אחד לסניף אחר.';
  if (/transfer_location/.test(m)) return 'מעבירים בין שני סניפים פתוחים של העסק.';
  if (/transfer_lines/.test(m)) return 'בכל שורה — מוצר וכמות ביחידות שלמות.';
  if (/transfer_untracked/.test(m)) return `${named('transfer_untracked')}: המלאי שלו לא נספר — סופרים אותו קודם.`;
  if (/transfer_variant_required/.test(m)) return `${named('transfer_variant_required')}: בוחרים מידה / צבע.`;
  if (/transfer_variant|transfer_item/.test(m)) return 'מוצר שלא נמצא בעסק.';
  if (/reserved_for_online/.test(m)) return `${named('reserved_for_online')}: היחידות שמורות להזמנה באתר — אי אפשר להעביר אותן.`;
  if (/transfer_gap_reason/.test(m)) return `${named('transfer_gap_reason')}: הגיע משהו אחר ממה שנשלח — כותבים למה.`;
  if (/transfer_received/.test(m)) return 'ההעברה כבר התקבלה — אי אפשר לבטל אותה.';
  if (/transfer_cancelled/.test(m)) return 'ההעברה בוטלה.';
  if (/transfer_cancel_reason/.test(m)) return 'כותבים למה מבטלים.';
  if (/count_open/.test(m)) return 'יש כבר ספירה פתוחה בסניף הזה — ממשיכים אותה.';
  if (/count_closed/.test(m)) return 'הספירה כבר נסגרה.';
  if (/count_empty/.test(m)) return 'עוד לא נספר כלום.';
  if (/the owner approves/.test(m)) return 'רק הבעלים מאשרים ספירה.';
  if (/variant_required/.test(m)) return 'מוצר עם מידות / צבעים נספר לכל וריאנט.';
  if (/stock_location/.test(m)) return 'סניף שלא נמצא בעסק.';
  if (/business_locked/.test(m)) return 'העסק נעול כרגע.';
  if (/zero or more/.test(m)) return 'ספירה היא אפס או יותר.';
  if (/at least one unit/.test(m)) return 'קבלה מוסיפה לפחות יחידה אחת.';
  if (/42501|not allowed|row-level security|permission denied/i.test(m)) return 'אין הרשאה לפעולה הזו.';
  return 'משהו השתבש. נסו שוב.';
}
