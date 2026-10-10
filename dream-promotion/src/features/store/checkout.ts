/**
 * Selling on the site (Dream Commerce stage 3, 2.56.0) — the dashboard's pure rules: the checkout settings of a store, a
 * basic coupon, the payment terminal's keys, and what an order's statuses read as. The database checks every one of them
 * again (migration 20261006003500); these give the screen its messages before anything is sent.
 * Stage 3 is test only: an order paid on the provider's test terminal is "test_paid" — no sale, no stock movement, no
 * document, no customer in the CRM (DREAM_COMMERCE_ARCHITECTURE §6.5).
 */

// ---- the store's checkout settings -------------------------------------------------------------------------------------------
export interface CheckoutSettings {
  checkoutEnabled: boolean; reserveMinutes: number;
  pickupEnabled: boolean; pickupNote: string;
  deliveryEnabled: boolean; deliveryPrice: number; freeDeliveryOver: number | null; deliveryNote: string;
}
export const CHECKOUT_DEFAULTS: CheckoutSettings = {
  checkoutEnabled: false, reserveMinutes: 15, pickupEnabled: false, pickupNote: '', deliveryEnabled: false, deliveryPrice: 0,
  freeDeliveryOver: null, deliveryNote: '',
};
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

export function toCheckout(r: any): CheckoutSettings {
  if (!r) return { ...CHECKOUT_DEFAULTS };
  return {
    checkoutEnabled: Boolean(r.checkout_enabled), reserveMinutes: Number(r.reserve_minutes ?? 15),
    pickupEnabled: Boolean(r.pickup_enabled), pickupNote: String(r.pickup_note ?? ''),
    deliveryEnabled: Boolean(r.delivery_enabled), deliveryPrice: Number(r.delivery_price ?? 0),
    freeDeliveryOver: num(r.free_delivery_over), deliveryNote: String(r.delivery_note ?? ''),
  };
}

export interface CheckoutForm {
  reserveMinutes: string; pickupEnabled: boolean; pickupNote: string; deliveryEnabled: boolean; deliveryPrice: string;
  freeDeliveryOver: string; deliveryNote: string;
}
export type CheckoutPatch = {
  reserve_minutes: number; pickup_enabled: boolean; pickup_note: string; delivery_enabled: boolean; delivery_price: number;
  free_delivery_over: number | null; delivery_note: string;
};
/** a sum in shekels with at most agorot: "30", "29.90" */
const money = (s: string): number | null => (/^\d{1,6}(\.\d{1,2})?$/.test(s.trim()) ? Number(s.trim()) : null);

export function checkCheckout(f: CheckoutForm): { ok: true; patch: CheckoutPatch } | { ok: false; error: string } {
  const minutes = Number(f.reserveMinutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60) return { ok: false, error: 'זמן השמירה: בין 5 ל-60 דקות.' };
  if (f.pickupNote.trim().length > 200 || f.deliveryNote.trim().length > 200) return { ok: false, error: 'ההסבר ארוך מדי (עד 200 תווים).' };
  const price = f.deliveryEnabled ? money(f.deliveryPrice || '0') : 0;
  if (price === null || price > 10000) return { ok: false, error: 'מחיר המשלוח: סכום בשקלים, למשל 30 או 29.90.' };
  let free: number | null = null;
  if (f.deliveryEnabled && f.freeDeliveryOver.trim()) {
    free = money(f.freeDeliveryOver);
    if (free === null || free < 1 || free > 100000) return { ok: false, error: 'משלוח חינם מעל: סכום בשקלים, או ריק.' };
  }
  return { ok: true, patch: {
    reserve_minutes: minutes, pickup_enabled: f.pickupEnabled, pickup_note: f.pickupNote.trim(), delivery_enabled: f.deliveryEnabled,
    delivery_price: price, free_delivery_over: free, delivery_note: f.deliveryNote.trim(),
  } };
}

/** why "מכירה באתר" cannot be switched on yet — or [] */
export function sellingMissing(s: Pick<CheckoutSettings, 'pickupEnabled' | 'deliveryEnabled'>, terminal: boolean): ('payment' | 'shipping')[] {
  const out: ('payment' | 'shipping')[] = [];
  if (!terminal) out.push('payment');
  if (!s.pickupEnabled && !s.deliveryEnabled) out.push('shipping');
  return out;
}
export const SELLING_MISSING: Record<'payment' | 'shipping', string> = {
  payment: 'חיבור מסוף סליקה (PayPlus, סביבת בדיקה)',
  shipping: 'איסוף עצמי או משלוח',
};
export function checkoutError(message: string): string | null {
  if (/checkout_not_ready: payment/.test(message)) return 'כדי למכור באתר צריך קודם לחבר מסוף סליקה.';
  if (/checkout_not_ready: shipping/.test(message)) return 'צריך לפחות דרך אחת לקבל את ההזמנה: איסוף עצמי או משלוח.';
  if (/stores_checkout_settings_check/.test(message)) return 'אחד הערכים של המכירה באתר לא תקין.';
  return null;
}

// ---- the payment terminal ----------------------------------------------------------------------------------------------------
export interface TerminalForm { apiKey: string; secretKey: string; pageUid: string }
/**
 * PayPlus's keys, as its dashboard shows them (an API key, a secret key, the payment page's uid). Nothing here is sent to the
 * browser again: the server seals the keys, and the screen sees "מחובר" and the last 4 characters of the API key.
 */
export function checkTerminal(f: TerminalForm): { ok: true; keys: { api_key: string; secret_key: string }; pageUid: string } | { ok: false; error: string } {
  const apiKey = f.apiKey.trim(), secretKey = f.secretKey.trim(), pageUid = f.pageUid.trim();
  const token = /^[A-Za-z0-9_.:-]{8,200}$/;
  if (!token.test(apiKey)) return { ok: false, error: 'מפתח ה-API לא נראה תקין. העתיקו אותו מהגדרות PayPlus.' };
  if (!token.test(secretKey)) return { ok: false, error: 'המפתח הסודי לא נראה תקין. העתיקו אותו מהגדרות PayPlus.' };
  if (!/^[A-Za-z0-9-]{8,80}$/.test(pageUid)) return { ok: false, error: 'מזהה עמוד התשלום (Payment page UID) לא נראה תקין.' };
  if (apiKey === secretKey) return { ok: false, error: 'מפתח ה-API והמפתח הסודי הם שני ערכים שונים.' };
  return { ok: true, keys: { api_key: apiKey, secret_key: secretKey }, pageUid };
}
export const keyHint = (apiKey: string) => apiKey.trim().slice(-4);
export interface TerminalInfo { connected: boolean; provider: 'payplus' | 'mock' | null; mode: 'test' | 'live' | null; hint: string; connectedAt: string | null; ready: boolean;
  /** the platform's switch of real sales (commerce_live) — off until the owner's separate approval */
  liveOpen?: boolean;
  /** 2.88 (migration 4300): when "בדיקת חיבור" last passed with these keys (null: not checked); the switch of real payment links */
  verifiedAt?: string | null; linksLive?: boolean }

// ---- coupons -------------------------------------------------------------------------------------------------------------------
export interface Coupon {
  id: string; code: string; kind: 'percent' | 'amount'; value: number; minSubtotal: number; startsAt: string | null; endsAt: string | null;
  maxUses: number | null; usedCount: number; active: boolean;
}
export const toCoupon = (r: any): Coupon => ({
  id: r.id, code: r.code, kind: r.kind === 'amount' ? 'amount' : 'percent', value: Number(r.value), minSubtotal: Number(r.min_subtotal ?? 0),
  startsAt: r.starts_at ?? null, endsAt: r.ends_at ?? null, maxUses: r.max_uses == null ? null : Number(r.max_uses),
  usedCount: Number(r.used_count ?? 0), active: Boolean(r.active),
});
export interface CouponForm { code: string; kind: 'percent' | 'amount'; value: string; minSubtotal: string; endsOn: string; maxUses: string }
export type CouponRow = { code: string; kind: 'percent' | 'amount'; value: number; min_subtotal: number; ends_at: string | null; max_uses: number | null };

/** a coupon from the form; "endsOn" is a date (yyyy-mm-dd): the coupon works through that day, Israel time */
export function checkCoupon(f: CouponForm, today = new Date()): { ok: true; row: CouponRow } | { ok: false; error: string } {
  const code = f.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return { ok: false, error: 'קוד: 3–30 אותיות באנגלית, ספרות, מקף או קו תחתון.' };
  const value = money(f.value);
  if (value === null || value <= 0) return { ok: false, error: f.kind === 'percent' ? 'כמה אחוזים? (1–100)' : 'כמה שקלים הנחה?' };
  if (f.kind === 'percent' && value > 100) return { ok: false, error: 'הנחה באחוזים: עד 100.' };
  const min = f.minSubtotal.trim() ? money(f.minSubtotal) : 0;
  if (min === null) return { ok: false, error: 'סכום מינימלי: מספר בשקלים, או ריק.' };
  let endsAt: string | null = null;
  if (f.endsOn.trim()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.endsOn.trim())) return { ok: false, error: 'תאריך סיום לא תקין.' };
    const end = new Date(`${f.endsOn.trim()}T23:59:59+03:00`);
    if (Number.isNaN(end.getTime())) return { ok: false, error: 'תאריך סיום לא תקין.' };
    if (end.getTime() < today.getTime()) return { ok: false, error: 'תאריך הסיום כבר עבר.' };
    endsAt = end.toISOString();
  }
  let maxUses: number | null = null;
  if (f.maxUses.trim()) {
    maxUses = Number(f.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) return { ok: false, error: 'מספר שימושים: מספר שלם, או ריק (בלי הגבלה).' };
  }
  return { ok: true, row: { code, kind: f.kind, value, min_subtotal: min, ends_at: endsAt, max_uses: maxUses } };
}
export function couponLabel(c: Pick<Coupon, 'kind' | 'value'>): string {
  return c.kind === 'percent' ? `${c.value}% הנחה` : `₪${c.value} הנחה`;
}
export function couponState(c: Coupon, now = new Date()): 'active' | 'off' | 'ended' | 'used_up' | 'not_started' {
  if (!c.active) return 'off';
  if (c.endsAt && new Date(c.endsAt).getTime() <= now.getTime()) return 'ended';
  if (c.startsAt && new Date(c.startsAt).getTime() > now.getTime()) return 'not_started';
  if (c.maxUses != null && c.usedCount >= c.maxUses) return 'used_up';
  return 'active';
}
export const COUPON_STATE: Record<ReturnType<typeof couponState>, string> = {
  active: 'פעיל', off: 'כבוי', ended: 'הסתיים', used_up: 'נוצל', not_started: 'עוד לא התחיל',
};
export function couponError(message: string): string | null {
  if (/store_coupons_code_uq/.test(message)) return 'כבר יש קופון עם הקוד הזה.';
  return null;
}

// ---- orders ----------------------------------------------------------------------------------------------------------------------
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded' | 'partially_refunded' | 'test_paid';
export interface OrderRow {
  id: string; number: number; isTest: boolean; paymentStatus: PaymentStatus; fulfillmentStatus: string; total: number; subtotal: number;
  discount: number; shipping: number; currency: string; couponCode: string; customerName: string; customerPhone: string;
  customerEmail: string; deliveryMethod: 'pickup' | 'delivery'; address: Record<string, string>; notes: string; provider: string;
  createdAt: string; paidAt: string | null; expiresAt: string;
  /** stage 4 (migration 3600): the sale and the customer it became, its document, the goods, a request, refunds */
  saleId: string | null; leadId: string | null; documentStatus: 'not_required' | 'pending' | 'issued' | 'blocked'; documentId: string | null;
  documentError: string; trackingNumber: string; trackingUrl: string; shippedAt: string | null; requestKind: '' | 'cancel' | 'return';
  requestNote: string; requestedAt: string | null; refundedTotal: number;
  /** 2.79 (migration 4000): paid after its hold ran out, and stock was missing then — per product / size, ordered vs. free */
  stockShort: StockShort[];
}
export interface StockShort { name: string; variant: string; qty: number; available: number }
/** what the database kept on the order (orders.stock_short), made safe: whole numbers, a real shortage only */
export const toStockShort = (raw: unknown): StockShort[] => (Array.isArray(raw) ? raw : [])
  .map((x: any) => ({ name: String(x?.name ?? ''), variant: String(x?.variant ?? ''), qty: Math.trunc(Number(x?.qty)), available: Math.max(0, Math.trunc(Number(x?.available))) }))
  .filter((x) => x.name && Number.isFinite(x.qty) && Number.isFinite(x.available) && x.qty > x.available);
/** "שקית בד — הוזמנו 2, יש 1; חולצה (M) — הוזמנה 1, אין" */
export const stockShortText = (s: StockShort[]): string => s.map((x) =>
  `${x.name}${x.variant ? ` (${x.variant})` : ''} — ${x.qty === 1 ? 'הוזמנה 1' : `הוזמנו ${x.qty}`}, ${x.available ? `יש ${x.available}` : 'אין'}`).join('; ');
export interface OrderLine { name: string; variantLabel: string; sku: string; unitPrice: number; qty: number; lineTotal: number; imageUrl: string }
export interface OrderEvent { kind: string; data: Record<string, unknown>; at: string }

export const toOrder = (r: any): OrderRow => ({
  id: r.id, number: Number(r.number), isTest: Boolean(r.is_test), paymentStatus: r.payment_status, fulfillmentStatus: r.fulfillment_status,
  total: Number(r.total), subtotal: Number(r.subtotal), discount: Number(r.discount ?? 0), shipping: Number(r.shipping ?? 0),
  currency: r.currency ?? 'ILS', couponCode: r.coupon_code ?? '', customerName: r.customer_name ?? '', customerPhone: r.customer_phone ?? '',
  customerEmail: r.customer_email ?? '', deliveryMethod: r.delivery_method === 'delivery' ? 'delivery' : 'pickup',
  address: (r.address && typeof r.address === 'object' ? r.address : {}) as Record<string, string>, notes: r.notes ?? '',
  provider: r.provider ?? '', createdAt: r.created_at, paidAt: r.paid_at ?? null, expiresAt: r.expires_at,
  saleId: r.sale_id ?? null, leadId: r.lead_id ?? null, documentStatus: r.document_status ?? 'not_required', documentId: r.document_id ?? null,
  documentError: r.document_error ?? '', trackingNumber: r.tracking_number ?? '', trackingUrl: r.tracking_url ?? '', shippedAt: r.shipped_at ?? null,
  requestKind: r.request_kind === 'cancel' || r.request_kind === 'return' ? r.request_kind : '', requestNote: r.request_note ?? '',
  requestedAt: r.requested_at ?? null, refundedTotal: Number(r.refunded_total ?? 0), stockShort: toStockShort(r.stock_short),
});
export const toOrderLine = (r: any): OrderLine => ({
  name: r.name, variantLabel: r.variant_label ?? '', sku: r.sku ?? '', unitPrice: Number(r.unit_price), qty: Number(r.qty),
  lineTotal: Number(r.line_total), imageUrl: r.image_url ?? '',
});
export const toOrderEvent = (r: any): OrderEvent => ({ kind: r.kind, data: (r.data ?? {}) as Record<string, unknown>, at: r.at });

/** one Hebrew label for the screen, and its tone (DREAM_COMMERCE_ARCHITECTURE §6.3) */
export function orderLabel(o: Pick<OrderRow, 'paymentStatus' | 'isTest'>): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  switch (o.paymentStatus) {
    case 'test_paid': return { text: 'שולם (בדיקה)', tone: 'ok' };
    case 'paid': return { text: 'שולם', tone: 'ok' };
    case 'pending': return { text: 'ממתין לתשלום', tone: 'warn' };
    case 'failed': return { text: 'התשלום נכשל', tone: 'bad' };
    case 'expired': return { text: 'לא שולם (פג תוקף)', tone: 'muted' };
    case 'refunded': return { text: 'הוחזר', tone: 'muted' };
    case 'partially_refunded': return { text: 'הוחזר חלקית', tone: 'muted' };
    default: return { text: String(o.paymentStatus), tone: 'muted' };
  }
}
export const ORDER_FILTERS: { id: 'all' | 'paid' | 'pending' | 'failed'; label: string; match: (s: PaymentStatus) => boolean }[] = [
  { id: 'all', label: 'הכול', match: () => true },
  { id: 'paid', label: 'שולמו', match: (s) => s === 'paid' || s === 'test_paid' },
  { id: 'pending', label: 'ממתינות', match: (s) => s === 'pending' },
  { id: 'failed', label: 'לא שולמו', match: (s) => s === 'failed' || s === 'expired' },
];

export const FULFILLMENT_HE: Record<string, string> = {
  unfulfilled: 'טרם טופל', processing: 'בהכנה', ready: 'מוכן לאיסוף', shipped: 'נשלח', delivered: 'נמסר', returned: 'הוחזר',
};
export const EMAIL_KIND_HE: Record<string, string> = {
  order_confirmation: 'אישור הזמנה', order_ready: 'מוכן לאיסוף', order_shipped: 'ההזמנה נשלחה', order_refunded: 'החזר כספי',
};
export const DOCUMENT_STATUS_HE: Record<OrderRow['documentStatus'], string> = {
  not_required: 'לא נדרש', pending: 'שולם — מסמך ממתין', issued: 'הופק', blocked: 'לא הופק',
};

/** a line of the order's timeline in words; the provider's ids and amounts as they were logged */
export function eventText(e: OrderEvent): string {
  const d = e.data;
  switch (e.kind) {
    case 'created': return 'ההזמנה נוצרה. המוצרים נשמרו לקונה עד סוף זמן התשלום.';
    case 'payment_page': return 'הקונה עבר/ה לעמוד התשלום של חברת הסליקה.';
    case 'test_paid': return `התשלום אושר ע״י חברת הסליקה (סביבת בדיקה)${d.late ? ' — אחרי שזמן השמירה עבר' : ''}. לא נוצרה מכירה ולא הופק מסמך.`;
    case 'failed': return 'התשלום לא הושלם. המוצרים חזרו למלאי הזמין.';
    case 'expired': return 'זמן התשלום עבר בלי אישור. המוצרים חזרו למלאי הזמין.';
    case 'amount_mismatch': return `התקבל אישור על סכום אחר (${d.amount ?? '?'} ${d.currency ?? ''}). ההזמנה לא סומנה כשולמה — לבדוק מול חברת הסליקה.`;
    case 'double_payment': return 'התקבל אישור על תשלום נוסף להזמנה ששולמה — לבדוק מול חברת הסליקה (ייתכן חיוב כפול).';
    case 'payment_rejected': return 'התקבלה הודעת תשלום שלא מתאימה להזמנה. היא נרשמה ולא שינתה כלום.';
    // stage 4
    case 'paid': return `התשלום אושר ע״י חברת הסליקה${d.late ? (d.short ? ' — אחרי שזמן השמירה עבר, וחסר מלאי' : d.short === false ? ' — אחרי שזמן השמירה עבר (המלאי הספיק)' : ' — אחרי שזמן השמירה עבר (כדאי לבדוק מלאי)') : ''}. המוצרים שמורים עד שהמכירה נרשמת.`;
    case 'sale_recorded': return 'נרשמה מכירה מהאתר: המלאי ירד, והלקוח נוסף ללקוחות (או עודכן).';
    case 'document_issued': return 'המסמך הופק.';
    case 'document_blocked': return `המסמך לא הופק: ${String(d.error ?? '')}`;
    case 'document_retry': return 'ניסיון נוסף להפיק את המסמך.';
    case 'fulfillment': return `מצב המשלוח: ${FULFILLMENT_HE[String(d.to)] ?? String(d.to)}${d.tracking ? ` · מספר מעקב ${String(d.tracking)}` : ''}`;
    case 'refund': return `נרשם החזר של ₪${Number(d.amount ?? 0).toLocaleString('he-IL', { maximumFractionDigits: 2 })}${d.restock ? ', והמוצרים חזרו למלאי' : ''}.`;
    case 'request': return d.kind === 'cancel' ? 'הלקוח ביקש לבטל את ההזמנה.' : 'הלקוח ביקש להחזיר את ההזמנה.';
    case 'email_sent': return `נשלח מייל ללקוח: ${EMAIL_KIND_HE[String(d.kind)] ?? String(d.kind)}.`;
    case 'email_failed': return `המייל ללקוח לא נשלח (${EMAIL_KIND_HE[String(d.kind)] ?? String(d.kind)}).`;
    default: return e.kind;
  }
}
