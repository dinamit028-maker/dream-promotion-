'use client';
import { useEffect, useState } from 'react';
import { PRICE_PER_SECOND, type ClipUpdate } from '@/lib/services/video.service';
import { Card, Chip, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Check, Warning } from '@/components/ui/Icon';
import { cx } from '@/lib/utils';

/**
 * Reel studio — small building blocks shared by the wizard steps.
 * Moved out of app/(app)/reels/page.tsx without changes (V2.30 refactor, step 1).
 */
export type Res = keyof typeof PRICE_PER_SECOND;
export type Clip = ClipUpdate & { startedAt?: number; code?: string; kind?: 'video' | 'image'; draft?: boolean; still?: string };

export const LENGTHS = [10, 15, 30, 45];
const ROLE_HE: Record<string, string> = {
  hook: 'הוק', problem: 'בעיה', solution: 'פתרון', proof: 'הוכחה', cta: 'קריאה לפעולה',
};

/** The model sometimes packs the whole structure into one role name; show something readable. */
export function roleLabel(role: string | undefined, i: number) {
  if (!role) return `קליפ ${i + 1}`;
  const parts = role.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (parts.length > 2) return `קליפ ${i + 1}`;
  const he = parts.map((p) => ROLE_HE[p]).filter(Boolean);
  return he.length ? he.join(' · ') : role;
}

export function ClipBadge({ clip, elapsed }: { clip?: Clip; elapsed: number }) {
  if (!clip) return <Pill>ממתין</Pill>;
  const t = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  if (clip.status === 'queued') return <Pill tone="warn"><Spinner />בתור{clip.position ? ` · ${clip.position}` : ''} · {t}</Pill>;
  if (clip.status === 'running') return <Pill tone="ai"><Spinner />מרנדר · {t}</Pill>;
  if (clip.status === 'done') return <Pill tone="ok"><Check size={13} weight="bold" aria-hidden />מוכן</Pill>;
  return <Pill tone="warn"><Warning size={13} weight="bold" aria-hidden />נכשל</Pill>;
}

/** Plays finished clips back to back, so a 45s reel can be judged as one piece. */
export function SequencePlayer({ items }: { items: { url: string; kind: 'video' | 'image'; motion?: string | null; seconds?: number }[] }) {
  const [i, setI] = useState(0);
  useEffect(() => { if (i >= items.length) setI(0); }, [items.length, i]);
  // stills hold the screen for four seconds, the way they will in the finished reel
  useEffect(() => {
    if (items[i]?.kind !== 'image') return;
    const t = setTimeout(() => setI((n) => (n + 1 < items.length ? n + 1 : n)), (items[i]?.seconds || 4) * 1000);
    return () => clearTimeout(t);
  }, [i, items]);

  const cur = items[i];
  if (!cur) return null;
  return (
    <Card className="p-3">
      <div className="mx-auto w-full max-w-[300px]">
        {cur.kind === 'image'
          ? <div className="aspect-9/16 w-full overflow-hidden rounded-xl bg-black">
              <img key={`${i}-${cur.url}`} src={cur.url} alt="" style={{ ['--kb-dur' as any]: `${cur.seconds || 4}s` }}
                className={cx('h-full w-full object-cover', cur.motion && `kb kb-${cur.motion}`)} />
            </div>
          : <video key={cur.url} src={cur.url} controls playsInline autoPlay={i > 0}
              onEnded={() => setI((n) => (n + 1 < items.length ? n + 1 : n))}
              className="aspect-9/16 w-full rounded-xl bg-black object-cover" />}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {items.map((it, n) => (
          <div key={it.url} className="flex items-center gap-1">
            <Chip on={n === i} onClick={() => setI(n)}>{it.kind === 'image' ? 'תמונה' : 'קליפ'} {n + 1}</Chip>
            <a href={it.url} target="_blank" rel="noopener noreferrer" download
              className="text-xs font-semibold text-primary underline-offset-2 hover:underline">הורדה</a>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function SaveBadge({ state }: { state: 'idle' | 'saving' | 'saved' | 'local' | 'no_migration' | 'error' }) {
  if (state === 'idle') return null;
  if (state === 'saving') return <Pill><Spinner />שומר…</Pill>;
  if (state === 'saved') return <Pill tone="ok"><Check size={13} weight="bold" aria-hidden />נשמר בחשבון</Pill>;
  if (state === 'no_migration') return <Pill tone="warn">הפרויקט לא נשמר — צריך להריץ את המיגרציה ב-Supabase</Pill>;
  if (state === 'local') return <Pill tone="warn">חלק מהקבצים לא נשמרו בחשבון</Pill>;
  return <Pill tone="warn">השמירה נכשלה</Pill>;
}
