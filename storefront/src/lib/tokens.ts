import { createHash, randomBytes } from 'node:crypto';

/**
 * The shopper's cart and an order's link are random tokens (32 bytes, base64url). The browser keeps the token — the cart in
 * an httpOnly cookie, the order in its link — and the database keeps only its sha-256, so a leaked table names no cart.
 */
export const CART_COOKIE = 'sf_cart';
export const CART_COUNT_COOKIE = 'sf_cart_n';          // how many items, for the header's badge (not a secret)
export const CART_DAYS = 30;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const newToken = () => randomBytes(32).toString('base64url');
export const isToken = (t: unknown): t is string => typeof t === 'string' && TOKEN.test(t);
export const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

/** a value of one shopper for one store, for counting requests and open orders: never the address itself */
export const shopperKey = (ip: string, store: string) => createHash('sha256').update(`${store}|${ip}`, 'utf8').digest('hex').slice(0, 32);
