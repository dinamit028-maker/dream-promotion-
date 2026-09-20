'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { useAiReady } from '@/hooks/useAiReady';
import { Button } from '@/components/ui/primitives';
import { GenerationState, Modal, AiUnavailable } from '@/components/ui/feedback';
import { HE_DAYS, HE_MONTHS, addDays, cx, iso, today } from '@/lib/utils';
import type { ContentKind, Platform } from '@/types';

const PLAN_STEPS = ['קורא את פרופיל המותג…', 'מאזן סוגי תוכן…', 'בוחר שעות פרסום…', 'כותב את הקאפשנים…'];

export function ContentCalendar() {
  const aiReady = useAiReady();
  const { content, brand, addContent, updateContent } = useApp();
  const [cursor, setCursor] = useState(new Date());
  const [planning, setPlanning] = useState(false);
  const [step, setStep] = useState(0);
  const [drag, setDrag] = useState<string | null>(null);

  const y = cursor.getFullYear(), m = cursor.getMonth();
  const first = new Date(y, m, 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });

  async function planWeek() {
    if (!aiReady) { setPlanning(true); return; }
    setPlanning(true); setStep(0);
    const tick = setInterval(() => setStep((s) => Math.min(PLAN_STEPS.length - 1, s + 1)), 850);
    try {
      const res = await AIService.weeklyPlan(brand);
      (res.items || []).forEach((it: any) => {
        addContent({
          kind: (it.kind || 'post') as ContentKind,
          platform: (it.platform || 'Instagram') as Platform,
          goal: it.goal || '', headline: it.headline || it.idea || 'רעיון', caption: it.caption || '',
          hashtags: [], cta: brand.cta, emoji: it.emoji || '✦', palette: ['#6B3BF5', '#A96BF8'],
          visualDirection: it.visual_direction, mediaId: null, status: 'scheduled',
          date: addDays(today(), Math.max(0, Math.min(6, it.dayOffset ?? 0))), time: it.time || '19:30',
        });
      });
    } finally { clearInterval(tick); setPlanning(false); }
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-extrabold sm:text-3xl">יומן התוכן</h2>
          <p className="mt-1 text-muted">{HE_MONTHS[m]} {y}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setCursor(new Date(y, m + 1, 1))}>›</Button>
          <Button variant="ghost" size="sm" onClick={() => setCursor(new Date())}>היום</Button>
          <Button variant="ghost" size="sm" onClick={() => setCursor(new Date(y, m - 1, 1))}>‹</Button>
          <Button variant="primary" size="sm" onClick={planWeek}>✦ תכנן לי את השבוע</Button>
        </div>
      </div>

      <div className="mb-2 grid grid-cols-7 gap-2">
        {HE_DAYS.map((d) => <div key={d} className="pb-1 text-center text-xs font-bold text-muted">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-2">
        {cells.map((d) => {
          const key = iso(d);
          const items = content.filter((c) => c.date === key);
          return (
            <div key={key}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (drag) { updateContent(drag, { date: key, status: 'scheduled' }); setDrag(null); } }}
              className={cx('flex min-h-[76px] flex-col gap-1.5 rounded-2xl border border-line bg-surface p-1.5 sm:min-h-[112px] sm:p-2',
                d.getMonth() !== m && 'opacity-45',
                key === today() && 'border-primary shadow-[0_0_0_3px_var(--primary-soft)]')}>
              <span className="text-xs font-bold text-muted">{d.getDate()}</span>
              {items.map((c) => (
                <div key={c.id} draggable onDragStart={() => setDrag(c.id)}
                  className="flex cursor-grab items-center gap-1.5 overflow-hidden rounded-lg bg-surface-2 px-1.5 py-1 text-[11px] font-semibold">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px]"
                    style={{ background: `linear-gradient(135deg, ${c.palette[0]}, ${c.palette[1]})` }}>{c.emoji}</span>
                  <span className="truncate">{c.headline}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <Modal open={planning} onClose={() => setPlanning(false)}>
        <h3 className="mb-4 font-display text-xl font-extrabold">בונה לך שבוע שלם</h3>
        {aiReady ? <GenerationState lines={PLAN_STEPS} step={step} /> : <AiUnavailable />}
      </Modal>
    </>
  );
}
