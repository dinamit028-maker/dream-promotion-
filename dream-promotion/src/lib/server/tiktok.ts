import { adminDb } from './admin';
import { canUseBusiness } from './business';
import { open, seal } from './secrets';

/**
 * TikTok: Login Kit (OAuth) + Content Posting API in upload mode — the video lands in the
 * creator's TikTok inbox and they finish the post in the app. Works before TikTok's audit.
 */
const API = process.env.TIKTOK_API_BASE || 'https://open.tiktokapis.com/v2';
const AUTH = process.env.TIKTOK_AUTH_BASE || 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_SCOPES = 'user.info.basic,video.upload';
/** the one-time cookie of a TikTok connection in progress (connect → callback, this browser only) */
export const TIKTOK_OAUTH_COOKIE = 'dp_tiktok_oauth';

export const tiktokConfigured = () => Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
export const redirectUri = (req: Request) =>
  process.env.TIKTOK_REDIRECT_URI || `${new URL(req.url).origin}/api/tiktok/callback`;

export function authorizeUrl(req: Request, state: string) {
  const p = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY!, scope: TIKTOK_SCOPES, response_type: 'code',
    redirect_uri: redirectUri(req), state,
  });
  return `${AUTH}?${p}`;
}

type TokenSet = { access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number; open_id: string; scope: string };

async function tokenRequest(fields: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY!, client_secret: process.env.TIKTOK_CLIENT_SECRET!, ...fields }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error || !j.access_token) throw new Error(`tiktok_token: ${j.error_description || j.error || res.status}`);
  return j;
}
export const exchangeCode = (req: Request, code: string) =>
  tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(req) });

export async function userInfo(accessToken: string) {
  const res = await fetch(`${API}/user/info/?fields=open_id,avatar_url,display_name`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const j: any = await res.json().catch(() => ({}));
  return (j?.data?.user ?? {}) as { open_id?: string; avatar_url?: string; display_name?: string };
}

export async function revoke(accessToken: string) {
  await fetch(`${API}/oauth/revoke/`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY!, client_secret: process.env.TIKTOK_CLIENT_SECRET!, token: accessToken }),
  }).catch(() => {});
}

export async function saveAccount(userId: string, biz: string, t: TokenSet) {
  const info = await userInfo(t.access_token);
  const now = Date.now();
  // a TikTok account belongs to the business it was connected from (social_accounts is not auto-filled) — and stays
  // there: connecting it from another business is refused, never a silent move of the account and its tokens
  const { data: had } = await adminDb().from('social_accounts').select('business_id').eq('provider', 'tiktok').eq('external_id', t.open_id).maybeSingle();
  if (had?.business_id && had.business_id !== biz) throw new Error('save_account: other_business');
  const row = {
    user_id: userId, business_id: biz, provider: 'tiktok', external_id: t.open_id,
    display_name: info.display_name ?? null, avatar_url: info.avatar_url ?? null,
    access_token: seal(t.access_token), refresh_token: seal(t.refresh_token),
    expires_at: new Date(now + t.expires_in * 1000).toISOString(),
    refresh_expires_at: new Date(now + t.refresh_expires_in * 1000).toISOString(),
    scope: t.scope, updated_at: new Date().toISOString(),
  };
  const { error } = await adminDb().from('social_accounts').upsert(row, { onConflict: 'provider,external_id' });
  if (error) throw new Error(`save_account: ${error.message}`);
}

/** A usable access token for a stored account — refreshed and re-saved when close to expiry. */
export async function accessTokenFor(userId: string, accountId: string): Promise<string> {
  const db = adminDb();
  const { data: acc } = await db.from('social_accounts').select('*').eq('id', accountId).eq('provider', 'tiktok').maybeSingle();
  if (!acc || !(await canUseBusiness(userId, acc.business_id))) throw new Error('account_not_found');
  if (acc.expires_at && new Date(acc.expires_at).getTime() - Date.now() > 5 * 60_000) return open(acc.access_token);
  if (!acc.refresh_token || (acc.refresh_expires_at && new Date(acc.refresh_expires_at).getTime() < Date.now())) throw new Error('reconnect_required');
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: open(acc.refresh_token) });
  const now = Date.now();
  await db.from('social_accounts').update({
    access_token: seal(t.access_token), refresh_token: seal(t.refresh_token),
    expires_at: new Date(now + t.expires_in * 1000).toISOString(),
    refresh_expires_at: new Date(now + t.refresh_expires_in * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', accountId);
  return t.access_token;
}

async function api(path: string, token: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  const j: any = await res.json().catch(() => ({}));
  if (j?.error?.code && j.error.code !== 'ok') throw new Error(`${j.error.code}: ${j.error.message || ''}`.trim());
  if (!res.ok) throw new Error(`tiktok_http_${res.status}`);
  return j.data;
}

/** Sends an MP4 to the creator's TikTok inbox (FILE_UPLOAD, chunked when large). Returns publish_id. */
export async function uploadToInbox(token: string, video: Buffer): Promise<string> {
  const size = video.length;
  const MAX_SINGLE = 64 * 1024 * 1024, CHUNK = 10 * 1024 * 1024;
  const single = size <= MAX_SINGLE;
  const chunkSize = single ? size : CHUNK;
  const count = single ? 1 : Math.floor(size / CHUNK);
  const init = await api('/post/publish/inbox/video/init/', token, {
    source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count },
  });
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? size - 1 : start + chunkSize - 1; // the last chunk takes the remainder
    const part = video.subarray(start, end + 1);
    const res = await fetch(init.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(part.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
      body: new Uint8Array(part),
    });
    if (!res.ok) throw new Error(`tiktok_upload_${res.status}`);
  }
  return init.publish_id as string;
}

export async function publishStatus(token: string, publishId: string) {
  const d = await api('/post/publish/status/fetch/', token, { publish_id: publishId });
  return { status: String(d?.status ?? 'UNKNOWN'), failReason: d?.fail_reason as string | undefined };
}
