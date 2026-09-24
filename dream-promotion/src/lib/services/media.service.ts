import type { MediaAsset } from '@/types';
import { uid } from '@/lib/utils';
import { supabase, isCloudConfigured } from '@/lib/supabase/client';

/**
 * MediaService — upload adapter.
 * Signed in: the file goes straight from the browser into the private `assets`
 * bucket under the user's own folder, and a row is written to `media`.
 * Not signed in / no Supabase: browser-session object URL (lost on refresh).
 */
export const MediaService = {
  persistent: isCloudConfigured,

  async upload(file: File): Promise<MediaAsset> {
    const kind: MediaAsset['kind'] = file.type.startsWith('video') ? 'video' : 'image';

    if (isCloudConfigured) {
      const sb = supabase();
      const { data } = await sb.auth.getUser();
      const user = data.user;
      if (user) {
        const ext = (file.name.split('.').pop() || (kind === 'video' ? 'mp4' : 'jpg')).toLowerCase();
        const path = `${user.id}/upload/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

        const up = await sb.storage.from('assets').upload(path, file, { contentType: file.type, upsert: false });
        if (up.error) throw new Error(`upload_failed: ${up.error.message}`);

        const signed = await sb.storage.from('assets').createSignedUrl(path, 60 * 60 * 24 * 365);
        if (!signed.data?.signedUrl) throw new Error('sign_failed');

        const id = crypto.randomUUID();
        const row = await sb.from('media').insert({
          id, user_id: user.id, url: signed.data.signedUrl, storage_path: path,
          name: file.name, kind, source: 'upload',
        });
        if (row.error) throw new Error(`row_failed: ${row.error.message}`);

        return { id, url: signed.data.signedUrl, name: file.name, kind, persistent: true };
      }
    }
    return { id: uid(), url: URL.createObjectURL(file), name: file.name, kind, persistent: false };
  },
};
