'use client';
import Link from 'next/link';
import type { ContentItem } from '@/types';
import { Visual } from '@/components/ui/Visual';
import { Pill } from '@/components/ui/primitives';
import { KIND_HE, fmtDay } from '@/lib/utils';

const statusPill = (s: ContentItem['status']) =>
  s === 'published' ? <Pill tone="ok">פורסם</Pill>
  : s === 'scheduled' ? <Pill tone="warn">מתוזמן</Pill>
  : <Pill>טיוטה</Pill>;

export function ContentCard({ item }: { item: ContentItem }) {
  return (
    <Link href={`/content?id=${item.id}`}
      className="block overflow-hidden rounded-lg border border-line bg-surface shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
      <Visual emoji={item.emoji} palette={item.palette} mediaId={item.mediaId}
        ratio={item.kind === 'reel' || item.kind === 'story' ? 'portrait' : 'square'} className="rounded-none" />
      <div className="p-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <Pill tone="ai">{KIND_HE[item.kind]}</Pill>{statusPill(item.status)}
        </div>
        <strong className="text-[15px]">{item.headline || 'ללא כותרת'}</strong>
        <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-ink-2">{item.caption}</p>
        {item.date && <p className="mt-2 text-xs text-muted">{fmtDay(item.date)}{item.time ? ` · ${item.time}` : ''}</p>}
      </div>
    </Link>
  );
}
