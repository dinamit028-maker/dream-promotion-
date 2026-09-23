'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { MediaService } from '@/lib/services/media.service';
import { PRICE_PER_SECOND, VideoService, type ClipUpdate } from '@/lib/services/video.service';
import { imageToDataUri, lastFrameDataUri } from '@/lib/media';
import { videoErrorMessage, aiErrorMessage } from '@/lib/errors';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Card, Chip, Field, Input, PageHead, Pill, Textarea } from '@/components/ui/primitives';
import { AdapterNote, AiUnavailable, CloseButton, EmptyState, GenerationState, Modal, Spinner } from '@/components/ui/feedback';
import {
  FilmSlate, Sparkle, Play, ImageGlyph, Check, Warning, UploadSimple, ArrowsClockwise,
  Trash, Plus, CaretLeft, CaretRight, MagicWand,
} from '@/components/ui/Icon';
import { PALETTE, cx } from '@/lib/utils';
import type { ReelScene, Storyboard } from '@/types';

type Res = keyof typeof PRICE_PER_SECOND;
type Clip = ClipUpdate & { startedAt?: number; code?: string };

const LENGTHS = [15, 30, 45];
const ROLE_HE: Record<string, string> = {
  hook: 'הוק', problem: 'בעיה', solution: 'פתרון', proof: 'הוכחה', cta: 'קריאה לפעולה',
};

/** The model sometimes packs the whole structure into one role name; show something readable. */
function roleLabel(role: string | undefined, i: number) {
  if (!role) return `קליפ ${i + 1}`;
  const parts = role.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (parts.length > 2) return `קליפ ${i + 1}`;
  const he = parts.map((p) => ROLE_HE[p]).filter(Boolean);
  return he.length ? he.join(' · ') : role;
}

export default function ReelsPage() {
  const aiReady = useAiReady();
  const { brand, media, addMedia, addContent } = useApp();

  const [videoReady, setVideoReady] = useState<boolean | null>(null);
  useEffect(() => { VideoService.available().then(setVideoReady); }, []);

  const [brief, setBrief] = useState('');
  const [total, setTotal] = useState(45);
  const [res, setRes] = useState<Res>('720p');
  const [seamless, setSeamless] = useState(true);
  const [board, setBoard] = useState<Storyboard | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [photos, setPhotos] = useState<Record<number, string | null>>({});
  const [clips, setClips] = useState<Record<number, Clip>>({});
  const [running, setRunning] = useState(false);
  const [rethinking, setRethinking] = useState<number | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [, tick] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // arriving from the create studio with a ready brief
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const b = q.get('brief');
    if (b) setBrief(b);
  }, []);

  const anyActive = Object.values(clips).some((c) => c.status === 'queued' || c.status === 'running');
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyActive]);

  const scenes = board?.scenes ?? [];
  const cost = useMemo(
    () => scenes.reduce((s, sc) => s + (sc.seconds || 15), 0) * PRICE_PER_SECOND[res],
    [scenes, res],
  );
  const doneUrls = scenes.map((_, i) => clips[i]?.url).filter(Boolean) as string[];
  const allDone = scenes.length > 0 && doneUrls.length === scenes.length;

  const setScenes = (next: ReelScene[]) => setBoard((b) => (b ? { ...b, scenes: next } : b));
  const clearClip = (i: number) => setClips((c) => { const { [i]: _drop, ...rest } = c; return rest; });

  async function plan() {
    setPlanning(true); setPlanError(null); setClips({}); setPhotos({});
    try { setBoard(await AIService.storyboard(brand, brief, total)); }
    catch (e: any) { setPlanError(aiErrorMessage(e.code)); }
    finally { setPlanning(false); }
  }

  const photoUrl = (i: number) => {
    const id = photos[i];
    return id ? media.find((m) => m.id === id)?.url : undefined;
  };

  /** Ask the model for a different visual direction for one clip. */
  async function rethinkScene(i: number) {
    const sc = scenes[i];
    setRethinking(i);
    try {
      const idea = await AIService.sceneIdea(brand, sc.role || '', sc.onScreen || '', sc.videoPrompt || sc.visual || '');
      setScenes(scenes.map((s, n) => (n === i ? { ...s, videoPrompt: idea.videoPrompt, visual: idea.visual || s.visual } : s)));
      clearClip(i);
    } catch (e: any) {
      setClips((c) => ({ ...c, [i]: { status: 'failed', error: aiErrorMessage(e.code) } }));
    } finally { setRethinking(null); }
  }

  async function renderScene(i: number, startImage?: string): Promise<string> {
    const sc = scenes[i];
    const startedAt = Date.now();
    const set = (u: ClipUpdate) => setClips((c) => ({ ...c, [i]: { ...c[i], ...u, startedAt } }));
    if (!startImage) {
      const url = photoUrl(i);
      if (url) startImage = await imageToDataUri(url);
    }
    try {
      return await VideoService.generate({
        prompt: sc.videoPrompt || sc.visual,
        duration: sc.seconds || 15,
        resolution: res,
        aspectRatio: '9:16',
        startImage,
      }, set, abort.current?.signal);
    } catch (e: any) {
      setClips((c) => ({ ...c, [i]: { ...c[i], status: 'failed', error: e.message, code: e.code, startedAt } }));
      throw e;
    }
  }

  async function renderAll(only?: number) {
    if (!scenes.length) return;
    abort.current = new AbortController();
    setRunning(true);
    try {
      if (only !== undefined) { await renderScene(only).catch(() => {}); return; }
      if (seamless) {
        let prev: string | undefined;
        for (let i = 0; i < scenes.length; i++) {
          if (clips[i]?.status === 'done' && clips[i].url) { prev = clips[i].url; continue; }
          let start: string | undefined;
          if (prev && !photos[i]) {
            try { start = await lastFrameDataUri(prev); } catch { start = undefined; }
          }
          prev = await renderScene(i, start);
        }
      } else {
        await Promise.allSettled(
          scenes.map((_, i) => (clips[i]?.status === 'done' ? Promise.resolve(clips[i].url!) : renderScene(i))),
        );
      }
    } catch { /* the failing clip shows its own message */ }
    finally { setRunning(false); }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length || picking === null) return;
    const target = picking;
    try {
      const asset = await MediaService.upload(files[0]);
      addMedia(asset);
      setPhotos((p) => ({ ...p, [target]: asset.id }));
      setPicking(null);
    } catch { /* the media screen reports upload problems */ }
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
        <Card>
          <Field label="על מה הסרטון?">
            <Textarea value={brief} onChange={(e) => setBrief(e.target.value)}
              placeholder="למשל: טיפול פנים לפני החורף — לפני ואחרי, בקליניקה ברמת אביב" />
          </Field>
          <Field label="אורך">
            <div className="flex flex-wrap gap-2">
              {LENGTHS.map((d) => (
                <Chip key={d} on={total === d} onClick={() => setTotal(d)}>
                  {d} שנ׳ · {d / 15} {d === 15 ? 'קליפ' : 'קליפים'}
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
              עלות משוערת: <strong className="text-ink">${(total * PRICE_PER_SECOND[res]).toFixed(2)}</strong> · לא כולל ניסיונות חוזרים
            </p>
          </Field>
          <Button variant="primary" size="lg" className="w-full" onClick={plan} disabled={!aiReady || planning}>
            <Sparkle size={20} weight="fill" aria-hidden />בניית תסריט
          </Button>
          {aiReady === false && <div className="mt-4"><AiUnavailable /></div>}
        </Card>

        <div>
          {planning && <GenerationState lines={['קורא את המותג…', 'מחלק לקליפים…', 'כותב כיוון ויזואלי לכל סצנה…']} step={1} />}
          {planError && <AdapterNote title="בניית התסריט נכשלה.">{planError}</AdapterNote>}
          {!planning && !board && !planError && (
            <EmptyState icon={<FilmSlate />} title="אין עדיין תסריט"
              body="תארו את הסרטון, בחרו אורך, וה-AI יחלק אותו לקליפים של 15 שניות שמתחברים לרצף אחד." />
          )}

          {board && !planning && (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-display text-xl font-bold">{board.title}</h3>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={plan} disabled={running}>
                    <ArrowsClockwise size={16} aria-hidden />תסריט חדש
                  </Button>
                  {doneUrls.length > 0 && <Button size="sm" variant="primary" onClick={saveReel}>שמירה לתוכן</Button>}
                </div>
              </div>

              {videoReady === false && (
                <div className="mb-4">
                  <AdapterNote title="מנוע הווידאו לא מוגדר.">
                    הוסיפו <code>FAL_KEY</code> במשתני הסביבה של Vercel ובצעו פריסה מחדש. עד אז אפשר לבנות ולערוך תסריט, אבל לא לרנדר.
                  </AdapterNote>
                </div>
              )}

              {doneUrls.length > 0 && <SequencePlayer urls={doneUrls} />}

              <div className="mt-4 grid gap-3">
                {scenes.map((sc, i) => {
                  const c = clips[i];
                  const elapsed = c?.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
                  const pUrl = photoUrl(i);
                  const err = c?.status === 'failed' ? videoErrorMessage(c.error, c.code) : null;
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
                            <Pill tone="ai">{roleLabel(sc.role, i)} · {sc.seconds || 15} שנ׳</Pill>
                            <ClipBadge clip={c} elapsed={elapsed} />
                          </div>
                          <strong className="mt-2 block">{sc.onScreen}</strong>
                          <p className="mt-1 text-sm text-muted">קריינות: {sc.voiceover || '—'}</p>
                          <p className="mt-0.5 text-sm text-muted">{sc.visual}</p>

                          {err && (
                            <div className="mt-3 rounded-2xl bg-[var(--warn-soft)] p-3">
                              <strong className="block text-sm text-warn">{err.title}</strong>
                              {err.body && <p className="mt-1 text-sm text-ink-2">{err.body}</p>}
                            </div>
                          )}

                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(i)} disabled={running}>עריכה</Button>
                            <Button size="sm" variant="ghost" onClick={() => rethinkScene(i)} disabled={running || rethinking === i || !aiReady}>
                              {rethinking === i ? <><Spinner />מחפש כיוון…</> : <><MagicWand size={16} aria-hidden />סצנה אחרת</>}
                            </Button>
                            {videoReady && c?.status !== 'running' && c?.status !== 'queued' && (
                              <Button size="sm" variant="ghost" onClick={() => renderAll(i)} disabled={running}>
                                {c?.url ? 'רינדור מחדש' : 'רינדור הקליפ'}
                              </Button>
                            )}
                            {scenes.length > 1 && (
                              <>
                                <Button size="sm" variant="ghost" aria-label="הזזה אחורה" disabled={running || i === 0}
                                  onClick={() => { const n = [...scenes]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setScenes(n); setClips({}); }}>
                                  <CaretRight size={15} aria-hidden />
                                </Button>
                                <Button size="sm" variant="ghost" aria-label="הזזה קדימה" disabled={running || i === scenes.length - 1}
                                  onClick={() => { const n = [...scenes]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setScenes(n); setClips({}); }}>
                                  <CaretLeft size={15} aria-hidden />
                                </Button>
                                <Button size="sm" variant="ghost" className="text-[var(--danger)]" aria-label="מחיקת סצנה" disabled={running}
                                  onClick={() => { setScenes(scenes.filter((_, n) => n !== i)); setClips({}); }}>
                                  <Trash size={15} aria-hidden />
                                </Button>
                              </>
                            )}
                          </div>

                          {i > 0 && seamless && !photos[i] && !c?.url && (
                            <p className="mt-2 text-xs text-muted">ימשיך מהפריים האחרון של קליפ {i}</p>
                          )}
                        </div>
                      </div>
                    </Card>
                  );
                })}

                <Button variant="ghost" className="w-full" disabled={running}
                  onClick={() => setScenes([...scenes, {
                    role: 'cta', seconds: 15, onScreen: 'קריאה לפעולה', voiceover: '',
                    visual: 'סצנה נוספת', videoPrompt: '',
                  }])}>
                  <Plus size={18} aria-hidden />הוספת סצנה
                </Button>
              </div>

              <Card className="mt-4">
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
                    {scenes.length} קליפים · {scenes.reduce((s, x) => s + (x.seconds || 15), 0)} שנ׳ · {res} · <strong className="text-ink">${cost.toFixed(2)}</strong>
                  </span>
                  <div className="flex gap-2">
                    {running && (
                      <Button variant="ghost" onClick={() => { abort.current?.abort(); setRunning(false); }}>עצירה</Button>
                    )}
                    <Button variant="primary" onClick={() => renderAll()} disabled={!videoReady || running || allDone}>
                      {running ? <><Spinner />מרנדר…</> : allDone ? <><Check size={18} aria-hidden />הכול מוכן</> : <><Play size={18} weight="fill" aria-hidden />יצירת הסרטון</>}
                    </Button>
                  </div>
                </div>
              </Card>

              <p className="mt-3 text-xs text-muted">
                הכיתובים והקריינות בעברית מתווספים בשלב החיבור לקובץ אחד — מודלי וידאו לא כותבים עברית באופן אמין, ולכן הם לא מתבקשים לכתוב טקסט בתוך התמונה.
              </p>
            </>
          )}
        </div>
      </div>

      {/* ---------- scene editor ---------- */}
      <Modal open={editing !== null} onClose={() => setEditing(null)}>
        {editing !== null && scenes[editing] && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-xl font-bold">עריכת {roleLabel(scenes[editing].role, editing)}</h3>
              <CloseButton onClick={() => setEditing(null)} />
            </div>
            <Field label="כיתוב על המסך">
              <Input value={scenes[editing].onScreen}
                onChange={(e) => setScenes(scenes.map((s, n) => (n === editing ? { ...s, onScreen: e.target.value } : s)))} />
            </Field>
            <Field label="קריינות">
              <Textarea className="min-h-20" value={scenes[editing].voiceover}
                onChange={(e) => setScenes(scenes.map((s, n) => (n === editing ? { ...s, voiceover: e.target.value } : s)))} />
            </Field>
            <Field label="אורך הקליפ (שניות)">
              <Input type="number" min={2} max={30} value={scenes[editing].seconds}
                onChange={(e) => setScenes(scenes.map((s, n) => (n === editing ? { ...s, seconds: Math.min(30, Math.max(2, +e.target.value || 15)) } : s)))} />
            </Field>
            <Field label="הפרומפט שנשלח למנוע הווידאו (אנגלית)">
              <Textarea className="min-h-28 text-left" dir="ltr" value={scenes[editing].videoPrompt || ''}
                onChange={(e) => setScenes(scenes.map((s, n) => (n === editing ? { ...s, videoPrompt: e.target.value } : s)))} />
            </Field>
            <p className="mb-4 text-sm text-muted">
              סצנות של אנשים, מקומות ומוצרים עוברות כמעט תמיד. הפשטות טכנולוגיות, מפות עולם ומסכים עם ממשקים נחסמות בבדיקת התוכן.
            </p>
            <Button variant="primary" onClick={() => setEditing(null)}>סיום</Button>
          </>
        )}
      </Modal>

      {/* ---------- photo picker, with upload built in ---------- */}
      <Modal open={picking !== null} onClose={() => setPicking(null)}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-xl font-bold">תמונת פתיחה לקליפ {(picking ?? 0) + 1}</h3>
          <CloseButton onClick={() => setPicking(null)} />
        </div>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => onFiles(e.target.files)} />
        <Button variant="ghost" className="mb-4 w-full" onClick={() => fileInput.current?.click()}>
          <UploadSimple size={18} aria-hidden />העלאת תמונה מהמחשב
        </Button>
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
          <p className="rounded-2xl bg-surface-2 p-4 text-sm text-muted">
            אין עדיין תמונות בספרייה. העלו אחת מכאן, או השאירו בלי תמונה והמנוע ייצר את הסצנה מאפס.
          </p>
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

/** Plays finished clips back to back, so a 45s reel can be judged as one piece. */
function SequencePlayer({ urls }: { urls: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => { if (i >= urls.length) setI(0); }, [urls.length, i]);
  return (
    <Card className="p-3">
      <div className="mx-auto w-full max-w-[300px]">
        <video key={urls[i]} src={urls[i]} controls playsInline autoPlay={i > 0}
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
