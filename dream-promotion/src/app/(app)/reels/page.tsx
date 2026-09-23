'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { MediaService } from '@/lib/services/media.service';
import { PRICE_PER_SECOND, VideoService, type ClipUpdate } from '@/lib/services/video.service';
import { ImageService, PRICE_PER_IMAGE } from '@/lib/services/image.service';
import { imageToDataUri, lastFrameDataUri } from '@/lib/media';
import { videoErrorMessage, aiErrorMessage } from '@/lib/errors';
import { VoiceService } from '@/lib/services/voice.service';
import { VoicePanel, voiceErrorText } from '@/features/reels/VoicePanel';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Card, Chip, Field, Input, PageHead, Pill, Textarea } from '@/components/ui/primitives';
import { AdapterNote, AiUnavailable, CloseButton, EmptyState, GenerationState, Modal, Spinner } from '@/components/ui/feedback';
import {
  FilmSlate, Sparkle, Play, ImageGlyph, Check, Warning, UploadSimple, ArrowsClockwise,
  Trash, Plus, CaretLeft, CaretRight, MagicWand, PaperPlaneTilt,
} from '@/components/ui/Icon';
import { PALETTE, cx } from '@/lib/utils';
import type { ReelScene, Storyboard } from '@/types';

type Res = keyof typeof PRICE_PER_SECOND;
type Clip = ClipUpdate & { startedAt?: number; code?: string; kind?: 'video' | 'image' };

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
  const { brand, media, addMedia, addContent, voice, pronunciations } = useApp();
  type Narr = { url?: string; srt?: string; busy?: boolean; error?: string };
  const [narr, setNarr] = useState<Record<number, Narr>>({});

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
  const [imageMode, setImageMode] = useState<Record<number, boolean>>({});
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
    () => scenes.reduce((sum, sc, i) => sum + (imageMode[i] ? PRICE_PER_IMAGE : (sc.seconds || 15) * PRICE_PER_SECOND[res]), 0),
    [scenes, res, imageMode],
  );
  const doneUrls = scenes.map((_, i) => clips[i]?.url).filter(Boolean) as string[];
  const allDone = scenes.length > 0 && doneUrls.length === scenes.length;

  const setScenes = (next: ReelScene[]) => setBoard((b) => (b ? { ...b, scenes: next } : b));

  /** Reorder or remove scenes WITHOUT throwing away clips that were already paid for. */
  function remap(order: (number | null)[]) {
    const nextClips: Record<number, Clip> = {};
    const nextPhotos: Record<number, string | null> = {};
    const nextMode: Record<number, boolean> = {};
    order.forEach((from, to) => {
      if (from === null) return;
      if (clips[from]) nextClips[to] = clips[from];
      if (photos[from] !== undefined) nextPhotos[to] = photos[from];
      if (imageMode[from] !== undefined) nextMode[to] = imageMode[from];
    });
    setClips(nextClips); setPhotos(nextPhotos); setImageMode(nextMode);
  }

  function swapScenes(i: number, j: number) {
    const next = [...scenes];
    [next[i], next[j]] = [next[j], next[i]];
    const order = scenes.map((_, n) => (n === i ? j : n === j ? i : n));
    setScenes(next); remap(order);
  }

  function removeScene(i: number) {
    setScenes(scenes.filter((_, n) => n !== i));
    remap(scenes.map((_, n) => n).filter((n) => n !== i));
  }
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

  /** Narration is independent of the video: changing a word re-renders only the audio. */
  async function narrateScene(i: number) {
    const sc = scenes[i];
    const text = (sc.voiceover || '').trim();
    if (!text) { setNarr((n) => ({ ...n, [i]: { error: 'אין טקסט קריינות לסצנה הזו.' } })); return; }
    if (!voice.voiceId) { setNarr((n) => ({ ...n, [i]: { error: 'בחרו קול בפאנל הקריינות.' } })); return; }
    setNarr((n) => ({ ...n, [i]: { busy: true } }));
    try {
      const out = await VoiceService.narrate({
        text, voiceId: voice.voiceId, style: voice.style, language: voice.language, pronunciations,
      });
      setNarr((n) => ({ ...n, [i]: { url: out.audioUrl, srt: out.srt } }));
    } catch (e: any) {
      setNarr((n) => ({ ...n, [i]: { error: voiceErrorText(e.code) } }));
    }
  }

  const downloadText = (name: string, body: string) => {
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  async function renderScene(i: number, startImage?: string): Promise<string> {
    const sc = scenes[i];
    const startedAt = Date.now();
    const set = (u: ClipUpdate) => setClips((c) => ({ ...c, [i]: { ...c[i], ...u, startedAt } }));

    // a still image costs 8 cents instead of 75 — enough for most scenes
    if (imageMode[i]) {
      set({ status: 'running' });
      try {
        const urls = await ImageService.generate({
          prompt: sc.videoPrompt || sc.visual, aspectRatio: '9:16', count: 1,
        }, undefined, abort.current?.signal);
        setClips((c) => ({ ...c, [i]: { status: 'done', url: urls[0], kind: 'image', startedAt } }));
        keepInLibrary(i, urls[0], 'image');
        return urls[0];
      } catch (e: any) {
        setClips((c) => ({ ...c, [i]: { status: 'failed', error: e.message, code: e.code, kind: 'image', startedAt } }));
        throw e;
      }
    }

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
      }, (u) => { set(u); if (u.status === 'done' && u.url) keepInLibrary(i, u.url, 'video'); }, abort.current?.signal);
    } catch (e: any) {
      setClips((c) => ({ ...c, [i]: { ...c[i], status: 'failed', error: e.message, code: e.code, startedAt } }));
      throw e;
    }
  }

  /** Every finished asset lands in the media library immediately — no manual save. */
  function keepInLibrary(i: number, url: string, kind: 'video' | 'image') {
    addMedia({
      id: `${kind}-${Date.now()}-${i}`,
      url,
      name: `${board?.title || 'reel'} · ${kind === 'video' ? 'קליפ' : 'תמונה'} ${i + 1}`,
      kind: kind === 'video' ? 'video' : 'image',
      persistent: false,
    });
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
          if (prev && !photos[i] && !imageMode[i]) {
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
      scenes: scenes.map((s, i) => ({ ...s, clipUrl: clips[i]?.url, voiceUrl: narr[i]?.url, srt: narr[i]?.srt })),
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

        <div className="lg:col-start-1 lg:row-start-2">
          <VoicePanel />
        </div>

        <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
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

              {doneUrls.length > 0 && (
                <SequencePlayer items={scenes.map((_, i) => clips[i]).filter((c) => c?.url).map((c) => ({ url: c!.url!, kind: c!.kind ?? 'video' }))} />
              )}

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
                          {c?.url ? (c.kind === 'image'
                              ? <img src={c.url} alt="" className="absolute inset-0 h-full w-full object-cover" />
                              : <video src={c.url} muted playsInline className="absolute inset-0 h-full w-full object-cover" />)
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

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <div className="flex overflow-hidden rounded-full border border-line">
                              {([[false, 'וידאו'], [true, 'תמונה']] as [boolean, string][]).map(([mode, label]) => (
                                <button key={label} type="button" disabled={running}
                                  onClick={() => { setImageMode((m) => ({ ...m, [i]: mode })); clearClip(i); }}
                                  className={cx('px-3 py-1.5 text-xs font-semibold transition-colors',
                                    Boolean(imageMode[i]) === mode ? 'bg-primary text-white' : 'hover:bg-surface-2')}>
                                  {label}
                                </button>
                              ))}
                            </div>
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
                                  onClick={() => swapScenes(i, i - 1)}>
                                  <CaretRight size={15} aria-hidden />
                                </Button>
                                <Button size="sm" variant="ghost" aria-label="הזזה קדימה" disabled={running || i === scenes.length - 1}
                                  onClick={() => swapScenes(i, i + 1)}>
                                  <CaretLeft size={15} aria-hidden />
                                </Button>
                                <Button size="sm" variant="ghost" className="text-[var(--danger)]" aria-label="מחיקת סצנה" disabled={running}
                                  onClick={() => removeScene(i)}>
                                  <Trash size={15} aria-hidden />
                                </Button>
                              </>
                            )}
                          </div>

                          {i > 0 && seamless && !photos[i] && !c?.url && (
                            <p className="mt-2 text-xs text-muted">ימשיך מהפריים האחרון של קליפ {i}</p>
                          )}

                          {/* ---- narration for this scene, generated and regenerated on its own ---- */}
                          <div className="mt-3 rounded-2xl bg-surface-2 p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Button size="sm" variant="ghost" onClick={() => narrateScene(i)} disabled={narr[i]?.busy}>
                                {narr[i]?.busy ? <><Spinner />מקריא…</>
                                  : narr[i]?.url ? <><ArrowsClockwise size={15} aria-hidden />קריינות מחדש</>
                                  : <><PaperPlaneTilt size={15} aria-hidden />יצירת קריינות</>}
                              </Button>
                              {narr[i]?.url && (
                                <>
                                  <audio src={narr[i].url} controls className="h-9 max-w-[220px]" />
                                  <a href={narr[i].url} download={`clip-${i + 1}.mp3`}
                                    className="text-xs font-semibold text-primary hover:underline">MP3</a>
                                  <button type="button" onClick={() => downloadText(`clip-${i + 1}.srt`, narr[i].srt || '')}
                                    className="text-xs font-semibold text-primary hover:underline">כתוביות SRT</button>
                                </>
                              )}
                            </div>
                            {narr[i]?.error && <p className="mt-2 text-sm text-warn">{narr[i].error}</p>}
                            {!narr[i]?.error && !narr[i]?.url && (
                              <p className="mt-2 text-xs text-muted">הקריינות נוצרת בנפרד מהווידאו — שינוי מילה לא מצריך רינדור מחדש של הסרטון.</p>
                            )}
                          </div>
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
            <Field label="טקסט הקריינות — זה מה שייאמר בקול">
              <Textarea className="min-h-24" value={scenes[editing].voiceover}
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
function SequencePlayer({ items }: { items: { url: string; kind: 'video' | 'image' }[] }) {
  const [i, setI] = useState(0);
  useEffect(() => { if (i >= items.length) setI(0); }, [items.length, i]);
  // stills hold the screen for four seconds, the way they will in the finished reel
  useEffect(() => {
    if (items[i]?.kind !== 'image') return;
    const t = setTimeout(() => setI((n) => (n + 1 < items.length ? n + 1 : n)), 4000);
    return () => clearTimeout(t);
  }, [i, items]);

  const cur = items[i];
  if (!cur) return null;
  return (
    <Card className="p-3">
      <div className="mx-auto w-full max-w-[300px]">
        {cur.kind === 'image'
          ? <img src={cur.url} alt="" className="aspect-[9/16] w-full rounded-xl bg-black object-cover" />
          : <video key={cur.url} src={cur.url} controls playsInline autoPlay={i > 0}
              onEnded={() => setI((n) => (n + 1 < items.length ? n + 1 : n))}
              className="aspect-[9/16] w-full rounded-xl bg-black object-cover" />}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {items.map((it, n) => (
          <div key={it.url} className="flex items-center gap-1">
            <Chip on={n === i} onClick={() => setI(n)}>{it.kind === 'image' ? 'תמונה' : 'קליפ'} {n + 1}</Chip>
            <a href={it.url} target="_blank" rel="noopener noreferrer" download
              className="text-xs font-semibold text-primary underline-offset-2 hover:underline">הורדה</a>
          </div>
        ))}
      </div>
    </Card>
  );
}
