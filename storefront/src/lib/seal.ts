import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The business's payment keys (DREAM_COMMERCE_ARCHITECTURE §3.2): the dashboard's server seals them, only the storefront's
 * server opens them — AES-256-GCM, `v1.<iv>.<tag>.<data>` (base64url), the key derived from PAYMENT_SEAL_KEY, a secret both
 * apps share (environment variables only). The dashboard has its own copy of this format
 * (dream-promotion/src/lib/server/payment-seal.ts); both are tested against the same vector.
 */
export interface PaymentKeys { api_key: string; secret_key: string }

function key(base = process.env.PAYMENT_SEAL_KEY): Buffer {
  if (!base || base.length < 32) throw new Error('PAYMENT_SEAL_KEY is not set (at least 32 characters)');
  return createHash('sha256').update(`dp-payments:${base}`).digest();
}

export function sealKeys(keys: PaymentKeys, base?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(base), iv);
  const enc = Buffer.concat([c.update(JSON.stringify({ api_key: keys.api_key, secret_key: keys.secret_key }), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

/** the keys, or null (another key, a broken or forged value) */
export function openKeys(sealed: string, base?: string): PaymentKeys | null {
  try {
    const [v, iv, tag, enc] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !enc) return null;
    const d = createDecipheriv('aes-256-gcm', key(base), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    const k = JSON.parse(Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8'));
    return typeof k?.api_key === 'string' && typeof k?.secret_key === 'string' ? { api_key: k.api_key, secret_key: k.secret_key } : null;
  } catch {
    return null;
  }
}
