import { adminDb } from './admin';
import { open, seal } from './secrets';

/**
 * Meta (Facebook Pages + Instagram professional accounts) through Facebook Login for Business.
 * Two login configurations decide what a connection may do:
 *  - "full": publish to the Page / Instagram and read stories
 *  - "read": read only (stories into the media library) — Meta itself refuses any publish call
 * Page tokens obtained from a long-lived user token do not expire; they are stored encrypted.
 */
const V = process.env.META_GRAPH_VERSION || 'v23.0';
const GRAPH = `https://graph.facebook.com/${V}`;

export type MetaMode = 'full' | 'read';
export const metaConfigured = () =>
  Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_CONFIG_FULL);

export const metaRedirectUri = (req: Request) =>
  process.env.META_REDIRECT_URI || `${new URL(req.url).origin}/api/meta/callback`;

export function metaAuthorizeUrl(req: Request, mode: MetaMode, state: string) {
  const config = mode === 'read' ? process.env.META_CONFIG_READ : process.env.META_CONFIG_FULL;
  if (!config) throw new Error('not_configured');
  const p = new URLSearchParams({
    client_id: process.env.META_APP_ID!, redirect_uri: metaRedirectUri(req), config_id: config,
    state, response_type: 'code', override_default_response_type: 'true',
  });
  return `https://www.facebook.com/${V}/dialog/oauth?${p}`;
}

/** Graph call; throws "reconnect_required" when the token is no longer valid. */
async function graph(path: string, params: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET') {
  const url = new URL(`${GRAPH}${path}`);
  const init: RequestInit = { method };
  if (method === 'GET') Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  else init.body = new URLSearchParams(params);
  const res = await fetch(url, init);
  const j: any = await res.json().catch(() => ({}));
  if (j?.error) {
    const e = j.error;
    if (e.code === 190 || (e.type === 'OAuthException' && /expired|invalid|session/i.test(e.message || ''))) throw new Error('reconnect_required');
    if (e.code === 10 || e.code === 200) throw new Error(`permission_denied: ${e.message}`);
    throw new Error(`meta_${e.code ?? res.status}: ${e.error_user_msg || e.message || 'error'}`);
  }
  if (!res.ok) throw new Error(`meta_http_${res.status}`);
  return j;
}

/** code → long-lived user token (about 60 days; only used right away to read the Page tokens). */
export async function exchangeCode(req: Request, code: string): Promise<string> {
  const short = await graph('/oauth/access_token', {
    client_id: process.env.META_APP_ID!, client_secret: process.env.META_APP_SECRET!,
    redirect_uri: metaRedirectUri(req), code,
  });
  const long = await graph('/oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID!,
    client_secret: process.env.META_APP_SECRET!, fb_exchange_token: short.access_token,
  });
  return long.access_token as string;
}

type Page = {
  id: string; name: string; access_token: string; picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
};

/** Stores every Page (and its linked Instagram account) the user granted in the consent screen. */
export async function saveMetaAccounts(userId: string, userToken: string, mode: MetaMode) {
  const res = await graph('/me/accounts', {
    access_token: userToken, limit: '100',
    fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
  });
  const pages: Page[] = res.data ?? [];
  const now = new Date().toISOString();
  const rows = pages.flatMap((p) => {
    const token = seal(p.access_token);
    const out: Record<string, unknown>[] = [{
      user_id: userId, provider: 'facebook', external_id: p.id, display_name: p.name,
      avatar_url: p.picture?.data?.url ?? null, access_token: token, refresh_token: null,
      expires_at: null, refresh_expires_at: null, scope: mode, updated_at: now,
    }];
    const ig = p.instagram_business_account;
    if (ig?.id) out.push({
      user_id: userId, provider: 'instagram', external_id: ig.id,
      display_name: ig.username ? `@${ig.username}` : p.name, avatar_url: ig.profile_picture_url ?? null,
      access_token: token, refresh_token: null, expires_at: null, refresh_expires_at: null, scope: mode, updated_at: now,
    });
    return out;
  });
  if (!rows.length) return 0;
  const { error } = await adminDb().from('social_accounts').upsert(rows, { onConflict: 'user_id,provider,external_id' });
  if (error) throw new Error(`save_account: ${error.message}`);
  return rows.length;
}

export type MetaAccount = { id: string; provider: 'facebook' | 'instagram'; externalId: string; name: string | null; mode: MetaMode; token: string };

export async function metaAccount(userId: string, accountId: string): Promise<MetaAccount> {
  const { data: a } = await adminDb().from('social_accounts').select('*')
    .eq('id', accountId).eq('user_id', userId).in('provider', ['facebook', 'instagram']).maybeSingle();
  if (!a) throw new Error('account_not_found');
  return { id: a.id, provider: a.provider, externalId: a.external_id, name: a.display_name, mode: a.scope === 'read' ? 'read' : 'full', token: open(a.access_token) };
}

// ------------------------------------------------------------------ publishing --

/** Facebook Page: photo or video post, published right away. */
export async function publishToPage(acc: MetaAccount, media: { url: string; kind: string }, caption: string) {
  if (media.kind === 'video') {
    const r = await graph(`/${acc.externalId}/videos`, { access_token: acc.token, file_url: media.url, description: caption, published: 'true' }, 'POST');
    return String(r.id);
  }
  const r = await graph(`/${acc.externalId}/photos`, { access_token: acc.token, url: media.url, caption }, 'POST');
  return String(r.post_id || r.id);
}

export type IgTarget = 'feed' | 'reel' | 'story';

/** Instagram, step 1: a media container. Instagram fetches the file from the URL itself. */
export async function createIgContainer(acc: MetaAccount, media: { url: string; kind: string }, caption: string, target: IgTarget, coverMs?: number) {
  const p: Record<string, string> = { access_token: acc.token };
  if (target === 'story') {
    p.media_type = 'STORIES';
    p[media.kind === 'video' ? 'video_url' : 'image_url'] = media.url;
  } else if (media.kind === 'video') {
    p.media_type = 'REELS'; p.video_url = media.url; p.caption = caption; p.share_to_feed = 'true';
    // the cover: the frame at this point of the video (Instagram's default is the very first frame)
    p.thumb_offset = String(Math.max(0, Math.round(coverMs ?? 500)));
  } else {
    p.image_url = media.url; p.caption = caption;
  }
  const r = await graph(`/${acc.externalId}/media`, p, 'POST');
  return String(r.id);
}

/** Instagram, step 2: once the container is FINISHED, publish it. */
export async function igContainerStep(acc: MetaAccount, containerId: string) {
  const s = await graph(`/${containerId}`, { access_token: acc.token, fields: 'status_code,status' });
  const code = String(s.status_code || 'IN_PROGRESS');
  if (code === 'ERROR' || code === 'EXPIRED') return { state: 'failed' as const, reason: String(s.status || code) };
  if (code === 'PUBLISHED') return { state: 'published' as const };
  if (code !== 'FINISHED') return { state: 'processing' as const };
  const r = await graph(`/${acc.externalId}/media_publish`, { access_token: acc.token, creation_id: containerId }, 'POST');
  return { state: 'published' as const, id: String(r.id) };
}

// ------------------------------------------------------------------ stories --

type IgStory = { id: string; media_type: string; media_url?: string; timestamp?: string };

/**
 * Copies the account's live stories (the last 24 hours) into the media library.
 * Stories with licensed music come back without a file (Meta's rule) and are counted, not copied.
 */
export async function importStories(userId: string, acc: MetaAccount, limit = 10) {
  const db = adminDb();
  const res = await graph(`/${acc.externalId}/stories`, { access_token: acc.token, fields: 'id,media_type,media_url,timestamp' });
  const stories: IgStory[] = res.data ?? [];
  const added: { id: string; url: string; name: string; kind: 'image' | 'video' }[] = [];
  let already = 0, noFile = 0, failed = 0;

  for (const s of stories) {
    if (added.length >= limit) break;
    const isVideo = s.media_type === 'VIDEO';
    const path = `${userId}/instagram-stories/${acc.externalId}/${s.id}.${isVideo ? 'mp4' : 'jpg'}`;
    const { data: exists } = await db.from('media').select('id').eq('user_id', userId).eq('storage_path', path).maybeSingle();
    if (exists) { already++; continue; }
    if (!s.media_url) { noFile++; continue; }
    try {
      const file = await fetch(s.media_url);
      if (!file.ok) throw new Error(String(file.status));
      const buf = Buffer.from(await file.arrayBuffer());
      const up = await db.storage.from('assets').upload(path, buf, { contentType: isVideo ? 'video/mp4' : 'image/jpeg', upsert: false });
      if (up.error && !/exists/i.test(up.error.message)) throw new Error(up.error.message);
      const signed = await db.storage.from('assets').createSignedUrl(path, 60 * 60 * 24 * 365);
      if (!signed.data?.signedUrl) throw new Error('no_read_link');
      const when = s.timestamp ? new Date(s.timestamp) : new Date();
      const name = `סטורי · ${acc.name ?? 'Instagram'} · ${when.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })} ${when.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })}`;
      const kind = isVideo ? 'video' : 'image';
      const row = await db.from('media').insert({
        user_id: userId, url: signed.data.signedUrl, storage_path: path, name, kind,
        tags: ['סטורי', 'אינסטגרם'], source: 'instagram_story',
      }).select('id').single();
      if (row.error) throw new Error(row.error.message);
      added.push({ id: row.data.id, url: signed.data.signedUrl, name, kind });
    } catch { failed++; }
  }
  return { added, already, noFile, failed, live: stories.length };
}

/** Stories already in the library from the last two days — the browser merges them (the timer may have added some). */
export async function recentStoryMedia(userId: string) {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data } = await adminDb().from('media').select('id, url, name, kind, created_at')
    .eq('user_id', userId).eq('source', 'instagram_story').gte('created_at', since)
    .order('created_at', { ascending: false }).limit(50);
  return (data ?? []).map((m) => ({ id: m.id as string, url: m.url as string, name: m.name as string, kind: m.kind as 'image' | 'video' }));
}
