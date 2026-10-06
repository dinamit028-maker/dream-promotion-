import { data } from './data';
import { providerOf } from './pay';
import { ProviderError, type Verified } from './pay/types';
import { openKeys } from './seal';
import { notifyPaid } from './dashboard';
import { after } from 'next/server';
import { hashToken, newToken } from './tokens';
import type { Cart, CheckoutStart, CouponError, OrderView } from './types';

/**
 * The checkout on the storefront's server (DREAM_COMMERCE_ARCHITECTURE §6.4). The database computes the amount and holds the
 * stock (sf_checkout_start); this side asks the provider for a payment page, and later asks it — directly — whether the page
 * was paid. Only that answer, for this order and this exact amount, makes an order paid (sf_order_paid). A notice or a
 * return to the site only starts the question.
 */

// ---- what the shopper reads ----------------------------------------------------------------------------------------------
export const CART_ERRORS: Record<string, string> = {
  gone: 'המוצר הזה כבר לא זמין באתר.',
  variant: 'צריך לבחור מידה / צבע.',
  not_enough: 'אין מספיק במלאי.',
  max_qty: 'אפשר עד 20 יחידות מכל מוצר.',
  max_lines: 'בסל יש כבר 30 מוצרים שונים.',
  cart: 'הסל התחלף. נסו שוב.',
  store: 'החנות לא מוכרת כרגע באתר.',
  bad_request: 'משהו בבקשה לא תקין. נסו שוב.',
  empty: 'הסל ריק.',
  rate: 'יותר מדי בקשות. חכו דקה ונסו שוב.',
};
export const COUPON_ERRORS: Record<CouponError, string> = {
  not_found: 'הקופון הזה לא קיים.',
  not_started: 'הקופון עוד לא בתוקף.',
  ended: 'הקופון כבר לא בתוקף.',
  used_up: 'הקופון כבר נוצל.',
  min_subtotal: 'הקופון תקף מסכום מינימלי',
};
export const CHECKOUT_ERRORS: Record<string, string> = {
  ...CART_ERRORS,
  checkout_off: 'החנות לא מקבלת הזמנות באתר כרגע.',
  payment: 'אי אפשר לשלם באתר כרגע. נסו שוב מאוחר יותר.',
  live_not_yet: 'אי אפשר לשלם באתר כרגע. נסו שוב מאוחר יותר.',
  details: 'יש פרטים שצריך לתקן.',
  too_many_open: 'יש כבר כמה הזמנות פתוחות מהמכשיר הזה. סיימו אחת מהן, או חכו רבע שעה.',
  stock: 'חלק מהמוצרים כבר לא במלאי בכמות שבחרתם. עדכנו את הסל.',
  coupon: 'יש בעיה בקופון.',
  zero_total: 'הסכום לתשלום הוא 0. צרו איתנו קשר להשלמת ההזמנה.',
  provider: 'לא הצלחנו לפתוח את עמוד התשלום. נסו שוב בעוד רגע.',
  bot: 'משהו בבקשה לא תקין. נסו שוב.',
};
export const FIELD_LABELS: Record<string, string> = {
  name: 'שם מלא', phone: 'טלפון', email: 'אימייל', method: 'איך מקבלים את ההזמנה', city: 'עיר', street: 'רחוב', house: 'מספר בית',
  apartment: 'דירה', notes: 'הערות', terms: 'אישור התקנון ומדיניות הביטולים',
};

export function couponMessage(c: Cart['coupon']): string {
  if (!c?.error) return '';
  return c.error === 'min_subtotal' && c.min != null ? `${COUPON_ERRORS.min_subtotal} של ${c.min} ₪.` : COUPON_ERRORS[c.error];
}

// ---- the customer's form ---------------------------------------------------------------------------------------------------
const FIELDS = ['name', 'phone', 'email', 'method', 'city', 'street', 'house', 'apartment', 'notes'] as const;
/** only the known fields, as strings of a sane length; the price, the total or anything else the browser sends is dropped */
export function customerOf(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS) out[f] = typeof body[f] === 'string' ? (body[f] as string).slice(0, f === 'notes' ? 600 : 140) : '';
  out.terms = body.terms === true || body.terms === 'true' || body.terms === 'on' ? 'true' : 'false';
  return out;
}

// ---- start: the order, then the provider's page ---------------------------------------------------------------------------
export interface StartResult extends Omit<CheckoutStart, 'order' | 'account'> { url?: string; message?: string }

export async function startCheckout(o: {
  storeId: string; storeName: string; preview: boolean; origin: string; cart: string; customer: Record<string, string>; shopper: string;
}): Promise<StartResult> {
  const token = newToken();
  const r = await data.checkoutStart(o.storeId, hashToken(o.cart), hashToken(token), o.customer, o.shopper, o.preview);
  if (!r?.ok || !r.order || !r.account) {
    const error = r?.error ?? 'store';
    const coupon = error === 'coupon' && r?.reason ? couponMessage({ code: '', error: r.reason, min: r.min }) : '';
    return { ok: false, error, fields: r?.fields, lines: r?.lines, message: coupon || CHECKOUT_ERRORS[error] || CHECKOUT_ERRORS.bad_request };
  }
  const keys = openKeys(r.account.sealed);
  if (!keys) return { ok: false, error: 'payment', message: CHECKOUT_ERRORS.payment };
  const back = `${o.origin}/checkout/return?o=${token}`;
  try {
    const provider = providerOf(r.account.provider);
    const page = await provider.createPage(keys, r.account.page_uid, r.account.mode === 'test', {
      orderId: r.order.id, number: r.order.number, amount: r.order.total, currency: r.order.currency,
      customer: { name: r.order.name, email: r.order.email, phone: r.order.phone },
      successUrl: back, failureUrl: `${back}&r=failed`, callbackUrl: `${o.origin}/api/pay/${provider.id}/webhook`, storeName: o.storeName,
    });
    await data.orderPage(o.storeId, r.order.id, page.page);
    return { ok: true, url: page.url };
  } catch (e) {
    // no page: the order fails at once and its units go back on sale (the shopper may try again)
    await data.orderFailed(o.storeId, r.order.id, e instanceof ProviderError ? e.message.slice(0, 100) : 'provider').catch(() => undefined);
    return { ok: false, error: 'provider', message: CHECKOUT_ERRORS.provider };
  }
}

// ---- confirm: ask the provider about the order's page -----------------------------------------------------------------------
export type Confirmed = OrderView['status'] | 'unknown';

/**
 * Asks the provider whether the order's page was paid, and records the answer: approved for THIS order → sf_order_paid (which
 * checks the amount and the currency itself, and ignores a repeat); declined → sf_order_failed; anything else changes nothing.
 */
export async function confirmOrder(storeId: string, order: Pick<OrderView, 'id' | 'status' | 'provider' | 'page'>,
                                   why: 'return' | 'callback' | 'poll'): Promise<Confirmed> {
  if (!order.page || !['pending', 'expired', 'failed'].includes(order.status)) return order.status;
  const account = await data.paymentAccount(storeId);
  if (!account || account.provider !== order.provider) return order.status;
  const keys = openKeys(account.sealed);
  if (!keys) return order.status;
  let v: Verified;
  try {
    v = await providerOf(account.provider).verify(keys, account.mode === 'test', order.page);
  } catch {
    return 'unknown';
  }
  await data.paymentEvent(storeId, order.id, account.provider, `${account.provider}:verify:${order.page}:${v.status}:${v.txn || '-'}`,
    why === 'poll' ? 'poll' : 'verify', null, { status: v.status, txn: v.txn, amount: v.amount, currency: v.currency, detail: v.detail.slice(0, 80) });
  if (v.orderId && v.orderId !== order.id) return order.status;              // a page of another order: never this one
  if (v.status === 'approved' && v.amount != null) {
    const r = await data.orderPaid(storeId, order.id, account.provider, v.txn, v.amount, v.currency || 'ILS');
    if (r?.result === 'ok') afterResponse(() => notifyPaid(order.id));   // the sale, the document, the alert, the email — now
    return (r?.status as Confirmed) ?? order.status;
  }
  if (v.status === 'declined' && order.status === 'pending') {
    const r = await data.orderFailed(storeId, order.id, v.detail || 'declined');
    return (r?.status as Confirmed) ?? order.status;
  }
  return order.status;
}

/** after the answer went out (the shopper does not wait); outside a request (tests, scripts) it simply runs */
function afterResponse(job: () => Promise<unknown>) {
  try { after(job); } catch { void job().catch(() => undefined); }
}
