'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { cx } from '@/lib/utils';
import type { MediaAsset } from '@/types';

export type PreviewPlatform = 'ig-feed' | 'ig-reel' | 'story' | 'tiktok' | 'facebook';
export const PREVIEW_TABS: { id: PreviewPlatform; label: string }[] = [
  { id: 'ig-feed', label: 'Instagram פיד' },
  { id: 'ig-reel', label: 'Instagram ריל' },
  { id: 'story', label: 'סטורי' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'facebook', label: 'Facebook' },
];
const RATIO: Record<PreviewPlatform, string> = {
  'ig-feed': 'aspect-[4/5]', 'ig-reel': 'aspect-[9/16]', story: 'aspect-[9/16]', tiktok: 'aspect-[9/16]', facebook: 'aspect-square',
};

/** The media as it will actually play — autoplaying and live, with sound on tap. */
function LiveMedia({ media, palette }: { media?: MediaAsset; palette: [string, string] }) {
  if (!media) return <div className="absolute inset-0" style={{ background: `linear-gradient(160deg, ${palette[0]}, ${palette[1]})` }} />;
  return media.kind === 'video'
    ? <video key={media.url} src={media.url} autoPlay muted loop playsInline controls className="absolute inset-0 h-full w-full bg-black object-cover" />
    : <img src={media.url} alt="" className="absolute inset-0 h-full w-full object-cover" />;
}

/**
 * How one piece of content looks on each network — feed, reel, story, TikTok, Facebook —
 * each with its real crop and the chrome people will see around it.
 */
export function PlatformPreview({
  mediaId, headline, caption, palette = ['#6B3BF5', '#FF7FA8'], initial = 'ig-feed',
}: { mediaId: string | null; headline: string; caption: string; palette?: [string, string]; initial?: PreviewPlatform }) {
  const [tab, setTab] = useState<PreviewPlatform>(initial);
  const brand = useApp((s) => s.brand);
  const media = useApp((s) => (mediaId ? s.media.find((m) => m.id === mediaId) : undefined));
  const name = brand.name || 'העסק שלך';
  const vertical = tab !== 'ig-feed' && tab !== 'facebook';

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {PREVIEW_TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={cx('rounded-full px-3 py-1.5 text-sm font-semibold transition',
              tab === t.id ? 'bg-primary text-white' : 'bg-surface-2 text-ink-2 hover:bg-line')}>
            {t.label}
          </button>
        ))}
      </div>

      <div className={cx('mx-auto overflow-hidden rounded-[28px] border-[6px] border-ink bg-white text-ink shadow-xl', vertical ? 'w-[260px]' : 'w-[320px]')}>
        {!vertical && (
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="h-7 w-7 rounded-full" style={{ background: `linear-gradient(135deg, ${palette[0]}, ${palette[1]})` }} />
            <span className="text-[13px] font-semibold">{name}</span>
            <span className="ms-auto text-[11px] text-muted">{tab === 'facebook' ? 'ממומן · 🌐' : 'ממומן'}</span>
          </div>
        )}

        <div className={cx('relative isolate', RATIO[tab])}>
          <LiveMedia media={media} palette={palette} />
          {headline && (
            <p className={cx('pointer-events-none absolute inset-x-4 font-display font-bold leading-snug text-white drop-shadow-[0_2px_8px_rgba(0,0,0,.6)]',
              vertical ? 'top-[38%] text-center text-xl' : 'bottom-4 text-lg')}>
              {headline}
            </p>
          )}
          {vertical && (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/50 to-transparent p-3 text-white">
                {tab === 'story' && <span className="absolute inset-x-3 top-1.5 h-0.5 rounded bg-white/70" />}
                <span className="h-6 w-6 rounded-full border border-white" style={{ background: palette[0] }} />
                <span className="text-xs font-semibold">{name}</span>
                <span className="ms-auto text-xs">{tab === 'tiktok' ? 'בשבילך' : tab === 'ig-reel' ? 'Reels' : ''}</span>
              </div>
              {tab !== 'story' && (
                <div className="pointer-events-none absolute bottom-16 left-2 flex flex-col items-center gap-4 text-xs text-white">
                  <span>♥<br />1.2K</span><span>💬<br />84</span><span>↗</span>
                </div>
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 pt-10 text-white">
                {tab === 'story'
                  ? <div className="mx-auto w-fit rounded-full bg-white/90 px-4 py-1.5 text-xs font-semibold text-ink">שלחו הודעה</div>
                  : <p className="line-clamp-2 text-xs">{caption}</p>}
              </div>
            </>
          )}
        </div>

        {!vertical && (
          <div className="px-3 py-2">
            <div className="mb-1 flex gap-3 text-lg">{tab === 'facebook' ? <span className="text-sm">👍 אהבתי · 💬 תגובה · ↗ שיתוף</span> : <><span>♡</span><span>💬</span><span>↗</span></>}</div>
            <p className="line-clamp-3 text-[12px]"><strong>{name}</strong> {caption}</p>
          </div>
        )}
      </div>
      {media?.kind === 'video' && <p className="mt-3 text-center text-xs text-muted">הסרטון מתנגן בלייב. לחצו עליו כדי להפעיל סאונד.</p>}
    </div>
  );
}
