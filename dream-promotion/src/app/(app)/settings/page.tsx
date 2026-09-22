'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService, MediaService, VideoService } from '@/lib/services';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Card, Field, Input, PageHead, Pill, Select, Textarea } from '@/components/ui/primitives';
import { Sparkle } from '@/components/ui/Icon';

export default function SettingsPage() {
  const aiReady = useAiReady();
  const { brand, setBrand, setAnalysis, reset } = useApp();
  const [busy, setBusy] = useState(false);

  async function analyze() {
    setBusy(true);
    try { setAnalysis(await AIService.brandAnalysis(brand)); } catch { /* UI shows the AI state */ }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHead title="הגדרות" />
      <Card className="mb-4">
        <h3 className="font-display text-xl font-extrabold">פרטי העסק</h3>
        <div className="mt-4 grid gap-x-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          <Field label="שם העסק"><Input value={brand.name} onChange={(e) => setBrand({ name: e.target.value })} /></Field>
          <Field label="תחום"><Input value={brand.industry} onChange={(e) => setBrand({ industry: e.target.value })} /></Field>
          <Field label="עיר"><Input value={brand.city} onChange={(e) => setBrand({ city: e.target.value })} /></Field>
          <Field label="אתר"><Input value={brand.website} onChange={(e) => setBrand({ website: e.target.value })} /></Field>
        </div>
        <Field label="תיאור"><Textarea value={brand.description} onChange={(e) => setBrand({ description: e.target.value })} /></Field>
        <Field label="קהל יעד"><Input value={brand.audience} onChange={(e) => setBrand({ audience: e.target.value })} /></Field>
        <Field label="קריאה לפעולה ברירת מחדל"><Input value={brand.cta} onChange={(e) => setBrand({ cta: e.target.value })} /></Field>
        <Button variant="primary" onClick={analyze} disabled={!aiReady || busy}>
          {busy ? 'מנתח…' : <><Sparkle size={18} weight="fill" aria-hidden />הרצת ניתוח מותג</>}
        </Button>
      </Card>

      <Card className="mb-4">
        <h3 className="font-display text-xl font-extrabold">ערכת מותג</h3>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div><Field label="צבע ראשי">
            <input type="color" value={brand.colors[0]} className="h-11 w-20 rounded-md border border-line"
              onChange={(e) => setBrand({ colors: [e.target.value, brand.colors[1]] })} /></Field></div>
          <div><Field label="צבע משני">
            <input type="color" value={brand.colors[1]} className="h-11 w-20 rounded-md border border-line"
              onChange={(e) => setBrand({ colors: [brand.colors[0], e.target.value] })} /></Field></div>
          <div className="min-w-[180px] flex-1"><Field label="טון דיבור">
            <Select value={brand.tone} onChange={(e) => setBrand({ tone: e.target.value })}>
              {['מקצועי', 'יוקרתי', 'חברי', 'נועז', 'מינימלי', 'כיפי'].map((t) => <option key={t}>{t}</option>)}
            </Select></Field></div>
        </div>
      </Card>

      <Card>
        <h3 className="font-display text-xl font-extrabold">מצב המערכת</h3>
        <dl className="mt-3 space-y-2.5 text-sm">
          {([
            ['מנוע AI', aiReady],
            ['אחסון מדיה', MediaService.persistent],
            ['רינדור וידאו', VideoService.configured],
            ['רשתות חברתיות', false],
          ] as [string, boolean | null][]).map(([label, ok]) => (
            <div key={label} className="flex items-center justify-between">
              <dt>{label}</dt>
              <dd>{ok ? <Pill tone="ok">מחובר</Pill> : <Pill tone="warn">לא מוגדר</Pill>}</dd>
            </div>
          ))}
        </dl>
        <Button variant="ghost" size="sm" className="mt-4 text-[var(--danger)]" onClick={reset}>איפוס כל הנתונים</Button>
      </Card>
    </>
  );
}
