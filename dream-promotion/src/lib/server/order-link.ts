import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The customer's link to an order in an email: https://<store domain>/orders/<order id>.<mac>. The mac is an HMAC of the
 * order's id with ORDER_LINK_SECRET, which only the dashboard's server (writes the email) and the storefront's server
 * (opens the page) know — the database keeps only the hash of the checkout's own token, so this is a second key to the
 * same page. storefront/src/lib/order-link.ts is the same function; both are tested on the same example.
 */
export function orderRef(orderId: string, secret = process.env.ORDER_LINK_SECRET ?? ''): string | null {
  if (secret.length < 16 || !/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const mac = createHmac('sha256', secret).update(`order-link:${orderId.toLowerCase()}`).digest('base64url').slice(0, 32);
  return `${orderId.toLowerCase()}.${mac}`;
}
export function orderRefOk(ref: string, secret = process.env.ORDER_LINK_SECRET ?? ''): string | null {
  const id = ref.split('.')[0] ?? '';
  const want = orderRef(id, secret);
  if (!want || want.length !== ref.length) return null;
  return timingSafeEqual(Buffer.from(want), Buffer.from(ref)) ? id.toLowerCase() : null;
}

/**
 * A payment link's address (migration 4300): https://<the dashboard>/pay/<request id>.<mac> — the same secret, its own
 * purpose ("paylink:"), so an order's link never opens a payment link or the other way round.
 */
export function paylinkRef(requestId: string, secret = process.env.ORDER_LINK_SECRET ?? ''): string | null {
  if (secret.length < 16 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) return null;
  const mac = createHmac('sha256', secret).update(`paylink:${requestId.toLowerCase()}`).digest('base64url').slice(0, 32);
  return `${requestId.toLowerCase()}.${mac}`;
}
export function paylinkRefOk(ref: string, secret = process.env.ORDER_LINK_SECRET ?? ''): string | null {
  const id = ref.split('.')[0] ?? '';
  const want = paylinkRef(id, secret);
  if (!want || want.length !== ref.length) return null;
  return timingSafeEqual(Buffer.from(want), Buffer.from(ref)) ? id.toLowerCase() : null;
}
