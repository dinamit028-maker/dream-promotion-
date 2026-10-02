import { isCloudConfigured, supabase } from '@/lib/supabase/client';

export class IntegrationRequiredError extends Error {
  constructor(public provider: string, public what: string) {
    super(`${provider} integration required for ${what}`);
  }
}

export type PostFormat = 'reel' | 'feed' | 'story' | 'tiktok' | 'facebook';
export interface BestTimes {
  research: Record<PostFormat, { days: number[]; time: string; why: string }[]>;
  personal: Record<string, { name: string; error?: string; analyzed?: number; reel?: { hour: number; score: number; posts: number; bestDays: number[] }[]; feed?: { hour: number; score: number; posts: number; bestDays: number[] }[] }>;
}

export interface ScheduleView {
  id: string; runAt: string; status: 'scheduled' | 'publishing' | 'done' | 'partial' | 'failed' | 'cancelled'; lastRunAt: string | null;
  destinations: { accountId: string; provider: 'facebook' | 'instagram' | 'tiktok'; target?: 'feed' | 'story'; name: string;
    result: { state: 'waiting' | 'processing' | 'published' | 'sent_to_drafts' | 'failed'; error?: string; at?: string } }[];
}

export interface SocialAccount {
  id: string; provider: 'tiktok' | 'instagram' | 'facebook';
  name: string | null; avatar: string | null; connectedAt: string; needsReconnect: boolean; readOnly?: boolean;
}

async function authed(path: string, init: RequestInit = {}) {
  if (!isCloudConfigured) throw new Error('חיבורים דורשים חשבון מחובר.');
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('צריך להתחבר מחדש.');
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.message || j.code || `http_${res.status}`), { code: j.code, status: res.status });
  return j;
}

/** Connected social accounts and publishing. Tokens never reach the browser. */
export const SocialService = {
  providers: ['TikTok', 'Instagram', 'Facebook', 'WhatsApp'] as const,

  async accounts(): Promise<{ configured: { tiktok: boolean; meta?: boolean }; accounts: SocialAccount[] }> {
    return authed('/api/social/accounts');
  },
  async connectTikTok() {
    const { url } = await authed('/api/tiktok/connect', { method: 'POST' });
    window.location.href = url;
  },
  /** mode "full": publish + read. mode "read": read only — Meta refuses any publish call for it. */
  async connectMeta(mode: 'full' | 'read') {
    const { url } = await authed('/api/meta/connect', { method: 'POST', body: JSON.stringify({ mode }) });
    window.location.href = url;
  },
  /** Facebook Page: published at once. Instagram: returns a container that is published by polling metaStatus. */
  /** coverMs: for a reel, the moment of the video used as its cover. */
  async sendToMeta(accountId: string, mediaId: string, caption: string, target: 'feed' | 'story', coverMs?: number): Promise<{ state: string; containerId?: string; id?: string }> {
    return authed('/api/meta/publish', { method: 'POST', body: JSON.stringify({ accountId, mediaId, caption, target, coverMs }) });
  },
  async metaStatus(accountId: string, containerId: string): Promise<{ state: 'processing' | 'published' | 'failed'; reason?: string }> {
    return authed('/api/meta/publish/status', { method: 'POST', body: JSON.stringify({ accountId, containerId }) });
  },
  /** Live Instagram stories → media library. Without accountId: every connected Instagram account. */
  async importStories(accountId?: string): Promise<{ added: { id: string; url: string; name: string; kind: 'image' | 'video' }[]; recent?: { id: string; url: string; name: string; kind: 'image' | 'video' }[]; already: number; noFile: number; failed: number; live: number; errors: string[] }> {
    return authed('/api/meta/stories', { method: 'POST', body: JSON.stringify({ accountId }) });
  },
  /** One round of "pull every post and reel"; call again with state until done. */
  async importPosts(state?: { account: number; after: string | null } | null, days?: number): Promise<{
    added: { id: string; url: string; name: string; kind: 'image' | 'video' }[];
    already: number; noFile: number; failed: number; scanned: number; errors: string[];
    done: boolean; state: { account: number; after: string | null } | null; rateLimited?: boolean;
  }> {
    return authed('/api/meta/posts', { method: 'POST', body: JSON.stringify({ state, days }) });
  },
  /** Removes every file pulled from Instagram (posts & reels, or stories) — rows and stored files. */
  async removeImported(source: 'instagram_post' | 'instagram_story'): Promise<{ removed: number }> {
    return authed('/api/media/imported', { method: 'DELETE', body: JSON.stringify({ source }) });
  },
  /** Removes the chosen library files (rows and stored files). */
  async removeMany(ids: string[]): Promise<{ removed: number }> {
    return authed('/api/media/imported', { method: 'DELETE', body: JSON.stringify({ ids }) });
  },
  /** Live check with Meta: which Instagram / Facebook connections actually work right now. */
  async checkMeta(): Promise<{ results: { id: string; ok: boolean; reason?: string; reconnect?: boolean }[] }> {
    return authed('/api/social/check');
  },
  /** Recommended posting times: research defaults + each Instagram account's own best hours. */
  async bestTimes(): Promise<BestTimes> {
    return authed('/api/insights/best-times');
  },
  // ---- scheduled publishing
  async getSchedule(contentId: string): Promise<{ schedule: ScheduleView | null }> {
    return authed(`/api/schedule?contentId=${encodeURIComponent(contentId)}`);
  },
  async schedule(p: { contentId: string | null; mediaId: string; caption: string; runAt: string; destinations: { accountId: string; target?: 'feed' | 'story'; coverMs?: number }[] }): Promise<{ id: string }> {
    return authed('/api/schedule', { method: 'POST', body: JSON.stringify(p) });
  },
  async cancelSchedule(id: string): Promise<{ ok: boolean }> {
    return authed(`/api/schedule?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async disconnect(id: string) {
    await authed(`/api/social/accounts?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  /** Video → the creator's TikTok inbox; they finish the post in the TikTok app. */
  async sendToTikTok(accountId: string, mediaId: string, contentId?: string | null): Promise<{ publishId: string; postId: string | null }> {
    return authed('/api/tiktok/upload', { method: 'POST', body: JSON.stringify({ accountId, mediaId, contentId }) });
  },
  async tiktokStatus(accountId: string, publishId: string, postId?: string | null): Promise<{ status: string; failReason?: string }> {
    return authed('/api/tiktok/status', { method: 'POST', body: JSON.stringify({ accountId, publishId, postId }) });
  },
};

/** Kept for older imports. */
export const SocialPublishingService = SocialService;
