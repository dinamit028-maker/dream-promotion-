import type { MediaAsset } from '@/types';
import { uid } from '@/lib/utils';

/**
 * MediaService — upload adapter.
 * Default: browser-session object URLs, and the UI says they are not persisted.
 * Production: swap for a signed-URL flow (S3 / Supabase Storage / Cloudinary).
 */
export const MediaService = {
  persistent: Boolean(process.env.NEXT_PUBLIC_STORAGE_READY),
  async upload(file: File): Promise<MediaAsset> {
    const kind = file.type.startsWith('video') ? 'video' : 'image';
    if (this.persistent) {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/media/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error('upload_failed');
      const { id, url } = await res.json();
      return { id, url, name: file.name, kind, persistent: true };
    }
    return { id: uid(), url: URL.createObjectURL(file), name: file.name, kind, persistent: false };
  },
};
