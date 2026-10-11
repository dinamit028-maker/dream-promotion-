/**
 * Serial numbers (2.93, migration 20261011004800 — T12ג of docs/FINANCE_ADDITIONS_HE.md): a product marked "עם מספר סידורי"
 * has a number for every unit (catalog_serials) and a history for each (catalog_serial_events). Pure functions only (no React,
 * no network) — the screens and the tests use the same ones (tests/serials.test.ts).
 *
 * Rules (the database keeps the same ones — it is the one that decides):
 *  - a number is of one product (any case: "ab-1" is "AB-1"), trimmed, 1–64 characters; up to 200 in one list;
 *  - the register sells a unit by its number: in stock at the register's location, sold once (the DoD: never twice);
 *  - a cancel brings the numbers back where they were sold; a refund names the numbers that came back;
 *  - between locations they go in a transfer, by number; only the owner writes a unit off (with a reason);
 *  - such a product is not on the site, is not counted in a stock count (its units are checked by number), and does not
 *    move on a document or an expense — the register and "קליטה" move it.
 */

export type SerialStatus = 'in_stock' | 'in_transit' | 'sold' | 'returned' | 'removed';
export const SERIAL_STATUS_HE: Record<SerialStatus, string> = {
  in_stock: 'במלאי', in_transit: 'בדרך (בהעברה)', sold: 'נמכר', returned: 'הוחזר — לא במלאי', removed: 'הוצא מהמלאי',
};
export type SerialEventKind = 'received' | 'registered' | 'sold' | 'cancelled' | 'returned' | 'removed'
  | 'transfer_sent' | 'transfer_received' | 'transfer_missing' | 'transfer_cancelled';
export const SERIAL_EVENT_HE: Record<SerialEventKind, string> = {
  received: 'נקלט', registered: 'נרשם (היה במלאי)', sold: 'נמכר', cancelled: 'המכירה בוטלה — חזר למלאי', returned: 'הוחזר',
  removed: 'הוצא מהמלאי', transfer_sent: 'יצא בהעברה', transfer_received: 'הגיע בהעברה', transfer_missing: 'לא הגיע בהעברה',
  transfer_cancelled: 'ההעברה בוטלה — חזר',
};
export const SERIAL_LIMITS = { serial: 64, list: 200, reason: 200 } as const;
export const MIGRATION_4800 = 'צריך להריץ את מיגרציה 20261011004800 (מספרים סידוריים, מחירונים, מק״ט מונה והשוואת סניפים) ב-Supabase.';

export interface Serial {
  id: string; itemId: string; variantId: string | null; serial: string; status: SerialStatus; locationId: string;
  saleId: string | null; receivedAt: string; updatedAt: string;
}
export interface SerialEvent {
  id: number; serialId: string; kind: SerialEventKind; locationId: string | null; saleId: string | null; refundId: string | null;
  transferId: string | null; note: string; at: string;
}
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const STATUSES: SerialStatus[] = ['in_stock', 'in_transit', 'sold', 'returned', 'removed'];
const KINDS = Object.keys(SERIAL_EVENT_HE) as SerialEventKind[];
export const toSerial = (r: any): Serial => ({
  id: str(r.id), itemId: str(r.item_id), variantId: r.variant_id ? str(r.variant_id) : null, serial: str(r.serial),
  status: STATUSES.includes(r.status) ? r.status : 'removed', locationId: str(r.location_id), saleId: r.sale_id ? str(r.sale_id) : null,
  receivedAt: str(r.received_at), updatedAt: str(r.updated_at),
});
export const toSerialEvent = (r: any): SerialEvent => ({
  id: Number(r.id) || 0, serialId: str(r.serial_id), kind: KINDS.includes(r.kind) ? r.kind : 'received', locationId: r.location_id ? str(r.location_id) : null,
  saleId: r.sale_id ? str(r.sale_id) : null, refundId: r.refund_id ? str(r.refund_id) : null, transferId: r.transfer_id ? str(r.transfer_id) : null,
  note: str(r.note), at: str(r.at),
});

/** the same number in any case */
export const sameSerial = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A list as it is typed or scanned — one a line (a scanner types the number and Enter), or with commas: trimmed, empty lines
 * dropped. The first problem in Hebrew (the database checks the same: serial_list).
 */
export function parseSerials(text: string): { ok: true; serials: string[] } | { ok: false; error: string } {
  const out: string[] = [];
  for (const raw of text.split(/[\n\r,;\t]+/)) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > SERIAL_LIMITS.serial) return { ok: false, error: `מספר ארוך מדי (עד ${SERIAL_LIMITS.serial} תווים): ${s.slice(0, 20)}…` };
    if (out.some((x) => sameSerial(x, s))) return { ok: false, error: `המספר ${s} מופיע פעמיים ברשימה.` };
    out.push(s);
  }
  if (!out.length) return { ok: false, error: 'לא הוזן אף מספר סידורי.' };
  if (out.length > SERIAL_LIMITS.list) return { ok: false, error: `עד ${SERIAL_LIMITS.list} מספרים בפעם אחת (הוזנו ${out.length}).` };
  return { ok: true, serials: out };
}

/**
 * a line's name with its numbers — on a sale's document and the refund slip: "טלפון · מס׳ סידורי: A1, A2". A document's line
 * holds up to 300 characters (the database's limit): a long list ends with "ועוד N" (the sale itself keeps every number).
 */
export function withSerials(name: string, serials?: readonly string[] | null, max = 300): string {
  const list = (serials ?? []).filter((s) => s.trim());
  if (!list.length) return name;
  const head = `${name} · מס׳ סידורי: `;
  for (let n = list.length; n > 0; n--) {
    const text = head + list.slice(0, n).join(', ') + (n < list.length ? ` ועוד ${list.length - n}` : '');
    if (text.length <= max) return text;
  }
  return name.slice(0, max);
}

/** the numbers in stock at a location (of a variant, when the product has variants), sorted as people read them */
export function serialsHere(serials: Serial[], itemId: string, locationId: string, variantId?: string | null): Serial[] {
  return serials.filter((s) => s.itemId === itemId && s.status === 'in_stock' && s.locationId === locationId
      && (variantId === undefined || s.variantId === (variantId ?? null)))
    .sort((a, b) => a.serial.localeCompare(b.serial, 'he', { numeric: true }));
}

/** units at a location that have no number yet (they were in stock before the numbers): its count less the numbers there */
export function unnumbered(stockAt: number, serials: Serial[], itemId: string, locationId: string, variantId: string | null): number {
  return Math.max(0, stockAt - serialsHere(serials, itemId, locationId, variantId).length);
}

/**
 * The register's cart: a number picked for a product goes on its line (one line a product / variant; its quantity = its
 * numbers). The same number twice is refused here first (the database refuses it anyway).
 */
export interface SerialLine { itemId?: string; variantId?: string; qty: number; serials?: string[] }
export function addSerialToLines<L extends SerialLine>(lines: L[], make: () => L, match: (l: L) => boolean, serial: string):
  { ok: true; lines: L[] } | { ok: false; error: string } {
  if (lines.some((l) => (l.serials ?? []).some((s) => sameSerial(s, serial)))) return { ok: false, error: `המספר ${serial} כבר בסל.` };
  const i = lines.findIndex(match);
  if (i < 0) {
    const l = make();
    return { ok: true, lines: [...lines, { ...l, qty: 1, serials: [serial] }] };
  }
  return { ok: true, lines: lines.map((l, k) => (k === i ? { ...l, serials: [...(l.serials ?? []), serial], qty: (l.serials ?? []).length + 1 } : l)) };
}
/** a number taken off its line (the line goes when it has none left) */
export function removeSerialFromLines<L extends SerialLine>(lines: L[], serial: string): L[] {
  return lines.map((l) => {
    if (!(l.serials ?? []).some((s) => sameSerial(s, serial))) return l;
    const left = (l.serials ?? []).filter((s) => !sameSerial(s, serial));
    return { ...l, serials: left, qty: left.length };
  }).filter((l) => !(l.serials && l.qty <= 0));
}

/** a refund of a sale's line with numbers: which of them came back (as the screen ticks them) — the quantity follows */
export function refundSerials(sold: readonly string[], picked: readonly string[]): string[] {
  return sold.filter((s) => picked.some((p) => sameSerial(p, s)));
}

/** the history of one number, newest first, in words: "נמכר · סניף דיזנגוף · 11/10/2026 14:05 — …" (the screen formats the date) */
export function historyLine(e: Pick<SerialEvent, 'kind' | 'note'>, where: string): string {
  return [SERIAL_EVENT_HE[e.kind], where, e.note].filter(Boolean).join(' · ');
}

/** a refusal of the database about serial numbers, in Hebrew (null: not one of these) */
export function serialError(e: { message?: string; code?: string } | null | undefined): string | null {
  const m = `${e?.message ?? ''} ${e?.code ?? ''}`;
  const tail = (k: string) => (m.match(new RegExp(`${k}: ([^\\n]+?)(?:\\s+(?:\\d{5}|P0001))?\\s*$`))?.[1] ?? '').trim();
  if (/does not exist|schema cache|PGRST20[2-5]|42883|42703/i.test(m) && /serial|price_list|sku_series|sku_next|location_compare|track_serials/i.test(m)) return MIGRATION_4800;
  if (/serial_sold/.test(m)) return `המספר ${tail('serial_sold')} כבר נמכר — מספר סידורי לא נמכר פעמיים.`;
  if (/serial_not_found/.test(m)) return `המספר ${tail('serial_not_found')} לא קיים למוצר הזה.`;
  if (/serial_variant/.test(m)) return `המספר ${tail('serial_variant')} שייך לווריאנט אחר של המוצר.`;
  if (/serial_elsewhere/.test(m)) return `המספר ${tail('serial_elsewhere')} במלאי בסניף אחר — מעבירים אותו קודם בהעברה.`;
  if (/serial_not_in_stock/.test(m)) return `המספר ${tail('serial_not_in_stock')} לא במלאי (בדרך, הוחזר או הוצא).`;
  if (/serial_required/.test(m)) return `${tail('serial_required') || 'המוצר'}: בוחרים מספר סידורי לכל יחידה.`;
  if (/serial_not_in_sale/.test(m)) return `המספר ${tail('serial_not_in_sale')} לא נמכר בעסקה הזו (או שכבר הוחזר).`;
  if (/serial_taken/.test(m)) return `המספר ${tail('serial_taken')} כבר קיים למוצר הזה.`;
  if (/serial_twice/.test(m)) return `המספר ${tail('serial_twice')} מופיע פעמיים ברשימה.`;
  if (/serial_long/.test(m)) return `מספר סידורי — עד ${SERIAL_LIMITS.serial} תווים.`;
  if (/serial_list/.test(m)) return `בין 1 ל-${SERIAL_LIMITS.list} מספרים בפעם אחת.`;
  if (/serial_more_than_stock/.test(m)) return `יש כאן רק ${tail('serial_more_than_stock').replace(/\D.*$/, '') || '0'} יחידות בלי מספר — לרישום יחידות חדשות: "קליטה עם מספרים".`;
  if (/serial_untracked/.test(m)) return 'למוצר הזה אין מספרים סידוריים — מסמנים "עם מספר סידורי" קודם.';
  if (/serial_kind/.test(m)) return 'מספר סידורי — רק למוצר (לא לשירות או חבילה).';
  if (/serial_online/.test(m) || /catalog_items_serials_check/.test(m)) return 'מוצר עם מספרים סידוריים לא נמכר באתר (עדיין) — מכבים "פרסם באתר" קודם.';
  if (/serial_counting/.test(m)) return 'המוצר נמצא בספירת מלאי פתוחה — מסיימים או מבטלים אותה קודם.';
  if (/serial_on_the_way/.test(m)) return 'יחידות של המוצר בדרך בהעברה — מקבלים או מבטלים אותה קודם.';
  if (/serial_reserved/.test(m)) return 'יחידות של המוצר שמורות להזמנה באתר — מחכים שההזמנה תיסגר.';
  if (/serial_in_stock/.test(m)) return 'יש יחידות במלאי (או בדרך) עם מספרים — אי אפשר לבטל את המספרים הסידוריים.';
  if (/serial_reason/.test(m)) return 'למה היחידה יוצאת מהמלאי? (חובה)';
  if (/serial_item/.test(m)) return 'מוצר עם מספרים סידוריים זז רק עם המספרים: קליטה עם מספרים בעורך המוצר, מכירה בקופה, העברה עם מספרים.';
  if (/count_serial/.test(m)) return `${tail('count_serial') || 'המוצר'}: מוצר עם מספרים סידוריים נבדק לפי המספרים, לא בספירה.`;
  if (/transfer_serial_missing/.test(m)) return `${tail('transfer_serial_missing') || 'שורה'}: מסמנים איזה מספר לא הגיע.`;
  if (/transfer_serials/.test(m)) return `${tail('transfer_serials') || 'שורה'}: בוחרים מספר סידורי לכל יחידה שעוברת.`;
  return null;
}
