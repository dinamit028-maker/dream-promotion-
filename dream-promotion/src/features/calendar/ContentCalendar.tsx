'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Field, Input, Pill } from '@/components/ui/primitives';
import { AiUnavailable, GenerationState, Modal } from '@/components/ui/feedback';
import { HE_DAYS, HE_MONTHS, KIND_HE, addDays, cx, dayName, fmtDay, iso, today } from '@/lib/utils';
import type { ContentKind, Platform } from '@/types';

const PLAN_STEPS = ['קורא את פרופיל המותג…', 'מאזן סוגי תוכן…', 'בוחר שעות פרסום…', 'כותב את הקאפשנים…'];

export function ContentCalendar() {
  const router = useRouter();
  const aiReady = useAiReady();
  const { content, brand, addContent, updateContent, openEditor } = useApp();
  const [cursor, setCursor] = useState(new Date());
  const [planning, setPlanning] = useState(false);
  const [step, setStep] = useState(0);
  const [drag, setDrag] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);   // the day sheet
  const [dayTime, setDayTime] = useState('19:30');

  const y = cursor.getFullYear(), m = cursor.getMonth();
  const first = new Date(y, m, 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });

  const unscheduled = content.filter((c) => !c.date && c.status !== 'published');
  const onDay = day ? content.filter((c) => c.date === day) : [];

  function placeOnDay(id: string) {
    if (!day) return;
    updateContent(id, { date: day, time: dayTime, status: 'scheduled' });
  }

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
          <p className="mt-1 text-muted">{HE_MONTHS[m]} {y} · לחצו על יום כדי לתזמן אליו</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setCursor(new Date(y, m + 1, 1))} aria-label="החודש הבא">›</Button>
          <Button variant="ghost" size="sm" onClick={() => setCursor(new Date())}>היום</Button>
          <Button variant="ghost" size="sm" onClick={() => setCursor(new Date(y, m - 1, 1))} aria-label="החודש הקודם">‹</Button>
          <Button variant="primary" size="sm" onClick={planWeek}>✦ תכנן לי את השבוע</Button>
        </div>
      </div>

      <div className="mb-2 grid grid-cols-7 gap-1.5 sm:gap-2">
        {HE_DAYS.map((d) => <div key={d} className="pb-1 text-center text-xs font-bold text-muted">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
        {cells.map((d) => {
          const key = iso(d);
          const items = content.filter((c) => c.date === key);
          const past = key < today();
          return (
            <div key={key} role="button" tabIndex={0}
              onClick={() => setDay(key)}
              onKeyDown={(e) => e.key === 'Enter' && setDay(key)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (drag) { updateContent(drag, { date: key, status: 'scheduled' }); setDrag(null); } }}
              className={cx(
                'flex min-h-[72px] cursor-pointer flex-col gap-1 rounded-xl border border-line bg-surface p-1 transition-colors hover:border-primary sm:min-h-[112px] sm:gap-1.5 sm:rounded-2xl sm:p-2',
                d.getMonth() !== m && 'opacity-40',
                past && 'bg-surface-2',
                key === today() && 'border-primary shadow-[0_0_0_3px_var(--primary-soft)]',
              )}>
              <span className={cx('text-xs font-bold', key === today() ? 'text-primary' : 'text-muted')}>{d.getDate()}</span>
              {/* mobile: dots; desktop: chips */}
              <div className="flex flex-wrap gap-1 sm:hidden">
                {items.map((c) => (
                  <span key={c.id} className="h-2 w-2 rounded-full"
                    style={{ background: `linear-gradient(135deg, ${c.palette[0]}, ${c.palette[1]})` }} />
                ))}
              </div>
              <div className="hidden flex-col gap-1.5 sm:flex">
                {items.map((c) => (
                  <div key={c.id} draggable
                    onDragStart={() => setDrag(c.id)}
                    onClick={(e) => { e.stopPropagation(); openEditor(c.id); }}
                    className="flex cursor-grab items-center gap-1.5 overflow-hidden rounded-lg bg-surface-2 px-1.5 py-1 text-[11px] font-semibold hover:bg-primary-soft">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px]"
                      style={{ background: `linear-gradient(135deg, ${c.palette[0]}, ${c.palette[1]})` }}>{c.emoji}</span>
                    <span className="truncate">{c.headline}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ---------- day sheet: works the same on phone and desktop ---------- */}
      <Modal open={!!day} onClose={() => setDay(null)}>
        {day && (
          <>
            <div className="mb-5 flex items-center justify-between">
              <h3 className="font-display text-2xl font-extrabold">יום {dayName(day)}׳, {fmtDay(day)}</h3>
              <Button variant="ghost" size="sm" onClick={() => setDay(null)} aria-label="סגירה">✕</Button>
            </div>

            {onDay.length > 0 && (
              <div className="mb-6">
                <p className="mb-2 text-sm font-semibold text-ink-2">כבר ביום הזה</p>
                <div className="grid gap-2">
                  {onDay.map((c) => (
                    <button key={c.id} type="button" onClick={() => { setDay(null); openEditor(c.id); }}
                      className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3 text-start hover:bg-primary-soft">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg"
                        style={{ background: `linear-gradient(135deg, ${c.palette[0]}, ${c.palette[1]})` }}>{c.emoji}</span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm">{c.headline}</strong>
                        <span className="text-xs text-muted">{c.time} · {KIND_HE[c.kind]} · לחצו לעריכה או להזזה</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <p className="mb-2 text-sm font-semibold text-ink-2">להוסיף ליום הזה</p>
            <div className="mb-4 w-36">
              <Field label="בשעה"><Input type="time" value={dayTime} onChange={(e) => setDayTime(e.target.value)} /></Field>
            </div>

            {unscheduled.length > 0 ? (
              <div className="mb-5 grid max-h-64 gap-2 overflow-y-auto">
                {unscheduled.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-2xl border border-line p-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg"
                      style={{ background: `linear-gradient(135deg, ${c.palette[0]}, ${c.palette[1]})` }}>{c.emoji}</span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">{c.headline}</strong>
                      <Pill>טיוטה · {KIND_HE[c.kind]}</Pill>
                    </span>
                    <Button size="sm" variant="primary" onClick={() => placeOnDay(c.id)}>שיבוץ</Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mb-5 rounded-2xl bg-surface-2 p-4 text-sm text-muted">אין טיוטות שמחכות לתזמון.</p>
            )}

            <Button variant="ghost" className="w-full"
              onClick={() => router.push(`/create?date=${day}&time=${encodeURIComponent(dayTime)}`)}>
              ✦ יצירת תוכן חדש ליום הזה
            </Button>
          </>
        )}
      </Modal>

      <Modal open={planning} onClose={() => setPlanning(false)}>
        <h3 className="mb-4 font-display text-xl font-extrabold">בונה לך שבוע שלם</h3>
        {aiReady ? <GenerationState lines={PLAN_STEPS} step={step} /> : <AiUnavailable />}
      </Modal>
    </>
  );
}
