'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { TranscribeService } from '@/lib/services/transcribe.service';
import { Button, Chip, Input } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import type { CaptionCue, CaptionStyle } from '@/types';
import {
  FONTS, PRESETS, activeWord, drawCaption, linesFromWords, loadCaptionFont, presetStyle, regroup, wordsOf,
} from './captionImages';

export interface EditorScene {
  index: number;
  label: string;
  clipUrl: string;
  kind: 'video' | 'image';
  narrationUrl?: string;
  lines: CaptionCue[];
  /** where the lines came from */
  source: 'edited' | 'narration' | 'none';
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/**
 * The caption editor: style (font, colours, size, position, word highlight) and the text itself,
 * line by line, over a live preview that uses the very same drawing code as the final render.
 */
export function CaptionEditor({
  open, onClose, scenes, style, onStyle, onLines, brief,
}: {
  open: boolean; onClose: () => void;
  scenes: EditorScene[];
  style: CaptionStyle; onStyle: (s: CaptionStyle) => void;
  /** null: back to the automatic captions (from the narration) */
  onLines: (sceneIndex: number, lines: CaptionCue[] | null) => void;
  brief: string;
}) {
  const brand = useApp((s) => s.brand);
  const [sel, setSel] = useState(0);
  const [tab, setTab] = useState<'style' | 'text'>('style');
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [emoji, setEmoji] = useState(false);
  const [fontReady, setFontReady] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);

  const scene = scenes[sel] ?? scenes[0];
  const lines = useMemo(() => scene?.lines ?? [], [scene]);

  useEffect(() => { if (open) { setSel(0); setNote(null); setT(0); } }, [open]);
  useEffect(() => { if (!open) return; void loadCaptionFont(style.font).then(() => setFontReady((n) => n + 1)); }, [open, style.font]);

  // ---- the clock: the narration when there is one (the video follows it), otherwise the video
  const clock = () => (scene?.narrationUrl ? audio.current : video.current);
  useEffect(() => {
    setPlaying(false); setT(0);
    audio.current?.pause(); video.current?.pause();
  }, [sel]);

  useEffect(() => {
    if (!open) return;
    const tick = () => {
      const c = clock();
      const now = c?.currentTime ?? 0;
      if (scene?.narrationUrl && video.current && playing) {
        const vd = video.current.duration || 0;
        if (vd && Math.abs(video.current.currentTime - Math.min(now, vd - 0.05)) > 0.25) video.current.currentTime = Math.min(now, vd - 0.05);
      }
      setT(now);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sel, playing]);

  // ---- live caption overlay
  const current = lines.find((c) => t >= c.start && t < c.end) ?? null;
  useEffect(() => {
    if (!canvas.current) return;
    drawCaption(canvas.current, current, current ? activeWord(current, t) : -1, style);
  }, [current, t, style, fontReady]);

  function playPause() {
    const c = clock();
    if (!c) return;
    if (playing) { c.pause(); if (scene?.narrationUrl) video.current?.pause(); setPlaying(false); return; }
    if (c.ended || c.currentTime >= (c.duration || 0) - 0.05) c.currentTime = 0;
    void c.play();
    if (scene?.narrationUrl && video.current) { video.current.muted = true; void video.current.play().catch(() => {}); }
    setPlaying(true);
  }
  function seek(v: number) {
    const c = clock();
    if (c) c.currentTime = v;
    if (scene?.narrationUrl && video.current) video.current.currentTime = Math.min(v, (video.current.duration || v) - 0.05);
    setT(v);
  }

  // ---- editing
  const set = (next: CaptionCue[]) => onLines(scene.index, next);
  const setStyle = (p: Partial<CaptionStyle>) => onStyle({ ...style, ...p });

  function editText(i: number, text: string) {
    set(lines.map((c, n) => (n === i ? { ...c, text, words: undefined, ...(c.words ? { words: keepHl(c, text) } : {}) } : c)));
  }
  /** keeps word timing when the number of words did not change */
  function keepHl(c: CaptionCue, text: string) {
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (c.words && c.words.length === tokens.length) return c.words.map((w, k) => ({ ...w, text: tokens[k] }));
    return undefined;
  }
  function editTime(i: number, key: 'start' | 'end', v: number) {
    if (!Number.isFinite(v)) return;
    set(lines.map((c, n) => (n === i ? { ...c, [key]: Math.max(0, v), words: undefined } : c)));
  }
  function toggleHl(i: number, k: number) {
    set(lines.map((c, n) => {
      if (n !== i) return c;
      const w = wordsOf(c);
      w[k] = { ...w[k], hl: !w[k].hl };
      return { ...c, words: w };
    }));
  }
  function split(i: number) {
    const c = lines[i];
    const w = wordsOf(c);
    if (w.length < 2) return;
    const m = Math.ceil(w.length / 2);
    const a = w.slice(0, m), b = w.slice(m);
    const mk = (ws: typeof w): CaptionCue => ({ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((x) => x.text).join(' '), words: ws });
    set([...lines.slice(0, i), mk(a), mk(b), ...lines.slice(i + 1)]);
  }
  function merge(i: number) {
    if (i + 1 >= lines.length) return;
    const w = [...wordsOf(lines[i]), ...wordsOf(lines[i + 1])];
    const m: CaptionCue = { start: lines[i].start, end: lines[i + 1].end, text: w.map((x) => x.text).join(' '), words: w, emoji: lines[i].emoji || lines[i + 1].emoji };
    set([...lines.slice(0, i), m, ...lines.slice(i + 2)]);
  }
  const remove = (i: number) => set(lines.filter((_, n) => n !== i));
  function addAtPlayhead() {
    const start = Math.round(t * 10) / 10;
    const next = [...lines, { start, end: start + 1.5, text: 'טקסט חדש' }].sort((a, b) => a.start - b.start);
    set(next);
    setTab('text');
  }
  function wordsPerLine(n: number) {
    setStyle({ maxWords: n });
    if (lines.length) set(regroup(lines, n));
  }

  async function transcribe(target: EditorScene) {
    if (target.kind !== 'video' || !target.clipUrl.startsWith('https://')) { setNote('אפשר לתמלל רק סצנה עם סרטון.'); return; }
    setBusy(`transcribe-${target.index}`); setNote(null);
    try {
      const r = await TranscribeService.file(target.clipUrl, [brand.name, brand.industry, brand.city].filter(Boolean).join(', '));
      if (!r.words.length) { setNote('לא נשמע דיבור בסרטון הזה.'); return; }
      onLines(target.index, linesFromWords(r.words, style.maxWords));
      setNote(`תומללו ${r.words.length} מילים.`);
    } catch (e: any) {
      setNote(e.code === 'no_fal_key' ? 'תמלול לא מוגדר (חסר FAL_KEY).' : `התמלול נכשל: ${e.message}`);
    } finally { setBusy(null); }
  }
  async function transcribeAll() {
    for (const s of scenes) if (s.kind === 'video' && !s.narrationUrl) await transcribe(s);
  }

  async function polish() {
    if (!lines.length) return;
    setBusy('polish'); setNote(null);
    try {
      const r = await AIService.polishCaptions(brand, { lines: lines.map((c) => c.text), brief, emoji, fix: true });
      if (!Array.isArray(r.lines) || r.lines.length !== lines.length) throw new Error('מספר השורות השתנה');
      set(lines.map((c, i) => {
        const p = r.lines[i];
        const text = String(p.text || c.text).trim();
        const base = keepHl(c, text) ?? wordsOf({ start: c.start, end: c.end, text });
        const hl = new Set((p.hl ?? []).map(Number));
        return { ...c, text, words: base.map((w, k) => ({ ...w, hl: hl.has(k) || undefined })), emoji: p.emoji || undefined };
      }));
      setNote('הטקסט תוקן ומילות המפתח סומנו.');
    } catch (e: any) {
      setNote(`ה-AI לא הצליח: ${e.message}`);
    } finally { setBusy(null); }
  }

  if (!scene) return null;
  const canTranscribe = scene.kind === 'video' && scene.clipUrl.startsWith('https://');

  return (
    <Modal open={open} onClose={onClose} wide>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="font-display text-xl font-extrabold">עריכת כתוביות</h3>
        <CloseButton onClick={onClose} />
      </div>

      {scenes.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {scenes.map((s, i) => (
            <Chip key={s.index} on={i === sel} onClick={() => setSel(i)}>{s.label}{s.lines.length ? ` · ${s.lines.length}` : ''}</Chip>
          ))}
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-[260px_minmax(0,1fr)]">
        {/* ---------- preview ---------- */}
        <div>
          <div className="relative mx-auto aspect-9/16 w-full max-w-[260px] overflow-hidden rounded-xl bg-black">
            {scene.kind === 'video'
              ? <video key={scene.clipUrl} ref={video} src={`${scene.clipUrl}#t=0.1`} playsInline preload="auto" muted={Boolean(scene.narrationUrl)}
                  onLoadedMetadata={(e) => { if (!scene.narrationUrl) setDur(e.currentTarget.duration || 0); }}
                  onEnded={() => !scene.narrationUrl && setPlaying(false)}
                  className="absolute inset-0 h-full w-full object-cover" />
              : <img src={scene.clipUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            {scene.narrationUrl && (
              <audio key={scene.narrationUrl} ref={audio} src={scene.narrationUrl} preload="auto"
                onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)} onEnded={() => { setPlaying(false); video.current?.pause(); }} />
            )}
            <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" />
          </div>
          <div className="mx-auto mt-3 flex max-w-[260px] items-center gap-2">
            <Button size="sm" variant="primary" onClick={playPause} aria-label={playing ? 'עצירה' : 'ניגון'}>{playing ? '❚❚' : '▶'}</Button>
            <input type="range" min={0} max={Math.max(0.1, dur)} step={0.05} value={Math.min(t, dur || t)}
              onChange={(e) => seek(+e.target.value)} className="flex-1 accent-(--primary)" aria-label="מיקום בסרטון" />
            <span className="w-12 text-xs tabular-nums text-muted">{fmt(t)}</span>
          </div>
          <p className="mx-auto mt-2 max-w-[260px] text-xs text-muted">
            {scene.source === 'narration' ? 'הכתוביות לפי הקריינות.' : scene.source === 'edited' ? 'כתוביות ערוכות.' : 'אין עדיין כתוביות לסצנה הזו.'}
          </p>
        </div>

        {/* ---------- controls ---------- */}
        <div className="min-w-0">
          <div className="mb-4 flex gap-2">
            <Chip on={tab === 'style'} onClick={() => setTab('style')}>סגנון</Chip>
            <Chip on={tab === 'text'} onClick={() => setTab('text')}>טקסט ({lines.length})</Chip>
          </div>

          {tab === 'style' ? (
            <div className="grid gap-4">
              <div>
                <p className="mb-2 text-sm font-semibold">ערכות מוכנות</p>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <Chip key={p.id} on={style.preset === p.id} onClick={() => onStyle(presetStyle(p.id, style.y))}>{p.label}</Chip>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-semibold">גופן</p>
                <div className="flex flex-wrap gap-2">
                  {FONTS.map((f) => (
                    <button key={f.id} type="button" onClick={() => { void loadCaptionFont(f.id); setStyle({ font: f.id }); }}
                      style={{ fontFamily: `"${f.id}", sans-serif`, fontWeight: f.weight }}
                      className={cx('rounded-xl border px-3 py-1.5 text-base', style.font === f.id ? 'border-primary bg-primary-soft' : 'border-line hover:bg-surface-2')}>
                      אבג {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-semibold">הדגשת מילים בזמן הדיבור</p>
                <div className="flex flex-wrap gap-2">
                  {([['none', 'בלי'], ['word', 'המילה הנאמרת'], ['karaoke', 'קריוקי']] as const).map(([id, label]) => (
                    <Chip key={id} on={style.highlight === id} onClick={() => setStyle({ highlight: id })}>{label}</Chip>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">גודל: <strong>{style.size}</strong>
                  <input type="range" min={34} max={96} value={style.size} onChange={(e) => setStyle({ size: +e.target.value })} className="mt-1 w-full accent-(--primary)" />
                </label>
                <label className="text-sm">מיקום: <strong>{Math.round(style.y * 100)}%</strong>
                  <input type="range" min={10} max={90} value={Math.round(style.y * 100)} onChange={(e) => setStyle({ y: +e.target.value / 100 })} className="mt-1 w-full accent-(--primary)" />
                </label>
                <label className="text-sm">מילים בשורה: <strong>{style.maxWords}</strong>
                  <input type="range" min={1} max={8} value={style.maxWords} onChange={(e) => wordsPerLine(+e.target.value)} className="mt-1 w-full accent-(--primary)" />
                </label>
                <label className="text-sm">עובי מסגרת: <strong>{style.strokeWidth}</strong>
                  <input type="range" min={0} max={14} value={style.strokeWidth} onChange={(e) => setStyle({ strokeWidth: +e.target.value })} className="mt-1 w-full accent-(--primary)" />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2">טקסט <input type="color" value={style.color} onChange={(e) => setStyle({ color: e.target.value })} /></label>
                <label className="flex items-center gap-2">הדגשה <input type="color" value={style.highlightColor} onChange={(e) => setStyle({ highlightColor: e.target.value })} /></label>
                <label className="flex items-center gap-2">מסגרת <input type="color" value={style.strokeColor} onChange={(e) => setStyle({ strokeColor: e.target.value })} /></label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={style.shadow} onChange={(e) => setStyle({ shadow: e.target.checked })} className="h-4 w-4 accent-(--primary)" />צל</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={style.background === 'box'} onChange={(e) => setStyle({ background: e.target.checked ? 'box' : 'none' })} className="h-4 w-4 accent-(--primary)" />רקע לטקסט</label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Chip onClick={() => setStyle({ y: 0.2 })}>למעלה</Chip>
                <Chip onClick={() => setStyle({ y: 0.5 })}>באמצע</Chip>
                <Chip onClick={() => setStyle({ y: 0.78 })}>למטה</Chip>
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {canTranscribe && (
                  <Button size="sm" variant="ghost" onClick={() => transcribe(scene)} disabled={Boolean(busy)}>
                    {busy === `transcribe-${scene.index}` ? <><Spinner />מתמלל…</> : '🎙 תמלול הקול מהסרטון'}
                  </Button>
                )}
                {scenes.filter((s) => s.kind === 'video' && !s.narrationUrl).length > 1 && (
                  <Button size="sm" variant="ghost" onClick={transcribeAll} disabled={Boolean(busy)}>תמלול כל הסצנות</Button>
                )}
                <Button size="sm" variant="ghost" onClick={polish} disabled={Boolean(busy) || !lines.length}>
                  {busy === 'polish' ? <><Spinner />עובד…</> : '✨ תיקון AI + מילות מפתח'}
                </Button>
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={emoji} onChange={(e) => setEmoji(e.target.checked)} className="h-4 w-4 accent-(--primary)" />עם אימוג'י
                </label>
                <Button size="sm" variant="ghost" onClick={addAtPlayhead}>+ שורה ב-{fmt(t)}</Button>
                {scene.source === 'edited' && scene.narrationUrl && (
                  <Button size="sm" variant="ghost" onClick={() => onLines(scene.index, null)}>חזרה לכתוביות מהקריינות</Button>
                )}
              </div>
              {note && <p className="mb-3 text-sm text-muted">{note}</p>}

              {!lines.length ? (
                <p className="rounded-2xl bg-surface-2 p-4 text-sm text-muted">
                  {canTranscribe ? 'לחצו "תמלול הקול מהסרטון" — הכתוביות ייווצרו מהדיבור, מתוזמנות לכל מילה.' : 'צרו קריינות לסצנה, או הוסיפו שורה ידנית.'}
                </p>
              ) : (
                <div className="grid max-h-[52vh] gap-2 overflow-y-auto pe-1">
                  {lines.map((c, i) => {
                    const on = current === c;
                    return (
                      <div key={i} className={cx('rounded-2xl border p-3', on ? 'border-primary bg-primary-soft' : 'border-line')}>
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                          <button type="button" className="font-semibold text-primary" onClick={() => seek(c.start)}>▶ {fmt(c.start)}</button>
                          <Input type="number" step={0.1} value={+c.start.toFixed(2)} onChange={(e) => editTime(i, 'start', +e.target.value)} className="h-8 w-20 px-2 py-0 text-xs" aria-label="התחלה" />
                          –
                          <Input type="number" step={0.1} value={+c.end.toFixed(2)} onChange={(e) => editTime(i, 'end', +e.target.value)} className="h-8 w-20 px-2 py-0 text-xs" aria-label="סיום" />
                          <span className="ms-auto flex gap-3">
                            <button type="button" onClick={() => split(i)} className="hover:text-ink">פיצול</button>
                            <button type="button" onClick={() => merge(i)} disabled={i + 1 >= lines.length} className="hover:text-ink disabled:opacity-40">איחוד עם הבאה</button>
                            <button type="button" onClick={() => remove(i)} className="text-(--danger)">מחיקה</button>
                          </span>
                        </div>
                        <Input value={c.text} onChange={(e) => editText(i, e.target.value)} />
                        <div className="mt-2 flex flex-wrap gap-1">
                          {wordsOf(c).map((w, k) => (
                            <button key={k} type="button" onClick={() => toggleHl(i, k)} title="סימון כמילת מפתח"
                              className={cx('rounded-full px-2 py-0.5 text-xs', w.hl ? 'bg-(--warn-soft,#fff4e0) font-bold text-warn' : 'bg-surface-2 text-ink-2')}>
                              {w.hl ? '★ ' : ''}{w.text}
                            </button>
                          ))}
                          {c.emoji && <span className="px-1 text-sm">{c.emoji}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="mt-3 text-xs text-muted">לחיצה על מילה מסמנת אותה כמילת מפתח — היא תופיע בצבע ההדגשה.</p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex gap-3 border-t border-line pt-4">
        <Button variant="primary" onClick={onClose}>סיום</Button>
        <span className="self-center text-xs text-muted">השינויים נשמרים אוטומטית. הם ייכנסו לסרטון ב"יצירת הריל הסופי".</span>
      </div>
    </Modal>
  );
}
