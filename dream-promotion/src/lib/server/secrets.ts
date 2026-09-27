import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Encryption for third-party tokens at rest (AES-256-GCM), and signed short-lived
 * state for OAuth redirects. Key: TOKEN_ENCRYPTION_KEY, or derived from the service key.
 */
function key(): Buffer {
  const base = process.env.TOKEN_ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) throw new Error('no encryption key configured');
  return createHash('sha256').update(`dp-tokens:${base}`).digest();
}
const b64u = (b: Buffer) => b.toString('base64url');

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(enc)}`;
}
export function open(sealed: string): string {
  const [v, iv, tag, enc] = sealed.split('.');
  if (v !== 'v1') throw new Error('bad token format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

/** Signed state: who started the connect flow, valid for 15 minutes. */
export function signState(data: Record<string, unknown>): string {
  const body = b64u(Buffer.from(JSON.stringify({ ...data, n: b64u(randomBytes(8)), e: Date.now() + 15 * 60_000 })));
  const sig = b64u(createHmac('sha256', key()).update(body).digest());
  return `${body}.${sig}`;
}
export function readState<T = Record<string, unknown>>(state: string | null): T | null {
  if (!state) return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', key()).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return data.e > Date.now() ? (data as T) : null;
}
