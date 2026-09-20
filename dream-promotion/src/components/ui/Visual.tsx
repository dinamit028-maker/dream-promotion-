'use client';
import { useApp } from '@/lib/store';
import { cx } from '@/lib/utils';

type Ratio = 'square' | 'vertical' | 'portrait';
const ratios: Record<Ratio, string> = { square: 'aspect-square', vertical: 'aspect-[9/16]', portrait: 'aspect-[4/5]' };

/** Content visual: real media when present, otherwise branded artwork — never a grey box. */
export function Visual({
  emoji = '✦', palette, mediaId, ratio = 'square', className,
}: { emoji?: string; palette?: [string, string]; mediaId?: string | null; ratio?: Ratio; className?: string }) {
  const media = useApp((s) => (mediaId ? s.media.find((m) => m.id === mediaId) : undefined));
  const bg = palette ? `linear-gradient(135deg, ${palette[0]}, ${palette[1] || palette[0]})` : 'var(--grad-soft)';
  return (
    <div className={cx('relative isolate flex items-center justify-center overflow-hidden rounded-md', ratios[ratio], className)} style={{ background: bg }}>
      {media && (media.kind === 'video'
        ? <video src={media.url} muted loop playsInline className="absolute inset-0 h-full w-full object-cover" />
        : <img src={media.url} alt="" className="absolute inset-0 h-full w-full object-cover" />)}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_20%_10%,rgba(255,255,255,.45),transparent_60%)]" />
      <span className="relative z-10 text-5xl drop-shadow-[0_6px_14px_rgba(0,0,0,.16)]">{emoji}</span>
    </div>
  );
}
