'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { AiUnavailable, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';

const STEPS = [
  { t: 'ספרו לנו על העסק', s: 'כמה שורות, וה-AI כבר יבין את השפה שלכם.' },
  { t: 'מי הלקוחות שלכם?', s: 'ככל שנדייק יותר, התוכן ידבר אליהם יותר.' },
  { t: 'מה המטרה?', s: 'אפשר לבחור כמה.' },
  { t: 'איך המותג נשמע?', s: 'הטון שילווה כל טקסט שנכתוב.' },
  { t: 'ניתוח מותג', s: 'ה-AI בונה את פרופיל התוכן שלכם.' },
];
const GOALS = ['יותר פניות', 'יותר תורים', 'יותר עוקבים', 'יותר מכירות', 'מודעות למותג'];
const TONES = ['מקצועי', 'יוקרתי', 'חברי', 'נועז', 'מינימלי', 'כיפי'];

export default function Onboarding() {
  const router = useRouter();
  const aiReady = useAiReady();
  const { brand, setBrand, setAnalysis, finishOnboarding } = useApp();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);

  async function next() {
    if (step < STEPS.length - 1) return setStep(step + 1);
    setBusy(true);
    if (aiReady) {
      try { setAnalysis(await AIService.brandAnalysis(brand)); } catch { /* proceed without analysis */ }
    }
    finishOnboarding();
    router.push('/dashboard');
  }

  const toggleGoal = (g: string) =>
    setBrand({ goals: brand.goals.includes(g) ? brand.goals.filter((x) => x !== g) : [...brand.goals, g] });

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="w-full max-w-2xl rounded-xl border border-line bg-surface p-6 shadow-lg sm:p-12">
        <div className="mb-8 flex gap-1.5">
          {STEPS.map((_, i) => <i key={i} className={cx('h-1.5 flex-1 rounded-full', i <= step ? 'bg-brand' : 'bg-line')} />)}
        </div>
        <h2 className="font-display text-3xl font-extrabold">{STEPS[step].t}</h2>
        <p className="mb-8 mt-2 text-muted">{STEPS[step].s}</p>

        {step === 0 && (
          <>
            <Field label="שם העסק"><Input value={brand.name} onChange={(e) => setBrand({ name: e.target.value })} /></Field>
            <Field label="תחום"><Input value={brand.industry} onChange={(e) => setBrand({ industry: e.target.value })} placeholder="קליניקת יופי ולייזר" /></Field>
            <Field label="עיר"><Input value={brand.city} onChange={(e) => setBrand({ city: e.target.value })} /></Field>
            <Field label="מה אתם עושים?"><Textarea value={brand.description} onChange={(e) => setBrand({ description: e.target.value })} /></Field>
          </>
        )}
        {step === 1 && (
          <Field label="קהל היעד">
            <Textarea value={brand.audience} onChange={(e) => setBrand({ audience: e.target.value })}
              placeholder="נשים 30-50, מרכז הארץ, מחפשות טיפוח מקצועי" />
          </Field>
        )}
        {step === 2 && (
          <div className="flex flex-wrap gap-2.5">
            {GOALS.map((g) => <Chip key={g} on={brand.goals.includes(g)} onClick={() => toggleGoal(g)}>{g}</Chip>)}
          </div>
        )}
        {step === 3 && (
          <div className="flex flex-wrap gap-2.5">
            {TONES.map((t) => <Chip key={t} on={brand.tone === t} onClick={() => setBrand({ tone: t })}>{t}</Chip>)}
          </div>
        )}
        {step === 4 && (
          <div>
            {busy ? <div className="flex items-center gap-3"><Spinner /><span>מנתח את המותג שלכם…</span></div>
              : <p className="text-muted">לחיצה על "בואו נתחיל" תריץ ניתוח מותג ותיכנס למערכת.</p>}
            {aiReady === false && <div className="mt-4"><AiUnavailable /></div>}
          </div>
        )}

        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>חזרה</Button>
          <Button variant="primary" size="lg" onClick={next} disabled={busy}>
            {step === STEPS.length - 1 ? 'בואו נתחיל' : 'המשך'}
          </Button>
        </div>
      </div>
    </div>
  );
}
