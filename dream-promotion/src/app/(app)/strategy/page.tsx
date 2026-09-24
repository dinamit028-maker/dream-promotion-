'use client';
import { useApp } from '@/lib/store';
import { Button, Card, PageHead, Pill } from '@/components/ui/primitives';
import { KIND_HE, addDays, dayName, fmtDay, today } from '@/lib/utils';
import { Sparkle } from '@/components/ui/Icon';
import { MediaThumb } from '@/features/media/MediaThumb';
import { usePlanWeek } from '@/features/calendar/usePlanWeek';

export default function StrategyPage() {
  const { content, openEditor } = useApp();
  const planner = usePlanWeek();
  const week = Array.from({ length: 7 }, (_, i) => addDays(today(), i));
  return (
    <>
      <PageHead title="האסטרטגיה השבועית" sub="מה לפרסם, מתי ולמה"
        action={<Button variant="primary" onClick={planner.run} disabled={planner.busy}><Sparkle size={18} weight="fill" aria-hidden />בניית שבוע</Button>} />
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        {week.map((d) => {
          const items = content.filter((c) => c.date === d);
          return (
            <Card key={d} className="p-4">
              <div className="flex items-center justify-between">
                <strong>{dayName(d)}׳</strong>
                <span className="text-sm text-muted">{fmtDay(d)}</span>
              </div>
              <div className="my-3 h-px bg-line" />
              {items.length ? items.map((c) => (
                <button key={c.id} type="button" onClick={() => openEditor(c.id)} className="mb-3 block w-full text-start">
                  <MediaThumb mediaId={c.mediaId} />
                  <Pill tone="ai">{KIND_HE[c.kind]}</Pill>
                  <strong className="mt-1.5 block text-sm">{c.headline}</strong>
                  <span className="text-xs text-muted">{c.time} · {c.platform}</span>
                </button>
              )) : <p className="text-sm text-muted">יום פנוי</p>}
            </Card>
          );
        })}
      </div>
      {planner.dialog}
    </>
  );
}
