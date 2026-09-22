'use client';
import type { ContentItem } from '@/types';
import { useApp } from '@/lib/store';
import { Visual } from '@/components/ui/Visual';
import { Pill } from '@/components/ui/primitives';
import { fmtDay } from '@/lib/utils';
import { Clock } from '@/components/ui/Icon';

const statusPill = (s: ContentItem['status']) =>
  s === 'published' ? <Pill tone="ok">פורסם</Pill>
  : s === 'scheduled' ? <Pill tone="warn">מתוזמן</Pill>
  : <Pill>טיוטה</Pill>;

export function ContentCard({ item }: { item: ContentItem }) {
  const openEditor = useApp((s) => s.openEditor);
  return (
    <button type="button" onClick={() => openEditor(item.id)}
      className="block w-full overflow-hidden rounded-lg border border-line bg-surface text-start shadow-sm transition-shadow hover:shadow-md">
      <Visual kind={item.kind} headline={item.headline || 'ללא כותרת'} palette={item.palette} mediaId={item.mediaId}
        ratio={item.kind === 'reel' || item.kind === 'story' ? 'portrait' : 'square'} className="rounded-none" />
      <div className="p-4">
        <p className="line-clamp-2 text-sm leading-relaxed text-ink-2">{item.caption}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          {statusPill(item.status)}
          {item.date && (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Clock size={13} aria-hidden />{fmtDay(item.date)}{item.time ? `, ${item.time}` : ''}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
