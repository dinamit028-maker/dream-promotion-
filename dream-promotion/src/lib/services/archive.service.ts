'use client';
import { supabase, isCloudConfigured } from '@/lib/supabase/client';

/** Copies a provider URL into the signed-in user's storage. Returns the durable URL. */
export async function archiveAsset(url: string, kind: 'video' | 'image' | 'audio', name: string): Promise<{ id?: string; url: string }> {
  if (!isCloudConfigured) return { url };
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { url };
  try {
    const res = await fetch('/api/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url, kind, name }),
    });
    const j = await res.json().catch(() => ({}));
    return j?.url ? { id: j.id, url: j.url } : { url };
  } catch {
    return { url };
  }
}
