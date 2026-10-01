import type { MediaAsset } from '@/types';
import { uid } from '@/lib/utils';
import { supabase, isCloudConfigured } from '@/lib/supabase/client';

async function api(token: string, body: Record<string, unknown>) {
  const res = await fetch('/api/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || j.code || `media_${res.status}`);
  return j;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg',
};

/**
 * MediaService — upload adapter.
 * Signed in: the server hands out a one-time upload link into the user's folder,
 * the browser uploads straight to storage, and the server registers the file.
 * Not signed in: browser-session object URL (lost on refresh).
 */
export const MediaService = {
  persistent: isCloudConfigured,

  async upload(file: File): Promise<MediaAsset> {
    // some phones hand over files with no type; the extension fills it in (storage only accepts media types)
    const extOf = (file.name.includes('.') ? file.name.split('.').pop() : '')!.toLowerCase();
    const type = file.type || MIME_BY_EXT[extOf] || '';
    const kind: MediaAsset['kind'] = type.startsWith('video') ? 'video' : type.startsWith('audio') ? 'audio' : 'image';

    if (isCloudConfigured) {
      const sb = supabase();
      const { data } = await sb.auth.getSession();
      const token = data.session?.access_token;
      if (token) {
        const ext = file.name.includes('.') ? file.name.split('.').pop() : kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'jpg';
        const signed = await api(token, { action: 'sign', ext: String(ext).toLowerCase(), size: file.size });
        const up = await sb.storage.from('assets').uploadToSignedUrl(signed.path, signed.token, file, { contentType: type || undefined });
        if (up.error) throw new Error(up.error.message);
        const reg = await api(token, { action: 'register', path: signed.path, name: file.name, kind });
        return { id: reg.id, url: reg.url, name: file.name, kind, persistent: true };
      }
    }
    return { id: uid(), url: URL.createObjectURL(file), name: file.name, kind, persistent: false };
  },
};
