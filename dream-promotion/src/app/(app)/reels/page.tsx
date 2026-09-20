'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService, VideoService } from '@/lib/services';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Card, Chip, Field, PageHead, Pill, Select, Textarea } from '@/components/ui/primitives';
import { AdapterNote, AiUnavailable, EmptyState, GenerationState } from '@/components/ui/feedback';
import { Visual } from '@/components/ui/Visual';
import type { Storyboard } from '@/types';

export default function ReelsPage() {
  const aiReady = useAiReady();
  const { brand, addContent } = useApp();
  const [brief, setBrief] = useState('');
  const [duration, setDuration] = useState(20);
  const [board, setBoard] = useState<Storyboard | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try { setBoard(await AIService.storyboard(brand, brief, duration)); }
    catch { setBoard(null); }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHead title="אולפן הרילס" sub="ה-AI בונה סטוריבורד מלא. הרינדור מחכה לחיבור ספק וידאו." />
      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card>
          <Field label="נושא הריל">
            <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="למשל: למה טיפול פנים לפני החורף" />
          </Field>
          <Field label="אורך">
            <div className="flex flex-wrap gap-2">
              {[15, 20, 30, 45].map((d) => <Chip key={d} on={duration === d} onClick={() => setDuration(d)}>{d} שנ׳</Chip>)}
            </div>
          </Field>
          <Field label="קריינות">
            <Select>{['נשי · חם', 'נשי · אנרגטי', 'גברי · רגוע', 'ללא קריינות'].map((v) => <option key={v}>{v}</option>)}</Select>
          </Field>
          <Button variant="primary" size="lg" className="w-full" onClick={generate} disabled={!aiReady || busy}>
            ✦ בניית סטוריבורד
          </Button>
          {aiReady === false && <div className="mt-4"><AiUnavailable /></div>}
        </Card>

        <div>
          {busy && <GenerationState lines={['קורא את המותג…', 'בונה מבנה סצנות…', 'כותב טקסטים למסך…']} step={1} />}
          {!busy && !board && <EmptyState emoji="▶" title="אין עדיין סטוריבורד" body="תארו נושא ונקבל מבנה סצנה-אחר-סצנה עם טקסטים וקריינות." />}
          {board && (
            <>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="font-display text-xl font-extrabold">{board.title}</h3>
                <Button size="sm" variant="primary" onClick={() => addContent({
                  kind: 'reel', platform: 'Instagram', goal: '', headline: board.title, caption: board.caption || '',
                  hashtags: board.hashtags || [], cta: brand.cta, emoji: board.scenes?.[0]?.emoji || '▶',
                  palette: ['#6B3BF5', '#FF7FA8'], scenes: board.scenes, mediaId: null,
                  status: 'draft', date: null, time: null,
                })}>שמירה לתוכן</Button>
              </div>
              <div className="grid items-start gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
                <Visual emoji={board.scenes?.[0]?.emoji || '▶'} palette={['#6B3BF5', '#FF7FA8']} ratio="vertical" />
                <div>
                  <div className="grid gap-2.5">
                    {board.scenes?.map((s, i) => (
                      <Card key={i} className="p-4">
                        <div className="flex items-center justify-between">
                          <Pill tone="ai">{s.role || `סצנה ${i + 1}`}</Pill>
                          <span className="text-sm text-muted">{s.seconds} שנ׳</span>
                        </div>
                        <strong className="mt-2 block">{s.onScreen}</strong>
                        <p className="mt-1 text-sm text-muted">קריינות: {s.voiceover || '—'}</p>
                        <p className="text-sm text-muted">ויזואל: {s.visual || '—'}</p>
                      </Card>
                    ))}
                  </div>
                  {!VideoService.configured && (
                    <div className="mt-4">
                      <AdapterNote title="רינדור וידאו — לא מחובר.">
                        <code>VideoService</code> ממתין לספק (Runway / Pika / HeyGen / Creatomate).
                        אין כאן כפתור ייצוא שמעמיד פנים שהוא מרנדר.
                      </AdapterNote>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
