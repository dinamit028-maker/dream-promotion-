'use client';
import { useApp } from '@/lib/store';
import { KIND_HE, cx } from '@/lib/utils';
import { KindIcon } from './Icon';
import type { ContentKind } from '@/types';

type Ratio = 'square' | 'vertical' | 'portrait';
const ratios: Record<Ratio, string> = { square: 'aspect-square', vertical: 'aspect-[9/16]', portrait: 'aspect-[4/5]' };

/**
 * A piece of content drawn the way it will look in the feed: the brand colour field,
 * the headline set large, and the format marked in the corner. Real media replaces
 * the colour field when attached. A bottom scrim keeps white text readable on any
 * palette the model returns.
 */
export function Visual({
  palette, mediaId, ratio = 'square', kind = 'post', headline, className, size = 'md',
}: {
  palette?: [string, string]; mediaId?: string | null; ratio?: Ratio; kind?: ContentKind;
  headline?: string; className?: string; size?: 'sm' | 'md' | 'lg';
}) {
  const media = useApp((s) => (mediaId ? s.media.find((m) => m.id === mediaId) : undefined));
  const [a, b] = palette ?? ['#6B3BF5', '#FF7FA8'];
  const text = { sm: 'text-sm', md: 'text-lg', lg: 'text-2xl sm:text-3xl' }[size];

  return (
    <div className={cx('relative isolate overflow-hidden rounded-md', ratios[ratio], className)}
      style={{ background: `linear-gradient(160deg, ${a} 0%, ${b} 100%)` }}>
      {media && (media.kind === 'video'
        ? <video src={media.url} autoPlay muted loop playsInline className="absolute inset-0 h-full w-full object-cover" />
        : <img src={media.url} alt="" className="absolute inset-0 h-full w-full object-cover" />)}

      {/* large faint format mark gives the field structure without an illustration */}
      {!media && (
        <KindIcon kind={kind} weight="thin" className="absolute -bottom-[12%] -left-[10%] h-[70%] w-[70%] text-white/15" />
      )}

      <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-[rgba(20,14,40,.62)] to-transparent" />

      <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-black/25 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
        <KindIcon kind={kind} size={12} weight="bold" />
        {KIND_HE[kind]}
      </span>

      {headline && (
        <p className={cx('absolute inset-x-4 bottom-4 line-clamp-3 font-display font-bold leading-snug text-white', text)}>
          {headline}
        </p>
      )}
    </div>
  );
}

/** Small swatch used in dense lists (calendar chips, pickers). */
export function Swatch({ palette, kind, className }: { palette: [string, string]; kind: ContentKind; className?: string }) {
  return (
    <span className={cx('flex shrink-0 items-center justify-center rounded-md text-white', className ?? 'h-5 w-5')}
      style={{ background: `linear-gradient(160deg, ${palette[0]}, ${palette[1]})` }}>
      <KindIcon kind={kind} size={12} weight="bold" />
    </span>
  );
}
