'use client';
import { useApp } from '@/lib/store';

/** Small preview of an attached image, if any. */
export function MediaThumb({ mediaId }: { mediaId: string | null }) {
  const m = useApp((s) => (mediaId ? s.media.find((x) => x.id === mediaId) : undefined));
  if (!m) return null;
  return m.kind === 'video'
    ? <video src={m.url} muted className="mb-2 aspect-video w-full rounded-lg object-cover" />
    : <img src={m.url} alt="" className="mb-2 aspect-video w-full rounded-lg object-cover" />;
}
