import { safeFetch } from './safe-fetch';
import { adminDb } from './admin';
import { open, seal } from './secrets';
import { canUseBusiness } from './business';
import { assetsFromPages, planMetaSync, type StoredAsset } from './meta-sync';

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

/** one request with every permission (publish + read) — the "read only" configuration is no longer offered */
/** the one-time cookie of a Meta connection in progress (connect → callback, this browser only) */
export const META_OAUTH_COOKIE = 'dp_meta_oauth';

export function metaAuthorizeUrl(req: Request, state: string) {
  const config = process.env.META_CONFIG_FULL;
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
    // only a dead token means "reconnect" (code 190, or the session subcodes). Other OAuthException
    // errors — "(#100) Invalid parameter" and friends — are request problems and keep Meta's own words.
    const sessionDead = e.code === 190 || [458, 459, 460, 463, 464, 467].includes(Number(e.error_subcode));
    if (sessionDead) throw new Error(`reconnect_required: ${e.error_user_msg || e.message || ''}`.slice(0, 300));
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

/**
 * One Meta connection per Facebook user (multi-business, stage 3). The super admin approves once;
 * every Page and linked Instagram account comes back and is upserted — never deleted. A new asset
 * has no business until it is assigned; one that did not come back is marked 'missing'.
 */
export async function saveMetaConnection(userId: string, userToken: string) {
  const db = adminDb();
  const me = await graph('/me', { access_token: userToken, fields: 'id,name' });
  const perms = await graph('/me/permissions', { access_token: userToken }).catch(() => ({ data: [] }));
  const scopes = ((perms.data ?? []) as { permission: string; status: string }[]).filter((p) => p.status === 'granted').map((p) => p.permission);
  const now = new Date();
  const { data: conn, error: connErr } = await db.from('meta_connections').upsert({
    user_id: userId, fb_user_id: String(me.id), fb_user_name: String(me.name ?? ''), access_token: seal(userToken), scopes,
    expires_at: new Date(now.getTime() + 60 * 864e5).toISOString(), last_synced_at: now.toISOString(),
  }, { onConflict: 'user_id,fb_user_id' }).select('id').single();
  if (connErr || !conn) throw new Error(`save_connection: ${connErr?.message ?? 'no row'}`);

  const pages: Parameters<typeof assetsFromPages>[0] = [];
  let after: string | null = null;
  do {
    const res: any = await graph('/me/accounts', {
      access_token: userToken, limit: '100', ...(after ? { after } : {}),
      fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
    });
    pages.push(...(res.data ?? []));
    after = res.paging?.next ? res.paging?.cursors?.after ?? null : null;
  } while (after && pages.length < 1000);

  const { data: rows, error: readErr } = await db.from('social_accounts')
    .select('id, provider, external_id, user_id, business_id, connection_id, status, display_name').in('provider', ['facebook', 'instagram']);
  if (readErr) throw new Error(`read_accounts: ${readErr.message}`);
  const stored: StoredAsset[] = (rows ?? []).map((r: any) => ({
    id: r.id, provider: r.provider, externalId: r.external_id, userId: r.user_id, businessId: r.business_id,
    connectionId: r.connection_id, status: r.status === 'missing' ? 'missing' : 'active', name: r.display_name,
  }));
  const plan = planMetaSync(stored, assetsFromPages(pages), conn.id, userId, seal);
  const stamp = now.toISOString();
  for (const u of plan.update) {
    const { id, ...set } = u;
    const { error } = await db.from('social_accounts').update({ ...set, updated_at: stamp }).eq('id', id);
    if (error) throw new Error(`update_account: ${error.message}`);
  }
  if (plan.insert.length) {
    const { error } = await db.from('social_accounts').insert(plan.insert.map((r) => ({ ...r, refresh_token: null, expires_at: null, refresh_expires_at: null, updated_at: stamp })));
    if (error) throw new Error(`insert_account: ${error.message}`);
  }
  if (plan.missing.length) {
    await db.from('social_accounts').update({ status: 'missing', missing_since: stamp, updated_at: stamp }).in('id', plan.missing.map((m) => m.id));
  }
  return { assets: plan.update.length + plan.insert.length, added: plan.insert.length, missing: plan.missing.map((m) => m.name ?? '') };
}

export type MetaAccount = {
  id: string; provider: 'facebook' | 'instagram'; externalId: string; name: string | null; mode: MetaMode; token: string;
  businessId: string | null; status: 'active' | 'missing';
};

/** a stored page / Instagram account, for someone allowed to use its business (an unassigned one: super admin only) */
export async function metaAccount(userId: string, accountId: string): Promise<MetaAccount> {
  const { data: a } = await adminDb().from('social_accounts').select('*')
    .eq('id', accountId).in('provider', ['facebook', 'instagram']).maybeSingle();
  if (!a || !(await canUseBusiness(userId, a.business_id))) throw new Error('account_not_found');
  if (a.status === 'missing') throw new Error(`reconnect_required: ${a.display_name ?? ''} — העמוד נותק מהחיבור ל-Meta`);
  return {
    id: a.id, provider: a.provider, externalId: a.external_id, name: a.display_name, mode: a.scope === 'read' ? 'read' : 'full',
    token: open(a.access_token), businessId: a.business_id ?? null, status: a.status === 'missing' ? 'missing' : 'active',
  };
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
      const file = await safeFetch(s.media_url, { maxBytes: 300 * 1024 * 1024, timeoutMs: 60_000 });
      if (!file.ok) throw new Error(String(file.status));
      const buf = Buffer.from(await file.arrayBuffer());
      const up = await db.storage.from('assets').upload(path, buf, { contentType: isVideo ? 'video/mp4' : 'image/jpeg', upsert: false });
      if (up.error && !/exists/i.test(up.error.message)) throw new Error(up.error.message);
      const signed = await db.storage.from('assets').createSignedUrl(path, 60 * 60 * 24 * 365);
      if (!signed.data?.signedUrl) throw new Error('no_read_link');
      const when = s.timestamp ? new Date(s.timestamp) : new Date();
      const name = `סטורי · ${acc.name ?? 'Instagram'} · ${when.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })} ${when.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })}`;
      const kind = isVideo ? 'video' : 'image';
      const id = await insertImported({
        user_id: userId, ...(acc.businessId ? { business_id: acc.businessId } : {}), url: signed.data.signedUrl, storage_path: path, name, kind,
        tags: ['סטורי', 'אינסטגרם'], source: 'instagram_story',
      }, { igId: s.id, account: acc.name ?? null, accountId: acc.externalId, takenAt: s.timestamp ?? null, type: 'story' });
      added.push({ id, url: signed.data.signedUrl, name, kind });
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

/** Media row for an imported file, with where it came from (falls back cleanly before migration 800). */
async function insertImported(row: Record<string, unknown>, meta: Record<string, unknown>) {
  const db = adminDb();
  let res = await db.from('media').insert({ ...row, meta }).select('id').single();
  if (res.error && /meta/.test(res.error.message)) res = await db.from('media').insert(row).select('id').single();
  if (res.error) throw new Error(res.error.message);
  return res.data.id as string;
}

/** Meta is limiting this app / user for now — stop, keep what was saved, continue later. */
export const isRateLimited = (m: string) => /meta_(4|17|32|613|80001|80002)\b|rate limit|too many calls/i.test(m);

// ------------------------------------------------------------ posts & reels --
type IgMedia = {
  id: string; media_type: string; media_product_type?: string; media_url?: string; thumbnail_url?: string;
  timestamp?: string; caption?: string; children?: { data: { id: string; media_type: string; media_url?: string }[] };
};

/**
 * Copies the account's published posts and reels (the whole profile, newest first) into the
 * media library. Unlike stories they stay on the profile, so everything can be pulled — page by
 * page: each call works until the deadline and returns the cursor to continue from.
 * Carousel posts become one file per photo/video. Items Meta gives no file for (reels with
 * licensed music, some copyright cases) are counted, not retried.
 */
export async function importPosts(userId: string, acc: MetaAccount, opts: { after?: string | null; deadline: number; since?: number | null }) {
  const db = adminDb();
  const added: { id: string; url: string; name: string; kind: 'image' | 'video' }[] = [];
  let already = 0, noFile = 0, failed = 0, scanned = 0;
  let after = opts.after ?? null;

  for (;;) {
    if (Date.now() > opts.deadline) return { added, already, noFile, failed, scanned, after, done: false };
    const res = await graph(`/${acc.externalId}/media`, {
      access_token: acc.token, limit: '25',
      fields: 'id,media_type,media_product_type,media_url,thumbnail_url,timestamp,caption,permalink,children{id,media_type,media_url}',
      ...(after ? { after } : {}),
    });
    const items: IgMedia[] = res.data ?? [];
    for (const m of items) {
      // newest first: the first post older than the chosen period ends the whole pull
      if (opts.since && m.timestamp && new Date(m.timestamp).getTime() < opts.since) {
        return { added, already, noFile, failed, scanned, after: null, done: true };
      }
      scanned++;
      const parts = m.media_type === 'CAROUSEL_ALBUM' && m.children?.data?.length
        ? m.children.data.map((c, k) => ({ id: `${m.id}-${k + 1}`, media_type: c.media_type, media_url: c.media_url }))
        : [{ id: m.id, media_type: m.media_type, media_url: m.media_url }];
      const isReel = m.media_product_type === 'REELS';
      const when = m.timestamp ? new Date(m.timestamp) : new Date();
      const date = when.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
      for (const [k, p] of parts.entries()) {
        const isVideo = p.media_type === 'VIDEO';
        const path = `${userId}/instagram-posts/${acc.externalId}/${p.id}.${isVideo ? 'mp4' : 'jpg'}`;
        const { data: exists } = await db.from('media').select('id').eq('user_id', userId).eq('storage_path', path).maybeSingle();
        if (exists) { already++; continue; }
        if (!p.media_url) { noFile++; continue; }
        try {
          const file = await safeFetch(p.media_url, { maxBytes: 300 * 1024 * 1024, timeoutMs: 40_000 });
          if (!file.ok) throw new Error(String(file.status));
          const buf = Buffer.from(await file.arrayBuffer());
          const up = await db.storage.from('assets').upload(path, buf, { contentType: isVideo ? 'video/mp4' : 'image/jpeg', upsert: false });
          if (up.error && !/exists/i.test(up.error.message)) throw new Error(up.error.message);
          const signed = await db.storage.from('assets').createSignedUrl(path, 60 * 60 * 24 * 365);
          if (!signed.data?.signedUrl) throw new Error('no_read_link');
          const label = isReel ? 'ריל' : parts.length > 1 ? `פוסט ${k + 1}/${parts.length}` : 'פוסט';
          const caption = (m.caption || '').replace(/\s+/g, ' ').trim().slice(0, 40);
          const name = `אינסטגרם · ${label} · ${acc.name ?? ''} · ${date}${caption ? ` · ${caption}` : ''}`;
          const kind = isVideo ? 'video' : 'image';
          const id = await insertImported({
            user_id: userId, ...(acc.businessId ? { business_id: acc.businessId } : {}), url: signed.data.signedUrl, storage_path: path, name, kind,
            tags: ['אינסטגרם', isReel ? 'ריל' : 'פוסט'], source: 'instagram_post',
          }, {
            igId: p.id, parentId: parts.length > 1 ? m.id : null, account: acc.name ?? null, accountId: acc.externalId,
            takenAt: m.timestamp ?? null, type: isReel ? 'reel' : parts.length > 1 ? 'carousel' : 'post',
            caption: (m.caption || '').slice(0, 2000), permalink: (m as any).permalink ?? null,
          });
          added.push({ id, url: signed.data.signedUrl, name, kind });
        } catch { failed++; }
        if (Date.now() > opts.deadline) break;
      }
      if (Date.now() > opts.deadline) {
        // stop inside this page: the next call starts this page again (already-saved items are skipped)
        return { added, already, noFile, failed, scanned, after, done: false };
      }
    }
    after = res.paging?.next ? res.paging?.cursors?.after ?? null : null;
    if (!after) return { added, already, noFile, failed, scanned, after: null, done: true };
  }
}

/** Asks Meta whether this connection still works (a cheap read with the stored token). */
export async function checkMetaAccount(acc: MetaAccount): Promise<{ ok: true } | { ok: false; reason: string; reconnect: boolean }> {
  try {
    await graph(`/${acc.externalId}`, { access_token: acc.token, fields: 'id' });
    return { ok: true };
  } catch (e: any) {
    const m = String(e?.message ?? e);
    return { ok: false, reason: m.replace(/^[a-z_0-9]+:\s*/i, '').slice(0, 240), reconnect: /reconnect_required|permission_denied/.test(m) };
  }
}

// ------------------------------------------------------------------ lead ads --

export type LeadForm = { id: string; name: string; status: string; labels: Record<string, string> };

/** A Page's instant forms, with each question's label (field key → the text the customer saw). */
export async function leadForms(pageToken: string, pageId: string): Promise<LeadForm[]> {
  const out: LeadForm[] = [];
  let after: string | undefined;
  do {
    const j = await graph(`/${pageId}/leadgen_forms`, { access_token: pageToken, fields: 'id,name,status,questions{key,label}', limit: '100', ...(after ? { after } : {}) });
    for (const f of j.data ?? []) {
      const labels: Record<string, string> = {};
      for (const q of f.questions ?? []) if (q?.key && q?.label) labels[String(q.key)] = String(q.label);
      out.push({ id: String(f.id), name: String(f.name ?? ''), status: String(f.status ?? ''), labels });
    }
    after = j.paging?.next ? j.paging?.cursors?.after : undefined;
  } while (after && out.length < 500);
  return out;
}

/** A form's leads created after `sinceUnix` (seconds), oldest pages first as Meta returns them. */
export async function formLeads(pageToken: string, formId: string, sinceUnix: number, max = 1000) {
  const out: { id: string; created_time?: string; field_data?: { name: string; values?: string[] }[]; ad_name?: string; form_id?: string }[] = [];
  let after: string | undefined;
  do {
    const j = await graph(`/${formId}/leads`, {
      access_token: pageToken, fields: 'created_time,id,field_data,ad_name,form_id', limit: '100',
      filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(sinceUnix) }]),
      ...(after ? { after } : {}),
    });
    out.push(...(j.data ?? []));
    after = j.paging?.next ? j.paging?.cursors?.after : undefined;
  } while (after && out.length < max);
  return out;
}

// ------------------------------------------------------------- comments & messages --
// Meta refuses big nested reads ("Please reduce the amount of data you're asking for"): pages are read
// in small batches, and a refused batch is asked again smaller.

const tooMuch = (m: string) => /reduce the amount of data|meta_1:|meta_http_500/i.test(m);

/** pages through an edge in small batches; on "too much data" retries the batch with the next smaller size */
async function pagedSmall(path: string, base: Record<string, string>, fieldsFor: (n: number) => string, sizes: number[], maxPages = 8, stop?: (row: any) => boolean, deadline = Infinity) {
  const out: any[] = [];
  let after: string | undefined; let pages = 0;
  do {
    let j: any = null; let lastErr: unknown;
    for (const n of sizes) {
      try { j = await graph(path, { ...base, limit: String(n), fields: fieldsFor(n), ...(after ? { after } : {}) }); break; }
      catch (e: any) { lastErr = e; if (!tooMuch(String(e?.message ?? e))) throw e; }
    }
    if (!j) throw lastErr;
    const rows = (j.data ?? []) as any[];
    out.push(...rows);
    if (stop && rows.some(stop)) break;
    after = j.paging?.next ? j.paging?.cursors?.after : undefined;
  } while (after && ++pages < maxPages && Date.now() < deadline);
  return out;
}

/** a Page's posts since a moment, each with its latest comments — posts first, then each post's comments
 *  separately (Meta refuses a Page's posts with nested comments as "too much data") */
export async function pagePostsWithComments(pageToken: string, pageId: string, sinceUnix: number, deadline = Infinity) {
  const posts = await pagedSmall(`/${pageId}/posts`, { access_token: pageToken, since: String(Math.floor(sinceUnix)) },
    () => 'id,message,permalink_url,full_picture', [25, 10, 5], 4, undefined, deadline);
  for (const p of posts) {
    if (Date.now() > deadline) { p.comments = { data: [] }; continue; } // out of time: the next run continues
    const comments = await pagedSmall(`/${p.id}/comments`, { access_token: pageToken, order: 'reverse_chronological', filter: 'stream' },
      () => 'id,message,created_time,from{id,name},parent{id}', [50, 25, 10], 4, undefined, deadline);
    p.comments = { data: comments };
  }
  return posts;
}

/** an Instagram account's media (newest first) with comments and replies, back to `sinceIso` */
export async function igMediaWithComments(pageToken: string, igId: string, sinceIso: string, deadline = Infinity) {
  return pagedSmall(`/${igId}/media`, { access_token: pageToken },
    (n) => `id,caption,permalink,timestamp,media_type,media_url,thumbnail_url,comments.limit(${n * 3}){id,text,timestamp,username,from{id,username},replies.limit(10){id,text,timestamp,username,from{id,username}}}`,
    [10, 5, 2], 8, (m) => Boolean(m.timestamp && new Date(m.timestamp).toISOString() < sinceIso), deadline);
}

/** a Page's conversations on Messenger or Instagram Direct (latest first), back to `sinceIso` —
 *  the conversations first, then each one's messages separately */
export async function pageConversations(pageToken: string, pageId: string, platform: 'messenger' | 'instagram', sinceIso: string, deadline = Infinity) {
  const convs = await pagedSmall(`/${pageId}/conversations`, { access_token: pageToken, platform },
    () => 'id,updated_time,participants', [25, 10, 5], 8,
    (c) => Boolean(c.updated_time && new Date(c.updated_time).toISOString() < sinceIso), deadline);
  const fresh = convs.filter((c) => !c.updated_time || new Date(c.updated_time).toISOString() >= sinceIso);
  for (const c of fresh) {
    if (Date.now() > deadline) { c.messages = { data: [] }; continue; }
    const msgs = await pagedSmall(`/${c.id}/messages`, { access_token: pageToken }, () => 'id,message,created_time,from,sticker,attachments{mime_type}', [25, 10, 5], 2);
    c.messages = { data: msgs };
  }
  return fresh;
}

/** the Instagram account linked to a Page (for Instagram Direct), or null */
export async function linkedInstagram(pageToken: string, pageId: string): Promise<{ id: string; username: string } | null> {
  const j = await graph(`/${pageId}`, { access_token: pageToken, fields: 'instagram_business_account{id,username}' });
  const ig = j.instagram_business_account;
  return ig?.id ? { id: String(ig.id), username: String(ig.username ?? '') } : null;
}

/** a Messenger reply to a person (PSID) — allowed by Meta within 24 hours of their last message */
export async function sendMessengerText(pageToken: string, pageId: string, psid: string, text: string): Promise<string> {
  const j = await graph(`/${pageId}/messages`, {
    access_token: pageToken, messaging_type: 'RESPONSE',
    recipient: JSON.stringify({ id: psid }), message: JSON.stringify({ text }),
  }, 'POST');
  return String(j.message_id ?? j.id ?? '');
}

/** a public reply under a comment: Instagram → /replies, Facebook → /comments (needs pages_manage_engagement) */
export async function replyToComment(pageToken: string, commentId: string, text: string, platform: 'facebook' | 'instagram'): Promise<string> {
  const j = await graph(`/${commentId}/${platform === 'instagram' ? 'replies' : 'comments'}`, { access_token: pageToken, message: text }, 'POST');
  return String(j.id ?? '');
}

/**
 * A copy of a post's picture in storage (Meta's own link expires within days) → a long-lived link, '' if it failed.
 * One file per post: the second comment on the same post reuses it.
 */
export async function keepPostImage(folder: string, threadId: string, url: string): Promise<string> {
  if (!url) return '';
  try {
    const db = adminDb();
    const path = `${folder}/inbox-posts/${threadId.replace(/[^\w-]/g, '_')}.jpg`;
    const file = await safeFetch(url, { maxBytes: 15 * 1024 * 1024, timeoutMs: 20_000 });
    if (!file.ok) return '';
    const up = await db.storage.from('assets').upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.headers.get('content-type') || 'image/jpeg', upsert: true });
    if (up.error) return '';
    const signed = await db.storage.from('assets').createSignedUrl(path, 60 * 60 * 24 * 365 * 5);
    return signed.data?.signedUrl ?? '';
  } catch { return ''; }
}
