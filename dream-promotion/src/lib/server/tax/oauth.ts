import { adminDb } from '@/lib/server/admin';
import { open, seal } from '@/lib/server/secrets';

/**
 * OAuth 2.0 (authorization code, RFC 6749) for the Tax Authority connection — per business, server only.
 * Every address comes from the environment; nothing about the Tax Authority's endpoints is written here:
 *   ITA_OAUTH_AUTHORIZE_URL, ITA_OAUTH_TOKEN_URL, ITA_CLIENT_ID, ITA_CLIENT_SECRET, ITA_OAUTH_SCOPE (optional),
 *   APP_URL (the app's own address, for the redirect back), ITA_ENVIRONMENT = test | production
 * The tokens are sealed (AES-256-GCM, secrets.ts) into tax_authority_connections, one row per business, a table no
 * browser can read. The connect "state" is signed and names the business, so a token always lands on the business
 * whose member started the connection — and is only ever read back for that same business.
 */
type Env = Record<string, string | undefined>;
/** a one-time value in a cookie of the browser that started the connection; the callback needs it (connect/callback routes) */
export const TAX_OAUTH_COOKIE = 'dp_tax_oauth';

export interface OAuthConfig { authorizeUrl: string; tokenUrl: string; clientId: string; clientSecret: string; scope: string; redirectUri: string; environment: 'test' | 'production' }

export function oauthConfig(env: Env = process.env): OAuthConfig | null {
  const authorizeUrl = env.ITA_OAUTH_AUTHORIZE_URL?.trim(), tokenUrl = env.ITA_OAUTH_TOKEN_URL?.trim();
  const clientId = env.ITA_CLIENT_ID?.trim(), clientSecret = env.ITA_CLIENT_SECRET?.trim(), app = env.APP_URL?.trim();
  if (!authorizeUrl || !tokenUrl || !clientId || !clientSecret || !app) return null;
  if (![authorizeUrl, tokenUrl, app].every((u) => /^https:\/\//.test(u))) return null;
  return { authorizeUrl, tokenUrl, clientId, clientSecret, scope: env.ITA_OAUTH_SCOPE?.trim() ?? '', redirectUri: new URL('/api/finance/tax/callback', app).toString(),
    environment: env.ITA_ENVIRONMENT === 'production' ? 'production' : 'test' };
}

/** the address the user is sent to, to approve the connection (standard OAuth 2.0 parameters only) */
export function authorizeUrl(c: OAuthConfig, state: string): string {
  const u = new URL(c.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('redirect_uri', c.redirectUri);
  if (c.scope) u.searchParams.set('scope', c.scope);
  u.searchParams.set('state', state);
  return u.toString();
}

interface TokenAnswer { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }
async function tokenRequest(c: OAuthConfig, form: Record<string, string>): Promise<TokenAnswer | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(c.tokenUrl, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...form, client_id: c.clientId, client_secret: c.clientSecret }).toString() });
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as TokenAnswer | null;
    return j?.access_token ? j : null;
  } catch { return null; } finally { clearTimeout(t); }
}

/** the code from the redirect → tokens, sealed and stored on that one business */
export async function connectBusiness(businessId: string, userId: string, code: string, env: Env = process.env): Promise<{ ok: boolean; message: string }> {
  const c = oauthConfig(env);
  if (!c) return { ok: false, message: 'החיבור לרשות המסים לא הוגדר בשרת.' };
  const t = await tokenRequest(c, { grant_type: 'authorization_code', code, redirect_uri: c.redirectUri });
  const db = adminDb();
  if (!t) {
    await db.from('tax_authority_connections').upsert({ business_id: businessId, status: 'error', environment: c.environment, last_error: 'token_exchange_failed' }, { onConflict: 'business_id' });
    return { ok: false, message: 'רשות המסים לא אישרה את החיבור. נסו שוב.' };
  }
  const { error } = await db.from('tax_authority_connections').upsert({
    business_id: businessId, status: 'connected', environment: c.environment, access_token_sealed: seal(t.access_token!),
    refresh_token_sealed: t.refresh_token ? seal(t.refresh_token) : null, expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
    scope: t.scope ?? c.scope, connected_by: userId, connected_at: new Date().toISOString(), last_error: '',
  }, { onConflict: 'business_id' });
  return error ? { ok: false, message: 'החיבור לא נשמר.' } : { ok: true, message: 'החיבור לרשות המסים נשמר.' };
}

/** the business's own access token (refreshed when it ran out) — never another business's */
export async function accessTokenFor(businessId: string, env: Env = process.env): Promise<{ ok: true; accessToken: string } | { ok: false; code: string; message: string }> {
  const c = oauthConfig(env);
  if (!c) return { ok: false, code: 'not_configured', message: 'החיבור לרשות המסים לא הוגדר' };
  const db = adminDb();
  const { data } = await db.from('tax_authority_connections').select('*').eq('business_id', businessId).maybeSingle();
  const row = data as any;
  if (!row || row.status !== 'connected' || !row.access_token_sealed) return { ok: false, code: 'not_connected', message: 'העסק לא מחובר לרשות המסים' };
  const fresh = !row.expires_at || Date.parse(row.expires_at) > Date.now() + 60_000;
  if (fresh) {
    try { return { ok: true, accessToken: open(row.access_token_sealed) }; } catch { return { ok: false, code: 'token_unreadable', message: 'צריך לחבר מחדש את רשות המסים' }; }
  }
  if (!row.refresh_token_sealed) {
    await db.from('tax_authority_connections').update({ status: 'expired' }).eq('business_id', businessId);
    return { ok: false, code: 'expired', message: 'החיבור לרשות המסים פג — צריך לחבר מחדש' };
  }
  let refresh: string;
  try { refresh = open(row.refresh_token_sealed); } catch { return { ok: false, code: 'token_unreadable', message: 'צריך לחבר מחדש את רשות המסים' }; }
  const t = await tokenRequest(c, { grant_type: 'refresh_token', refresh_token: refresh });
  if (!t) {
    await db.from('tax_authority_connections').update({ status: 'expired', last_error: 'refresh_failed' }).eq('business_id', businessId);
    return { ok: false, code: 'expired', message: 'החיבור לרשות המסים פג — צריך לחבר מחדש' };
  }
  await db.from('tax_authority_connections').update({
    access_token_sealed: seal(t.access_token!), ...(t.refresh_token ? { refresh_token_sealed: seal(t.refresh_token) } : {}),
    expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, status: 'connected', last_error: '',
  }).eq('business_id', businessId);
  return { ok: true, accessToken: t.access_token! };
}

/** status for the screen — never a token */
export async function connectionStatus(businessId: string) {
  const { data } = await adminDb().from('tax_authority_connections').select('status, environment, expires_at, connected_at').eq('business_id', businessId).maybeSingle();
  const r = data as any;
  return r ? { status: r.status as string, environment: r.environment as string, expiresAt: (r.expires_at ?? null) as string | null, connectedAt: (r.connected_at ?? null) as string | null } : null;
}
