'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { PRICE_PER_SECOND, VideoService, type ClipUpdate } from '@/lib/services/video.service';
import { imageToDataUri, lastFrameDataUri } from '@/lib/media';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Card, Chip, Field, PageHead, Pill, Textarea } from '@/components/ui/primitives';
import { AdapterNote, AiUnavailable, CloseButton, EmptyState, GenerationState, Modal, Spinner } from '@/components/ui/feedback';
import { FilmSlate, Sparkle, Play, ImageGlyph, Check, Warning, UploadSimple, ArrowsClockwise } from '@/components/ui/Icon';
import { PALETTE, cx } from '@/lib/utils';
import type { Storyboard } from '@/types';

type Res = keyof typeof PRICE_PER_SECOND;
type Clip = ClipUpdate & { startedAt?: number };

const LENGTHS = [15, 30, 45];

export default function ReelsPage() {
  const aiReady = useAiReady();
  const { brand, media, addContent } = useApp();

  const [videoReady, setVideoReady] = useState<boolean | null>(null);
  useEffect(() => { VideoService.available().then(setVideoReady); }, []);

  const [brief, setBrief] = useState('');
  const [total, setTotal] = useState(45);
  const [res, setRes] = useState<Res>('720p');
  const [seamless, setSeamless] = useState(true);
  const [board, setBoard] = useState<Storyboard | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [photos, setPhotos] = useState<Record<number, string | null>>({});   // scene → media id
  const [clips, setClips] = useState<Record<number, Clip>>({});
  const [running, setRunning] = useState(false);
  const [picking, setPicking] = useState<number | null>(null);
  const [, tick] = useState(0);
  const abort = useRef<AbortController | null>(null);

  // re-render once a second while anything renders, so elapsed time moves
  const anyActive = Object.values(clips).some((c) => c.status === 'queued' || c.status === 'running');
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyActive]);

  const scenes = board?.scenes ?? [];
  const cost = useMemo(() => scenes.reduce((s, sc) => s + (sc.seconds || 15), 0) * PRICE_PER_SECOND[res], [scenes, res]);
  const doneUrls = scenes.map((_, i) => clips[i]?.url).filter(Boolean) as string[];
  const allDone = scenes.length > 0 && doneUrls.length === scenes.length;

  async function plan() {
    setPlanning(true); setPlanError(null); setClips({});
    try { setBoard(await AIService.storyboard(brand, brief, total)); }
    catch (e: any) { setPlanError(e.code || 'error'); }
    finally { setPlanning(false); }
  }

  const photoUrl = (i: number) => {
    const id = photos[i]; return id ? media.find((m) => m.id === id)?.url : undefined;
  };

  async function renderScene(i: number, startImage?: string): Promise<string> {
    const sc = scenes[i];
    const startedAt = Date.now();
    const set = (u: ClipUpdate) => setClips((c) => ({ ...c, [i]: { ...c[i], ...u, startedAt } }));
    if (!startImage) {
      const url = photoUrl(i);
      if (url) startImage = await imageToDataUri(url);
    }
    return VideoService.generate({
      prompt: sc.videoPrompt || sc.visual,
      duration: sc.seconds || 15,
      resolution: res,
      aspectRatio: '9:16',
      startImage,
    }, set, abort.current?.signal);
  }

  async function renderAll() {
    if (!scenes.length) return;
    abort.current = new AbortController();
    setRunning(true);
    try {
      if (seamless) {
        // one after another: each clip starts on the previous clip's last frame
        let prev: string | undefined;
        for (let i = 0; i < scenes.length; i++) {
          if (clips[i]?.status === 'done' && clips[i].url) { prev = clips[i].url; continue; }
          let start: string | undefined;
          if (prev && !photos[i]) {
            try { start = await lastFrameDataUri(prev); } catch { start = undefined; } // host blocked frame read → scene photo or text
          }
          prev = await renderScene(i, start);
        }
      } else {
        await Promise.allSettled(scenes.map((_, i) => (clips[i]?.status === 'done' ? Promise.resolve(clips[i].url!) : renderScene(i))));
      }
    } catch { /* the failing clip already shows its own error */ }
    finally { setRunning(false); }
  }

  function saveReel() {
    if (!board) return;
    addContent({
      kind: 'reel', platform: 'Instagram', goal: '', headline: board.title, caption: board.caption || '',
      hashtags: board.hashtags || [], cta: brand.cta, emoji: '', palette: PALETTE.reel,
      scenes: scenes.map((s, i) => ({ ...s, clipUrl: clips[i]?.url })),
      mediaId: photos[0] ?? null, status: 'draft', date: null, time: null,
    });
  }

  return (
    <>
      <PageHead title="אולפן הרילס" sub="תסריט מה-AI, קליפים מ-Wan 3.0, ורצף אחד מוכן לצפייה." />

      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* ---------- brief ---------- */}
        <Card>
          <Field label="על מה הסרטון?">
            <Textarea value={brief} onChange={(e) => setBrief(e.target.value)}
              placeholder="למשל: טיפול פנים לפני החורף — לפני ואחרי, בקליניקה ברמת אביב" />
          </Field>
          <Field label="אורך">
            <div className="flex flex-wrap gap-2">
              {LENGTHS.map((d) => (
                <Chip key={d} on={total === d} onClick={() => setTotal(d)}>{d} שנ׳ · {d / 15} {d === 15 ? 'קליפ' : 'קליפים'}</Chip>
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
              עלות משוערת לסרטון: <strong className="text-ink">${(total * PRICE_PER_SECOND[res]).toFixed(2)}</strong> · לא כולל ניסיונות חוזרים
            </p>
          </Field>
          <Button variant="primary" size="lg" className="w-full" onClick={plan} disabled={!aiReady || planning}>
            <Sparkle size={20} weight="fill" aria-hidden />בניית תסריט
          </Button>
          {aiReady === false && <div className="mt-4"><AiUnavailable /></div>}
        </Card>

        {/* ---------- storyboard + clips ---------- */}
        <div>
          {planning && <GenerationState lines={['קורא את המותג…', 'מחלק לקליפים…', 'כותב פרומפט וידאו לכל סצנה…']} step={1} />}
          {planError && <AdapterNote title="בניית התסריט נכשלה.">קוד: {planError}. נסו תיאור מפורט יותר.</AdapterNote>}
          {!planning && !board && !planError && (
            <EmptyState icon={<FilmSlate />} title="אין עדיין תסריט"
              body="תארו את הסרטון, בחרו אורך, וה-AI יחלק אותו לקליפים של 15 שניות שמתחברים לרצף אחד." />
          )}

          {board && !planning && (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-display text-xl font-bold">{board.title}</h3>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={plan} disabled={running}><ArrowsClockwise size={16} aria-hidden />תסריט חדש</Button>
                  {allDone && <Button size="sm" variant="primary" onClick={saveReel}>שמירה לתוכן</Button>}
                </div>
              </div>

              {videoReady === false && (
                <div className="mb-4">
                  <AdapterNote title="מנוע הווידאו לא מוגדר.">
                    הוסיפו <code>FAL_KEY</code> במשתני הסביבה של Vercel ופרסו מחדש. עד אז אפשר לבנות תסריט, אבל לא לרנדר.
                  </AdapterNote>
                </div>
              )}

              {/* one continuous preview of everything rendered so far */}
              {doneUrls.length > 0 && <SequencePlayer urls={doneUrls} />}

              <div className="mt-4 grid gap-3">
                {scenes.map((sc, i) => {
                  const c = clips[i];
                  const elapsed = c?.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
                  const pUrl = photoUrl(i);
                  return (
                    <Card key={i} className="p-4">
                      <div className="flex gap-4">
                        <button type="button" onClick={() => setPicking(i)} disabled={running}
                          aria-label={pUrl ? 'החלפת תמונת פתיחה' : 'בחירת תמונת פתיחה'}
                          className="relative flex aspect-[9/16] w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border-[1.5px] border-dashed border-line bg-surface-2 text-muted hover:border-primary hover:text-primary sm:w-24">
                          {c?.url ? <video src={c.url} muted playsInline className="absolute inset-0 h-full w-full object-cover" />
                            : pUrl ? <img src={pUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                            : <span className="flex flex-col items-center gap-1 text-[11px] font-semibold"><ImageGlyph size={22} aria-hidden />תמונה</span>}
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <Pill tone="ai">קליפ {i + 1} · {sc.role}</Pill>
                            <ClipBadge clip={c} elapsed={elapsed} />
                          </div>
                          <strong className="mt-2 block">{sc.onScreen}</strong>
                          <p className="mt-1 text-sm text-muted">קריינות: {sc.voiceover || '—'}</p>
                          <p className="mt-0.5 text-sm text-muted">{sc.visual}</p>
                          {c?.status === 'failed' && <p className="mt-2 text-sm text-[var(--danger)]">{humanError(c.error)}</p>}
                          {i > 0 && seamless && !photos[i] && !c?.url && (
                            <p className="mt-2 text-xs text-muted">ימשיך מהפריים האחרון של קליף {i}</p>
                          )}
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>

              <Card className="mt-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" checked={seamless} onChange={(e) => setSeamless(e.target.checked)} disabled={running}
                    className="mt-1 h-5 w-5 accent-[var(--primary)]" />
                  <span>
                    <strong className="block">רצף חלק</strong>
                    <span className="text-sm text-muted">
                      כל קליף מתחיל בדיוק איפה שהקודם נגמר. איטי יותר — הקליפים נוצרים אחד אחרי השני. בלי זה, כולם נוצרים במקביל.
                    </span>
                  </span>
                </label>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <span className="text-sm text-muted">
                    {scenes.length} קליפים · {scenes.reduce((s, x) => s + (x.seconds || 15), 0)} שנ׳ · {res} · <strong className="text-ink">${cost.toFixed(2)}</strong>
                  </span>
                  <Button variant="primary" onClick={renderAll} disabled={!videoReady || running || allDone}>
                    {running ? <><Spinner />מרנדר…</> : allDone ? <><Check size={18} aria-hidden />הכול מוכן</> : <><Play size={18} weight="fill" aria-hidden />יצירת הסרטון</>}
                  </Button>
                </div>
              </Card>

              <p className="mt-3 text-xs text-muted">
                הכיתובים והקריינות בעברית יתווספו בשלב החיבור לקובץ אחד — מודלי וידאו לא כותבים עברית באופן אמין, ולכן הם לא מתבקשים לכתוב טקסט בתוך התמונה.
              </p>
            </>
          )}
        </div>
      </div>

      {/* ---------- photo picker ---------- */}
      <Modal open={picking !== null} onClose={() => setPicking(null)}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-xl font-bold">תמונת פתיחה לקליף {(picking ?? 0) + 1}</h3>
          <CloseButton onClick={() => setPicking(null)} />
        </div>
        {media.filter((m) => m.kind === 'image').length ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {media.filter((m) => m.kind === 'image').map((m) => (
              <button key={m.id} type="button"
                onClick={() => { setPhotos((p) => ({ ...p, [picking!]: m.id })); setPicking(null); }}
                className={cx('aspect-square overflow-hidden rounded-xl ring-2 ring-offset-2 ring-offset-surface',
                  photos[picking ?? -1] === m.id ? 'ring-primary' : 'ring-transparent hover:ring-line')}>
                <img src={m.url} alt={m.name} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        ) : (
          <EmptyState icon={<UploadSimple />} title="אין תמונות בספרייה" body="העלו תמונות של העסק במסך המדיה, והן יופיעו כאן." />
        )}
        {picking !== null && photos[picking] && (
          <Button variant="ghost" className="mt-4 w-full"
            onClick={() => { setPhotos((p) => ({ ...p, [picking]: null })); setPicking(null); }}>
            בלי תמונה — לייצר מטקסט בלבד
          </Button>
        )}
      </Modal>
    </>
  );
}

function ClipBadge({ clip, elapsed }: { clip?: Clip; elapsed: number }) {
  if (!clip) return <Pill>ממתין</Pill>;
  const t = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  if (clip.status === 'queued') return <Pill tone="warn"><Spinner />בתור{clip.position ? ` · ${clip.position}` : ''} · {t}</Pill>;
  if (clip.status === 'running') return <Pill tone="ai"><Spinner />מרנדר · {t}</Pill>;
  if (clip.status === 'done') return <Pill tone="ok"><Check size={13} weight="bold" aria-hidden />מוכן</Pill>;
  return <Pill tone="warn"><Warning size={13} weight="bold" aria-hidden />נכשל</Pill>;
}

function humanError(e?: string) {
  if (!e) return 'היצירה נכשלה.';
  if (/balance|402|credit/i.test(e)) return 'אין מספיק יתרה בחשבון fal. טענו קרדיט ונסו שוב.';
  if (/safety|moderation|nsfw/i.test(e)) return 'המודל חסם את הבקשה בבדיקת התוכן. נסו לנסח את הסצנה אחרת.';
  if (/access/i.test(e)) return 'קוד הגישה חסר או שגוי — עדכנו אותו בהגדרות.';
  return `היצירה נכשלה: ${e}`;
}

/** Plays finished clips back to back, so a 45s reel can be judged as one piece. */
function SequencePlayer({ urls }: { urls: string[] }) {
  const [i, setI] = useState(0);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (i >= urls.length) setI(0); }, [urls.length, i]);
  return (
    <Card className="p-3">
      <div className="mx-auto w-full max-w-[300px]">
        <video ref={ref} key={urls[i]} src={urls[i]} controls playsInline autoPlay={i > 0}
          onEnded={() => setI((n) => (n + 1 < urls.length ? n + 1 : n))}
          className="aspect-[9/16] w-full rounded-xl bg-black object-cover" />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {urls.map((u, n) => (
          <div key={u} className="flex items-center gap-1">
            <Chip on={n === i} onClick={() => setI(n)}>קליפ {n + 1}</Chip>
            <a href={u} target="_blank" rel="noopener noreferrer" download
              className="text-xs font-semibold text-primary underline-offset-2 hover:underline">הורדה</a>
          </div>
        ))}
      </div>
    </Card>
  );
}
