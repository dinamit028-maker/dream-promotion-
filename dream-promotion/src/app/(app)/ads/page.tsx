'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService, AdsService } from '@/lib/services';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Card, Chip, Field, Input, PageHead } from '@/components/ui/primitives';
import { AdapterNote, AiUnavailable, EmptyState, GenerationState, IntegrationDialog } from '@/components/ui/feedback';
import { Visual } from '@/components/ui/Visual';

const GOALS = ['יותר פניות בוואטסאפ', 'יותר לידים', 'יותר תורים', 'מכירות באתר'];

export default function AdsPage() {
  const aiReady = useAiReady();
  const { brand, content, addAd } = useApp();
  const [goal, setGoal] = useState(GOALS[0]);
  const [audience, setAudience] = useState('');
  const [budget, setBudget] = useState(80);
  const [days, setDays] = useState(7);
  const [copy, setCopy] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(false);

  async function generate() {
    setBusy(true);
    try { setCopy(await AIService.adCopy(brand, { goal, audience, budget, contentCaption: content[0]?.caption })); }
    catch { setCopy(null); }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHead title="קמפיינים" sub="בלי להיכנס ל-Ads Manager. עונים על ארבע שאלות ומקבלים מודעה." />
      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card>
          <Field label="מה המטרה?">
            <div className="grid gap-2">
              {GOALS.map((g) => <Chip key={g} on={goal === g} onClick={() => setGoal(g)} className="justify-start">{g}</Chip>)}
            </div>
          </Field>
          <Field label="קהל ואזור">
            <Input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="נשים 28-45, מרכז הארץ" />
          </Field>
          <div className="flex gap-3">
            <div className="flex-1"><Field label="תקציב יומי (₪)">
              <Input type="number" value={budget} onChange={(e) => setBudget(+e.target.value)} /></Field></div>
            <div className="flex-1"><Field label="ימים">
              <Input type="number" value={days} onChange={(e) => setDays(+e.target.value)} /></Field></div>
          </div>
          <Button variant="primary" size="lg" className="w-full" onClick={generate} disabled={!aiReady || busy}>
            ✦ כתיבת המודעה
          </Button>
          {aiReady === false && <div className="mt-4"><AiUnavailable /></div>}
        </Card>

        <div>
          {busy && <GenerationState lines={['קורא את המותג…', 'בוחר זווית…', 'מנסח את המודעה…']} step={1} />}
          {!busy && !copy && <EmptyState emoji="◉" title="עוד לא נבנתה מודעה" body="בחרו מטרה ותקציב, וה-AI יכתוב כותרת, טקסט ו-CTA." />}
          {copy && (
            <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
              <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
                <div className="flex items-center gap-2.5 border-b border-line p-3">
                  <div className="h-8 w-8 rounded-full bg-brand" />
                  <div><strong className="text-sm">{brand.name || 'העסק שלך'}</strong>
                    <p className="text-xs text-muted">ממומן</p></div>
                </div>
                <p className="p-3 text-sm leading-relaxed">{copy.primary}</p>
                <Visual emoji="✦" palette={['#6B3BF5', '#5BA4FF']} className="rounded-none" />
                <div className="flex items-center justify-between bg-surface-2 p-3">
                  <div><strong className="text-sm">{copy.headline}</strong>
                    <p className="text-xs text-muted">{copy.description}</p></div>
                  <Button variant="primary" size="sm">{copy.cta}</Button>
                </div>
              </div>
              <Card>
                <h3 className="font-display text-xl font-extrabold">סיכום הקמפיין</h3>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between"><dt className="text-muted">קהל מוצע</dt><dd>{copy.audienceSuggestion || audience || '—'}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted">תקציב יומי</dt><dd>{budget} ₪</dd></div>
                  <div className="flex justify-between"><dt className="text-muted">משך</dt><dd>{days} ימים</dd></div>
                  <div className="flex justify-between border-t border-line pt-2">
                    <dt className="text-muted">סך הוצאה מתוכננת</dt>
                    <dd><strong>{AdsService.plannedSpend(budget, days).toLocaleString('he-IL')} ₪</strong></dd></div>
                </dl>
                <div className="my-4">
                  <AdapterNote>הוצאה מתוכננת בלבד. תחזיות תוצאות מגיעות מ-Meta אחרי חיבור החשבון — המערכת לא ממציאה מספרים.</AdapterNote>
                </div>
                <div className="flex gap-3">
                  <Button variant="primary" onClick={() => addAd({
                    goal, audience, budgetPerDay: budget, days, headline: copy.headline,
                    primary: copy.primary, description: copy.description, cta: copy.cta, status: 'draft',
                  })}>שמירת טיוטה</Button>
                  <Button variant="ghost" onClick={() => setDialog(true)}>העלאת קמפיין</Button>
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
      <IntegrationDialog open={dialog} onClose={() => setDialog(false)} provider="Meta" what="העלאת קמפיין" />
    </>
  );
}
