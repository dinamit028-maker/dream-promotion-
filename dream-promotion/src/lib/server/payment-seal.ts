import { createCipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The business's payment keys, sealed for the storefront (Dream Commerce stage 3): AES-256-GCM, `v1.<iv>.<tag>.<data>`
 * (base64url), the key derived from PAYMENT_SEAL_KEY — a secret the dashboard and the storefront share (environment
 * variables only). The dashboard only seals; only the storefront's server opens (storefront/src/lib/seal.ts — the same
 * format, tested against it in tests/store-checkout.test.ts). Not TOKEN_ENCRYPTION_KEY: the storefront never gets that one.
 */
export function paymentSealReady(base = process.env.PAYMENT_SEAL_KEY): boolean {
  return typeof base === 'string' && base.length >= 32;
}

export function sealPaymentKeys(keys: { api_key: string; secret_key: string }, base = process.env.PAYMENT_SEAL_KEY): string {
  if (!paymentSealReady(base)) throw new Error('PAYMENT_SEAL_KEY is not set (at least 32 characters)');
  const key = createHash('sha256').update(`dp-payments:${base}`).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify({ api_key: keys.api_key, secret_key: keys.secret_key }), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
