'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { useAiReady } from '@/hooks/useAiReady';
import { Button } from '@/components/ui/primitives';
import { AdapterNote, AiUnavailable, GenerationState, Modal } from '@/components/ui/feedback';
import { aiErrorMessage } from '@/lib/errors';
import { PALETTE, addDays, today } from '@/lib/utils';
import type { ContentKind, Platform } from '@/types';

const PLAN_STEPS = ['קורא את פרופיל המותג…', 'מאזן סוגי תוכן…', 'בוחר שעות פרסום…', 'כותב את הקאפשנים…'];
const KINDS = ['post', 'reel', 'story', 'ad'];
const PLATFORMS = ['Instagram', 'Facebook', 'TikTok'];

/** One week planner shared by the calendar and the strategy screen. Errors are shown, never swallowed. */
export function usePlanWeek() {
  const aiReady = useAiReady();
  const { brand, addContent } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(0);

  async function run() {
    setOpen(true); setError(null); setAdded(0);
    if (!aiReady) return;
    setBusy(true); setStep(0);
    const tick = setInterval(() => setStep((s) => Math.min(PLAN_STEPS.length - 1, s + 1)), 1500);
    try {
      const res = await AIService.weeklyPlan(brand);
      const items = Array.isArray(res?.items) ? res.items : [];
      if (!items.length) throw Object.assign(new Error('empty'), { code: 'invalid_json' });
      items.forEach((it: any) => {
        const kind = (KINDS.includes(it.kind) ? it.kind : 'post') as ContentKind;
        addContent({
          kind,
          platform: (PLATFORMS.includes(it.platform) ? it.platform : 'Instagram') as Platform,
          goal: it.goal || '', headline: it.headline || it.idea || 'רעיון', caption: it.caption || '',
          hashtags: Array.isArray(it.hashtags) ? it.hashtags.filter(Boolean) : [],
          cta: it.cta || brand.cta, emoji: it.emoji || '', palette: PALETTE[kind] ?? PALETTE.post,
          visualDirection: it.visual_direction, mediaId: null, status: 'scheduled',
          date: addDays(today(), Math.max(0, Math.min(6, Number(it.dayOffset) || 0))),
          time: /^\d{1,2}:\d{2}$/.test(it.time || '') ? it.time : '19:30',
        });
      });
      setAdded(items.length);
    } catch (e: any) {
      setError(aiErrorMessage(e?.code));
    } finally { clearInterval(tick); setBusy(false); }
  }

  const dialog = (
    <Modal open={open} onClose={() => !busy && setOpen(false)}>
      <h3 className="mb-4 font-display text-xl font-extrabold">בונה לך שבוע שלם</h3>
      {aiReady === false && <AiUnavailable />}
      {busy && <GenerationState lines={PLAN_STEPS} step={step} />}
      {error && (
        <AdapterNote title="בניית השבוע נכשלה.">
          {error}
          <div className="mt-3"><Button size="sm" variant="ghost" onClick={run}>ניסיון נוסף</Button></div>
        </AdapterNote>
      )}
      {!busy && !error && added > 0 && (
        <>
          <p className="mb-4 text-ok">נוספו {added} פריטים ליומן. לחצו על כל פריט כדי להוסיף תמונה ולערוך את הטקסט.</p>
          <Button variant="primary" onClick={() => setOpen(false)}>לצפייה</Button>
        </>
      )}
    </Modal>
  );

  return { run, busy, dialog };
}
