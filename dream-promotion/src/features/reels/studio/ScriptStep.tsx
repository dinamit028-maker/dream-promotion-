'use client';
import type { Dispatch, SetStateAction } from 'react';
import { PRICE_PER_SECOND } from '@/lib/services/video.service';
import { Button, Card, Chip, Field, Textarea } from '@/components/ui/primitives';
import { AiUnavailable, Spinner } from '@/components/ui/feedback';
import { Sparkle } from '@/components/ui/Icon';
import { MicButton } from '@/components/ui/MicButton';
import { cx } from '@/lib/utils';
import { LENGTHS, type Res } from './parts';

export interface ReelIdea { title: string; format: string; hook: string; brief: string; why: string }

/**
 * Step 1 of the reels studio — what the video is about, its kind, narration, length and quality, and the script
 * (2.75 — moved out of app/(app)/reels/page.tsx as it was). The page keeps the state and does the work.
 */
export function ScriptStep({
  brief, setBrief, ideas, ideasBusy, ideasError, onIdeas, onIdea, presetImage, presetVideo, shape, setShape, total, setTotal,
  withNarration, setWithNarration, res, setRes, newVideoCost, hasExistingVideo, aiReady, planning, onQuick, onStart,
}: {
  brief: string; setBrief: Dispatch<SetStateAction<string>>; ideas: ReelIdea[]; ideasBusy: boolean; ideasError: string | null;
  onIdeas: () => void; onIdea: (brief: string) => void; presetImage: string | null; presetVideo: string | null;
  shape: 'scenes' | 'single'; setShape: (s: 'scenes' | 'single') => void; total: number; setTotal: (n: number) => void;
  withNarration: boolean; setWithNarration: (on: boolean) => void; res: Res; setRes: (r: Res) => void;
  newVideoCost: number; hasExistingVideo: boolean; aiReady: boolean | null; planning: boolean; onQuick: () => void; onStart: () => void;
}) {
  return (
    <Card>
      <div className="mb-4">
        <Button variant="ghost" className="w-full" onClick={onIdeas} disabled={ideasBusy || aiReady === false}>
          {ideasBusy ? <><Spinner />חושב על רעיונות…</> : ideas.length ? '✨ רעיונות אחרים' : '✨ אין רעיון? קבלו 6 רעיונות לסרטון'}
        </Button>
        {ideasError && <p className="mt-2 text-xs text-warn">{ideasError}</p>}
        {ideas.length > 0 && (
          <div className="mt-3 grid max-h-[420px] gap-2 overflow-y-auto pe-1">
            {ideas.map((idea, k) => (
              <button key={k} type="button" onClick={() => onIdea(idea.brief)}
                className={cx('rounded-2xl border p-3 text-start transition-colors hover:border-primary hover:bg-primary-soft',
                  brief === idea.brief ? 'border-primary bg-primary-soft' : 'border-line')}>
                <span className="flex items-center justify-between gap-2">
                  <strong className="text-sm">{idea.title}</strong>
                  <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2">{idea.format}</span>
                </span>
                <span className="mt-1 block text-sm">״{idea.hook}״</span>
                <span className="mt-1 block text-xs text-muted">{idea.why}</span>
              </button>
            ))}
            <p className="text-xs text-muted">לחיצה על רעיון מכניסה אותו לשדה למטה — אפשר לערוך לפני בניית התסריט.</p>
          </div>
        )}
      </div>
      <Field label="על מה הסרטון?">
        <Textarea value={brief} onChange={(e) => setBrief(e.target.value)}
          placeholder="למשל: טיפול פנים לפני החורף — לפני ואחרי, בקליניקה ברמת אביב" />
        <MicButton className="mt-2" label="לספר בקול במקום להקליד"
          onText={(t) => setBrief((b) => (b.trim() ? `${b.trim()} ${t}` : t))} />
      </Field>
      {presetImage && !presetVideo && (
        <p className="mb-4 rounded-2xl bg-surface-2 p-3 text-sm">
          התמונה של הפוסט תשמש כפריים הפתיחה של הסצנה הראשונה.
        </p>
      )}
      {presetVideo && (
        <p className="mb-4 rounded-2xl bg-surface-2 p-3 text-sm">
          הסרטון מהספרייה ישובץ בסצנה הראשונה — בלי עלות יצירה. כתבו למעלה את טקסט הקריינות, או בנו תסריט מלא.
        </p>
      )}
      <Field label="סוג הסרטון">
        <div className="flex flex-wrap gap-2">
          <Chip on={shape === 'scenes'} onClick={() => setShape('scenes')}>סצנות קצרות (חסכוני)</Chip>
          <Chip on={shape === 'single'} onClick={() => { setShape('single'); if (total > 30) setTotal(15); }}>קליפ AI רציף אחד</Chip>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {shape === 'single'
            ? 'וידאו AI אחד לכל האורך, בלי חיתוכים — כמו קליפ מצולם. יקר יותר (כל השניות הן וידאו), עד 30 שניות.'
            : 'כמה סצנות של 3–7 שניות: וידאו AI רק איפה שתנועה חשובה, תמונות בתנועה וכרטיס בשאר.'}
        </p>
      </Field>
      <Field label="קריינות">
        <div className="flex flex-wrap gap-2">
          <Chip on={withNarration} onClick={() => setWithNarration(true)}>🎙 עם קריינות</Chip>
          <Chip on={!withNarration} onClick={() => setWithNarration(false)}>🎵 בלי קריינות</Chip>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {withNarration
            ? 'קול מקריא את הטקסט, עם כתוביות ומוזיקת רקע.'
            : 'בלי קול מקריא: מוזיקת רקע + כתוביות על המסך (הכיתוב של כל סצנה). בלי עלות קריינות.'}
        </p>
      </Field>
      <Field label="אורך">
        <div className="flex flex-wrap gap-2">
          {LENGTHS.filter((d) => shape === 'scenes' || d <= 30).map((d) => (
            <Chip key={d} on={total === d} onClick={() => setTotal(d)}>
              {d} שנ׳{shape === 'single' ? ' · קליפ אחד' : ` · כ-${Math.min(10, Math.max(3, Math.round(d / 5)))} סצנות`}
            </Chip>
          ))}
        </div>
      </Field>
      <Field label="איכות">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(PRICE_PER_SECOND) as Res[]).map((r) => (
            <Chip key={r} on={res === r} onClick={() => setRes(r)}>{r}</Chip>
          ))}
        </div>
        <p className="mt-2 text-sm text-muted">
          עלות וידאו משוערת: <strong className="text-ink">${newVideoCost.toFixed(2)}</strong>
          <span className="mt-1 block text-xs">
            בניית התסריט עצמה חינמית. משלמים רק כשלוחצים "יצירת הסרטון", ורק על קליפים שעוד לא מוכנים.
          </span>
        </p>
      </Field>
      {hasExistingVideo && (
        <div className="mb-3 rounded-2xl border border-(--ok,#16a34a)/40 bg-(--ok-soft,#e8f7ee) p-3 text-sm">
          <strong className="block">יש כבר סרטון בפרויקט — עליו לא משלמים.</strong>
          <span className="text-ink-2">
            משלמים רק על הקריינות (ElevenLabs){Math.max(1, Math.round(total / 15)) > 1 ? ' ועל הסצנות הנוספות שייווצרו' : ''}.
            הריל הסופי, הכתוביות והמוזיקה חינם.
          </span>
        </div>
      )}
      {(presetVideo || presetImage) && (
        <>
          <Button variant="primary" size="lg" className="mb-2 w-full" onClick={onQuick} disabled={!presetVideo && !brief.trim()}>
            {presetVideo ? 'ריל מהסרטון הזה, בלי תסריט' : 'קריינות על התמונה הזו, בלי תסריט'}
          </Button>
          <p className="mb-3 text-xs text-muted">
            {presetVideo
              ? 'מדברים בסרטון? השאירו את השדה ריק — הכתוביות ייווצרו מהדיבור. כתבתם טקסט? הוא יהיה טקסט הקריינות. בלי עלות וידאו.'
              : 'הטקסט שכתבתם למעלה יהיה טקסט הקריינות (אפשר לערוך אחר כך). בלי AI ובלי עלות וידאו — רק הקול.'}
          </p>
        </>
      )}
      <Button variant={presetVideo || presetImage ? 'ghost' : 'primary'} size="lg" className="w-full" onClick={onStart} disabled={!aiReady || planning}>
        <Sparkle size={20} weight="fill" aria-hidden />{presetVideo || presetImage ? 'או: תסריט מלא עם כמה סצנות' : 'בניית תסריט'}
      </Button>
      {aiReady === false && <div className="mt-4"><AiUnavailable /></div>}
    </Card>
  );
}
