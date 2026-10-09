'use client';
import { Button, Card, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { ArrowsClockwise, CaretLeft, CaretRight, ImageGlyph, MagicWand, PaperPlaneTilt, Trash } from '@/components/ui/Icon';
import { videoErrorMessage } from '@/lib/errors';
import { cx } from '@/lib/utils';
import type { ReelScene, SceneMotion, SceneSource } from '@/types';
import { ClipBadge, roleLabel, type Clip } from './parts';
import type { Narr } from './scenes';

/**
 * One scene of the reels studio (2.75 — moved out of app/(app)/reels/page.tsx as it was): its picture or clip, its text,
 * what it is made of, its camera move, and — on step 3 — its narration. The page keeps the state; this shows one scene
 * and says what was asked.
 */
export function SceneCard({
  sc, i, c, pUrl, n, step, count, source, motion, outdated, hasPhoto, running, rethinking, aiReady, videoReady, seamless, draftMode,
  onPick, onSource, onEdit, onRethink, onRender, onMove, onRemove, onMotion, onNarrate, onSrt,
}: {
  sc: ReelScene; i: number; c: Clip | undefined; pUrl: string | undefined; n: Narr | undefined; step: number; count: number;
  source: SceneSource; motion: SceneMotion | null; outdated: boolean; hasPhoto: boolean; running: boolean; rethinking: number | null;
  aiReady: boolean | null; videoReady: boolean | null; seamless: boolean; draftMode: boolean;
  onPick: () => void; onSource: (src: SceneSource) => void; onEdit: () => void; onRethink: () => void; onRender: () => void;
  onMove: (by: -1 | 1) => void; onRemove: () => void; onMotion: (m: SceneMotion) => void; onNarrate: () => void; onSrt: () => void;
}) {
  const elapsed = c?.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
  const err = c?.status === 'failed' ? videoErrorMessage(c.error, c.code) : null;
  return (
    <Card className="p-4">
      <div className="flex gap-4">
        <button type="button" onClick={onPick} disabled={running}
          aria-label={pUrl ? 'החלפת תמונת פתיחה' : 'בחירת תמונת פתיחה'}
          className="relative flex aspect-[9/16] w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border-[1.5px] border-dashed border-line bg-surface-2 text-muted hover:border-primary hover:text-primary sm:w-24">
          {c?.url ? (c.kind === 'image'
              ? <img key={`${c.url}-${motion}`} src={c.url} alt="" style={{ ['--kb-dur' as any]: `${sc.seconds || 5}s` }}
                  className={cx('absolute inset-0 h-full w-full object-cover', motion && `kb kb-${motion}`)} />
              : <video src={`${c.url}#t=0.5`} preload="metadata" muted playsInline className="absolute inset-0 h-full w-full object-cover" />)
            : pUrl ? <img src={pUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
            : <span className="flex flex-col items-center gap-1 text-[11px] font-semibold"><ImageGlyph size={22} aria-hidden />תמונה</span>}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Pill tone="ai">{roleLabel(sc.role, i)} · {sc.seconds || 5} שנ׳{c?.draft ? ' · טיוטה' : ''}</Pill>
            {step === 2 && <ClipBadge clip={c} elapsed={elapsed} />}
          </div>
          <strong className="mt-2 block">{sc.onScreen}</strong>
          <p className="mt-1 text-sm text-muted">קריינות: {sc.voiceover || '—'}</p>
          <p className="mt-0.5 text-sm text-muted">{sc.visual}</p>

          {step === 2 && err && (
            <div className="mt-3 rounded-2xl bg-[var(--warn-soft)] p-3">
              <strong className="block text-sm text-warn">{err.title}</strong>
              {err.body && <p className="mt-1 text-sm text-ink-2">{err.body}</p>}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {step !== 3 && (<div className="flex overflow-hidden rounded-full border border-line" role="radiogroup" aria-label="ממה עשויה הסצנה">
              {([['ai_video', 'וידאו AI'], ['ai_image', 'תמונה בתנועה'], ['graphic', 'כרטיס']] as [SceneSource, string][]).map(([src, label]) => (
                <button key={src} type="button" role="radio" aria-checked={source === src} disabled={running}
                  onClick={() => source !== src && onSource(src)}
                  className={cx('px-3 py-1.5 text-xs font-semibold transition-colors',
                    source === src ? 'bg-primary text-white' : 'hover:bg-surface-2')}>
                  {label}
                </button>
              ))}
            </div>)}
            <Button size="sm" variant="ghost" onClick={onEdit} disabled={running}>{step === 3 ? 'עריכת הטקסט' : 'עריכה'}</Button>
            {step !== 3 && <Button size="sm" variant="ghost" onClick={onRethink} disabled={running || rethinking === i || !aiReady}>
              {rethinking === i ? <><Spinner />מחפש כיוון…</> : <><MagicWand size={16} aria-hidden />סצנה אחרת</>}
            </Button>}
            {step === 2 && videoReady && c?.status !== 'running' && c?.status !== 'queued' && (
              <Button size="sm" variant="ghost" onClick={onRender} disabled={running}>
                {c?.url ? 'רינדור מחדש' : 'רינדור הקליפ'}
              </Button>
            )}
            {step !== 3 && count > 1 && (
              <>
                <Button size="sm" variant="ghost" aria-label="הזזה אחורה" disabled={running || i === 0}
                  onClick={() => onMove(-1)}>
                  <CaretRight size={15} aria-hidden />
                </Button>
                <Button size="sm" variant="ghost" aria-label="הזזה קדימה" disabled={running || i === count - 1}
                  onClick={() => onMove(1)}>
                  <CaretLeft size={15} aria-hidden />
                </Button>
                <Button size="sm" variant="ghost" className="text-[var(--danger)]" aria-label="מחיקת סצנה" disabled={running}
                  onClick={onRemove}>
                  <Trash size={15} aria-hidden />
                </Button>
              </>
            )}
          </div>

          {step === 2 && (source === 'ai_image' || c?.draft) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">תנועת מצלמה:</span>
              {([['zoom_in', 'התקרבות'], ['zoom_out', 'התרחקות'], ['pan_right', 'ימינה'], ['pan_left', 'שמאלה'], ['none', 'בלי']] as [SceneMotion, string][]).map(([m, label]) => (
                <button key={m} type="button" onClick={() => onMotion(m)}
                  className={cx('rounded-full px-2.5 py-1 text-xs', (sc.motion ?? 'zoom_in') === m ? 'bg-primary-soft font-bold text-ink' : 'bg-surface-2 text-ink-2')}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {step === 2 && c?.draft && (
            <p className="mt-2 text-xs text-muted">טיוטה: תמונה במקום וידאו. ב"גרסה סופית" היא תהפוך לפריים הראשון של הווידאו.</p>
          )}
          {step === 2 && c?.draft && c?.error && (
            <p className="mt-1 text-xs text-warn">הווידאו לא נוצר ({c.error}). התמונה נשמרה — אפשר לנסות שוב בגרסה הסופית.</p>
          )}
          {step !== 3 && source === 'graphic' && !c?.url && (
            <p className="mt-2 text-xs text-muted">כרטיס בצבעי המותג עם הכיתוב של הסצנה וקריאה לפעולה. בלי עלות.</p>
          )}

          {step === 2 && i > 0 && seamless && !draftMode && !hasPhoto && !c?.url && source === 'ai_video' && (
            <p className="mt-2 text-xs text-muted">ימשיך מהפריים האחרון של קליפ {i}</p>
          )}

          {step === 3 && n?.url && !n?.busy && outdated && (
            <p className="mt-3 text-xs text-warn">הקריינות הזו לא תואמת את מה שמוגדר עכשיו (טקסט, קול או סגנון). לחצו "קריינות מחדש" כדי להחליף — רק הקול של הסצנה הזו ייווצר מחדש.</p>
          )}
          {/* ---- narration for this scene, generated and regenerated on its own ---- */}
          {step === 3 && (<div className="mt-3 rounded-2xl bg-surface-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={onNarrate} disabled={n?.busy}>
                {n?.busy ? <><Spinner />מקריא…</>
                  : n?.url ? <><ArrowsClockwise size={15} aria-hidden />קריינות מחדש</>
                  : <><PaperPlaneTilt size={15} aria-hidden />יצירת קריינות</>}
              </Button>
              {n?.url && (
                <>
                  <audio src={n.url} controls className="h-9 max-w-[220px]" />
                  <a href={n.url} download={`clip-${i + 1}.mp3`}
                    className="text-xs font-semibold text-primary hover:underline">MP3</a>
                  <button type="button" onClick={onSrt}
                    className="text-xs font-semibold text-primary hover:underline">כתוביות SRT</button>
                </>
              )}
            </div>
            {n?.error && <p className="mt-2 text-sm text-warn">{n.error}</p>}
            {n?.url && !n?.persisted && !n?.busy && (
              <p className="mt-2 text-xs text-warn">הקריינות לא נשמרה בחשבון ולא תיכנס לריל הסופי. התחברו ונסו שוב.</p>
            )}
            {n?.spokenText && n?.spokenText !== n?.originalText && (
              <p className="mt-2 text-xs text-muted">נהגה כ: <span dir="rtl">{n.spokenText}</span> · בכתוביות: {n.originalText}</p>
            )}
            {!n?.error && !n?.url && (
              <p className="mt-2 text-xs text-muted">הקריינות נוצרת בנפרד מהווידאו — שינוי מילה לא מצריך רינדור מחדש של הסרטון.</p>
            )}
          </div>)}
        </div>
      </div>
    </Card>
  );
}
