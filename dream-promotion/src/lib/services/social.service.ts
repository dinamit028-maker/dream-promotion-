import { isCloudConfigured, supabase } from '@/lib/supabase/client';

export class IntegrationRequiredError extends Error {
  constructor(public provider: string, public what: string) {
    super(`${provider} integration required for ${what}`);
  }
}

export interface SocialAccount {
  id: string; provider: 'tiktok' | 'instagram' | 'facebook';
  name: string | null; avatar: string | null; connectedAt: string; needsReconnect: boolean;
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

  async accounts(): Promise<{ configured: { tiktok: boolean }; accounts: SocialAccount[] }> {
    return authed('/api/social/accounts');
  },
  async connectTikTok() {
    const { url } = await authed('/api/tiktok/connect', { method: 'POST' });
    window.location.href = url;
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
