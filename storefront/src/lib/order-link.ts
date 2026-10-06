import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The customer's link to an order in an email: /orders/<order id>.<mac>. The mac is an HMAC of the order's id with
 * ORDER_LINK_SECRET, which only this server and the dashboard's server (it writes the emails) know. The dashboard's
 * src/lib/server/order-link.ts is the same function; both are tested on the same example.
 */
export function orderRef(orderId: string, secret = process.env.ORDER_LINK_SECRET ?? ''): string | null {
  if (secret.length < 16 || !/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const mac = createHmac('sha256', secret).update(`order-link:${orderId.toLowerCase()}`).digest('base64url').slice(0, 32);
  return `${orderId.toLowerCase()}.${mac}`;
}
/** the order's id when the link is genuine, else null */
export function orderRefOk(ref: string, secret = process.env.ORDER_LINK_SECRET ?? ''): string | null {
  const id = ref.split('.')[0] ?? '';
  const want = orderRef(id, secret);
  if (!want || want.length !== ref.length) return null;
  return timingSafeEqual(Buffer.from(want), Buffer.from(ref)) ? id.toLowerCase() : null;
}
