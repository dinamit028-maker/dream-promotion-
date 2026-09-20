'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Card, Chip, Field, Input, Select, Textarea, Pill } from '@/components/ui/primitives';
import { AdapterNote, AiUnavailable, EmptyState, GenerationState } from '@/components/ui/feedback';
import { Visual } from '@/components/ui/Visual';
import { KIND_HE, today } from '@/lib/utils';
import type { ContentKind, GeneratedVariant, Platform } from '@/types';

const STEPS = ['מנתח את המותג שלך…', 'בונה זווית שיווקית…', 'כותב את הפתיח…', 'מנסח קריאה לפעולה…'];

export function CreateStudio() {
  const router = useRouter();
  const aiReady = useAiReady();
  const { brand, addContent } = useApp();
  const [kind, setKind] = useState<ContentKind>('post');
  const [platform, setPlatform] = useState<Platform>('Instagram');
  const [goal, setGoal] = useState('יותר פניות');
  const [brief, setBrief] = useState('');
  const [variants, setVariants] = useState<GeneratedVariant[]>([]);
  const [picked, setPicked] = useState(0);
  const [step, setStep] = useState(-1);
  const [error, setError] = useState<string | null>(null);

  const v = variants[picked];

  async function generate() {
    setError(null); setVariants([]); setStep(0);
    const tick = setInterval(() => setStep((s) => Math.min(STEPS.length - 1, s + 1)), 900);
    try {
      const res = await AIService.generateContent(brand, { kind, platform, goal, brief });
      setVariants((res.variants || []).map((x) => ({
        ...x, emoji: x.emoji || '✦', palette: (x.palette?.length ? x.palette : ['#6B3BF5', '#FF7FA8']) as [string, string],
      })));
      setPicked(0);
    } catch (e: any) {
      setError(e.code || 'error');
    } finally {
      clearInterval(tick); setStep(-1);
    }
  }

  function save(status: 'draft' | 'scheduled') {
    if (!v) return;
    addContent({
      kind, platform, goal, headline: v.headline, caption: v.caption, hashtags: v.hashtags || [],
      cta: v.cta, emoji: v.emoji, palette: v.palette, visualDirection: v.visual_direction,
      mediaId: null, status, date: status === 'scheduled' ? today() : null, time: status === 'scheduled' ? '19:30' : null,
    });
    router.push(status === 'scheduled' ? '/calendar' : '/content');
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
      <Card>
        <Field label="מה יוצרים?">
          <div className="flex flex-wrap gap-2">
            {(['post', 'reel', 'story', 'ad'] as ContentKind[]).map((k) => (
              <Chip key={k} on={kind === k} onClick={() => setKind(k)}>{KIND_HE[k]}</Chip>
            ))}
          </div>
        </Field>
        <Field label="פלטפורמה">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            {['Instagram', 'Facebook', 'TikTok'].map((p) => <option key={p}>{p}</option>)}
          </Select>
        </Field>
        <Field label="מטרה">
          <Select value={goal} onChange={(e) => setGoal(e.target.value)}>
            {['יותר פניות', 'יותר תורים', 'יותר עוקבים', 'מודעות למותג', 'מכירות'].map((g) => <option key={g}>{g}</option>)}
          </Select>
        </Field>
        <Field label="בריף חופשי">
          <Textarea value={brief} onChange={(e) => setBrief(e.target.value)}
            placeholder="על מה התוכן? מבצע? שירות חדש? לקוחה מרוצה?" />
        </Field>
        <Button variant="primary" size="lg" className="w-full" onClick={generate} disabled={!aiReady || step >= 0}>
          ✦ ייצור תוכן
        </Button>
        {aiReady === false && <div className="mt-4"><AiUnavailable /></div>}
      </Card>

      <div>
        {step >= 0 && <GenerationState lines={STEPS} step={step} />}
        {error && (
          <AdapterNote title="היצירה נכשלה.">
            קוד: {error}. לא נכתב טקסט מקומי במקום, כדי שלא תקבלו תוכן שלא נוצר על ידי המודל.
            <div className="mt-3"><Button size="sm" variant="ghost" onClick={generate}>ניסיון נוסף</Button></div>
          </AdapterNote>
        )}
        {step < 0 && !error && !variants.length && (
          <EmptyState emoji="✦" title="הקנבס מחכה" body="מלאו את הבריף ותקבלו כמה זוויות שונות לבחירה." />
        )}
        {v && (
          <>
            <div className="mb-4 flex flex-wrap gap-2">
              {variants.map((x, i) => (
                <Chip key={i} on={i === picked} onClick={() => setPicked(i)}>{x.angle || `גרסה ${i + 1}`}</Chip>
              ))}
              <Button size="sm" variant="ghost" onClick={generate}>↻ ייצור מחדש</Button>
            </div>
            <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
              <Visual emoji={v.emoji} palette={v.palette} ratio={kind === 'reel' || kind === 'story' ? 'vertical' : 'square'} />
              <Card>
                <Pill tone="ai">{KIND_HE[kind]} · {platform}</Pill>
                <h3 className="mb-4 mt-3 font-display text-xl font-extrabold">{v.headline}</h3>
                <Field label="טקסט הפוסט">
                  <Textarea className="min-h-40" value={v.caption}
                    onChange={(e) => setVariants((vs) => vs.map((x, i) => i === picked ? { ...x, caption: e.target.value } : x))} />
                </Field>
                <Field label="האשטגים">
                  <Input value={(v.hashtags || []).join(' ')}
                    onChange={(e) => setVariants((vs) => vs.map((x, i) => i === picked ? { ...x, hashtags: e.target.value.split(/\s+/).filter(Boolean) } : x))} />
                </Field>
                <Field label="קריאה לפעולה">
                  <Input value={v.cta}
                    onChange={(e) => setVariants((vs) => vs.map((x, i) => i === picked ? { ...x, cta: e.target.value } : x))} />
                </Field>
                {v.visual_direction && <AdapterNote><strong>כיוון ויזואלי: </strong>{v.visual_direction}</AdapterNote>}
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button variant="primary" onClick={() => save('draft')}>שמירה כטיוטה</Button>
                  <Button variant="ghost" onClick={() => save('scheduled')}>תזמון ליומן</Button>
                </div>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
