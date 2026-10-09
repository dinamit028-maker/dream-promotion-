'use client';
import { Button, Card } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Check, Play, Sparkle } from '@/components/ui/Icon';
import type { Res } from './parts';
import type { reelCosts } from './logic';

/**
 * Step 2's options and its button — draft first, seamless, what it costs now and for the final version (2.75 — moved out
 * of app/(app)/reels/page.tsx as it was).
 */
export function RenderOptions({
  draftMode, setDraftMode, seamless, setSeamless, running, count, costs, res, allDone, draftScenes, videoReady, onStop, onCreate, onFinal,
}: {
  draftMode: boolean; setDraftMode: (on: boolean) => void; seamless: boolean; setSeamless: (on: boolean) => void; running: boolean;
  count: number; costs: ReturnType<typeof reelCosts>; res: Res; allDone: boolean; draftScenes: number[]; videoReady: boolean | null;
  onStop: () => void; onCreate: () => void; onFinal: () => void;
}) {
  return (
    <Card className="mt-4">
      <label className="mb-4 flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={draftMode} onChange={(e) => setDraftMode(e.target.checked)} disabled={running}
          className="mt-1 h-5 w-5 accent-[var(--primary)]" />
        <span>
          <strong className="block">טיוטה קודם (מומלץ)</strong>
          <span className="text-sm text-muted">
            סצנות הווידאו נוצרות קודם כתמונות בתנועה — רואים את כל הריל בכמה סנטים. רק אחרי שאישרתם, "גרסה סופית" הופכת אותן לווידאו.
          </span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={seamless} onChange={(e) => setSeamless(e.target.checked)} disabled={running}
          className="mt-1 h-5 w-5 accent-[var(--primary)]" />
        <span>
          <strong className="block">רצף חלק</strong>
          <span className="text-sm text-muted">
            כל קליפ מתחיל איפה שהקודם נגמר. איטי יותר — הקליפים נוצרים אחד אחרי השני. בלי זה, כולם נוצרים במקביל.
          </span>
        </span>
      </label>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="text-sm text-muted">
          {count} סצנות · {costs.totalSec} שנ׳ · מתוכן {costs.videoSec} שנ׳ וידאו AI · {res}
          <br />עכשיו: <strong className="text-ink">${costs.now.toFixed(2)}</strong>
          {costs.final > 0 && <> · גרסה סופית: <strong className="text-ink">+${costs.final.toFixed(2)}</strong></>}
        </span>
        <div className="flex gap-2">
          {running && (
            <Button variant="ghost" onClick={onStop}>עצירה</Button>
          )}
          {!allDone && (
            <Button variant="primary" onClick={onCreate} disabled={!videoReady || running}>
              {running ? <><Spinner />יוצר…</> : <><Play size={18} weight="fill" aria-hidden />{draftMode ? 'יצירת טיוטה' : 'יצירת הסרטון'}</>}
            </Button>
          )}
          {allDone && draftScenes.length > 0 && (
            <Button variant="primary" onClick={onFinal} disabled={!videoReady || running}>
              {running ? <><Spinner />יוצר וידאו…</> : <><Sparkle size={18} weight="fill" aria-hidden />גרסה סופית · {draftScenes.length} סצנות וידאו</>}
            </Button>
          )}
          {allDone && !draftScenes.length && (
            <Button variant="primary" disabled><Check size={18} aria-hidden />הכול מוכן</Button>
          )}
        </div>
      </div>
    </Card>
  );
}
