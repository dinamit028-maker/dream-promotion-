'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Card, Chip, Field, Input, Select, Textarea, Pill } from '@/components/ui/primitives';
import { AdapterNote, AiUnavailable, EmptyState, GenerationState, Modal, Spinner } from '@/components/ui/feedback';
import { ScheduleFields } from '@/features/calendar/ScheduleFields';
import { Visual } from '@/components/ui/Visual';
import { KIND_HE, today } from '@/lib/utils';
import type { ContentKind, GeneratedVariant, Platform } from '@/types';
import { ArrowsClockwise, CalendarBlank, FilmSlate, MagicWand, Sparkle } from '@/components/ui/Icon';
import { aiErrorMessage } from '@/lib/errors';
import { ImageService, PRICE_PER_IMAGE } from '@/lib/services/image.service';
import { ImageGlyph } from '@/components/ui/Icon';
import type { RewriteMode } from '@/lib/services/prompts';

const STEPS = ['מנתח את המותג שלך…', 'בונה זווית שיווקית…', 'כותב את הפתיח…', 'מנסח קריאה לפעולה…'];

export function CreateStudio() {
  const router = useRouter();
  const aiReady = useAiReady();
  const { brand, addContent, addMedia } = useApp();
  const [kind, setKind] = useState<ContentKind>('post');
  const [platform, setPlatform] = useState<Platform>('Instagram');
  const [goal, setGoal] = useState('יותר פניות');
  const [brief, setBrief] = useState('');
  const [variants, setVariants] = useState<GeneratedVariant[]>([]);
  const [picked, setPicked] = useState(0);
  const [step, setStep] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [rewriting, setRewriting] = useState<RewriteMode | null>(null);
  const [imaging, setImaging] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [when, setWhen] = useState({ date: today(), time: '19:30' });

  // arriving from a calendar day (/create?date=…&time=…) pre-selects that slot
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const d = q.get('date'); const t = q.get('time');
    if (d) setWhen({ date: d, time: t || '19:30' });
    const k = q.get('kind'); const b = q.get('brief');
    if (k && ['post', 'reel', 'story', 'ad'].includes(k)) setKind(k as ContentKind);
    if (b) setBrief(b);
  }, []);

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
      setError(aiErrorMessage(e.code));
    } finally {
      clearInterval(tick); setStep(-1);
    }
  }

  /** Rewrites the selected variant in place — the user keeps their edits to everything else. */
  async function rewrite(mode: RewriteMode) {
    const current = variants[picked];
    if (!current) return;
    setRewriting(mode);
    try {
      const out = await AIService.rewrite(brand, mode, current.caption, current.cta);
      setVariants((vs) => vs.map((x, i) => (i === picked ? { ...x, caption: out.caption || x.caption, cta: out.cta || x.cta } : x)));
    } catch (e: any) {
      setError(aiErrorMessage(e.code));
    } finally { setRewriting(null); }
  }

  /** Turns the visual direction the model already wrote into two real images to choose from. */
  async function makeImages() {
    const current = variants[picked];
    if (!current) return;
    setImaging(true); setError(null); setOptions([]);
    try {
      const urls = await ImageService.generate({
        prompt: current.visual_direction || current.headline,
        aspectRatio: kind === 'reel' || kind === 'story' ? '9:16' : '4:5',
        count: 2,
      });
      setOptions(urls);
    } catch (e: any) {
      setError(e.code === 'insufficient_balance' ? 'אין יתרה בחשבון fal.' : 'יצירת התמונה נכשלה.');
    } finally { setImaging(false); }
  }

  function chooseImage(url: string) {
    const id = `img-${Date.now()}`;
    addMedia({ id, url, name: variants[picked]?.headline || 'תמונה שנוצרה', kind: 'image', persistent: false });
    setVariants((vs) => vs.map((x, i) => (i === picked ? { ...x, mediaId: id } : x)));
    setOptions([]);
  }

  function save(status: 'draft' | 'scheduled') {
    if (!v) return;
    addContent({
      kind, platform, goal, headline: v.headline, caption: v.caption, hashtags: v.hashtags || [],
      cta: v.cta, emoji: v.emoji, palette: v.palette, visualDirection: v.visual_direction,
      mediaId: null, status,
      date: status === 'scheduled' ? when.date : null,
      time: status === 'scheduled' ? when.time : null,
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
          <Sparkle size={18} weight="fill" aria-hidden />ייצור תוכן
        </Button>
        {aiReady === false && <div className="mt-4"><AiUnavailable /></div>}
      </Card>

      <div>
        {step >= 0 && <GenerationState lines={STEPS} step={step} />}
        {error && (
          <AdapterNote title="היצירה נכשלה.">
            {error} לא נכתב טקסט מקומי במקום, כדי שלא תקבלו תוכן שלא נוצר על ידי המודל.
            <div className="mt-3"><Button size="sm" variant="ghost" onClick={generate}>ניסיון נוסף</Button></div>
          </AdapterNote>
        )}
        {step < 0 && !error && !variants.length && (
          <EmptyState icon={<MagicWand />} title="הקנבס מחכה" body="מלאו את הבריף ותקבלו כמה זוויות שונות לבחירה." />
        )}
        {v && (
          <>
            <div className="mb-4 flex flex-wrap gap-2">
              {variants.map((x, i) => (
                <Chip key={i} on={i === picked} onClick={() => setPicked(i)}>{x.angle || `גרסה ${i + 1}`}</Chip>
              ))}
              <Button size="sm" variant="ghost" onClick={generate}><ArrowsClockwise size={16} aria-hidden />ייצור מחדש</Button>
            </div>
            <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
              <div>
                <Visual kind={kind} headline={v.headline} palette={v.palette} mediaId={(v as any).mediaId}
                  ratio={kind === 'reel' || kind === 'story' ? 'vertical' : 'square'} size="lg" />
                <Button variant="ghost" className="mt-3 w-full" onClick={makeImages} disabled={imaging}>
                  {imaging ? <><Spinner />מצייר…</> : <><ImageGlyph size={18} aria-hidden />יצירת תמונה · ${(PRICE_PER_IMAGE * 2).toFixed(2)}</>}
                </Button>
                {options.length > 0 && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {options.map((u) => (
                      <button key={u} type="button" onClick={() => chooseImage(u)}
                        className="overflow-hidden rounded-xl ring-2 ring-transparent transition hover:ring-primary">
                        <img src={u} alt="" className="aspect-[4/5] w-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
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
                <div className="mt-2">
                  <p className="mb-2 text-sm font-semibold text-ink-2">שינוי מהיר</p>
                  <div className="flex flex-wrap gap-2">
                    {([
                      ['shorter', 'קצר יותר'], ['professional', 'מקצועי יותר'], ['casual', 'קליל יותר'],
                      ['hook', 'פתיחה אחרת'], ['cta', 'קריאה לפעולה אחרת'],
                    ] as [RewriteMode, string][]).map(([m, label]) => (
                      <Button key={m} size="sm" variant="ghost" disabled={!!rewriting} onClick={() => rewrite(m)}>
                        {rewriting === m ? <><Spinner />משכתב…</> : label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-3 border-t border-line pt-4">
                  <Button variant="primary" onClick={() => save('draft')}>שמירה כטיוטה</Button>
                  <Button variant="ghost" onClick={() => setScheduling(true)}><CalendarBlank size={18} aria-hidden />תזמון ליומן</Button>
                  <Button variant="ghost"
                    onClick={() => router.push(`/reels?brief=${encodeURIComponent(brief || v.headline || '')}`)}>
                    <FilmSlate size={18} aria-hidden />הפיכה לסרטון
                  </Button>
                </div>
              </Card>
            </div>
          </>
        )}
      </div>

      <Modal open={scheduling} onClose={() => setScheduling(false)}>
        <h3 className="mb-5 font-display text-2xl font-extrabold">מתי לפרסם?</h3>
        <ScheduleFields date={when.date} time={when.time} onChange={setWhen} />
        <div className="mt-6 flex gap-3">
          <Button variant="primary" disabled={!when.date} onClick={() => { setScheduling(false); save('scheduled'); }}>
            תזמון
          </Button>
          <Button variant="ghost" onClick={() => setScheduling(false)}>ביטול</Button>
        </div>
      </Modal>
    </div>
  );
}
