'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { MediaService } from '@/lib/services/media.service';
import { PRICE_PER_SECOND, VideoService, type ClipUpdate } from '@/lib/services/video.service';
import { ImageService, PRICE_PER_IMAGE } from '@/lib/services/image.service';
import { imageToDataUri, lastFrameDataUri } from '@/lib/media';
import { videoErrorMessage, aiErrorMessage } from '@/lib/errors';
import { archiveAsset } from '@/lib/services/archive.service';
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
import type { CaptionCue, ReelProject, ReelScene, SceneMotion, SceneNarration, SceneSource, Storyboard } from '@/types';
import { drawGraphicCard } from '@/features/reels/graphicCard';
import { MediaPicker } from '@/features/media/MediaPicker';
import { MicButton } from '@/components/ui/MicButton';
import { setGenerationContext } from '@/lib/services/http';
import { FinalReelPanel, type RenderScenePayload } from '@/features/reels/FinalReelPanel';

type Res = keyof typeof PRICE_PER_SECOND;
type Clip = ClipUpdate & { startedAt?: number; code?: string; kind?: 'video' | 'image'; draft?: boolean; still?: string };

const LENGTHS = [10, 15, 30, 45];
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
  const { brand, media, addMedia, addContent, saveContentNow, content, voice, pronunciations } = useApp();
  type Narr = Partial<SceneNarration> & { srt?: string; busy?: boolean; error?: string; persisted?: boolean };
  const [narr, setNarr] = useState<Record<number, Narr>>({});

  const [videoReady, setVideoReady] = useState<boolean | null>(null);
  useEffect(() => { VideoService.available().then(setVideoReady); }, []);

  const [brief, setBrief] = useState('');
  const [total, setTotal] = useState(45);
  // "scenes": short mixed scenes (cheaper) · "single": one continuous AI video for the whole length
  const [shape, setShape] = useState<'scenes' | 'single'>('scenes');
  // a real photo from the library (a person, a product) every AI still is made from
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [anchorPicking, setAnchorPicking] = useState(false);
  const [res, setRes] = useState<Res>('720p');
  const [seamless, setSeamless] = useState(true);
  const [board, setBoard] = useState<Storyboard | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [photos, setPhotos] = useState<Record<number, string | null>>({});
  const [imageMode, setImageMode] = useState<Record<number, boolean>>({});
  // draft first: AI-video scenes start as stills; "final version" turns only those into video
  const [draftMode, setDraftMode] = useState(true);
  const [clips, setClips] = useState<Record<number, Clip>>({});
  const [running, setRunning] = useState(false);
  const [rethinking, setRethinking] = useState<number | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [presetVideo, setPresetVideo] = useState<string | null>(null);
  const [presetImage, setPresetImage] = useState<string | null>(null);
  const [newScriptAsk, setNewScriptAsk] = useState(false);
  const [pickTab, setPickTab] = useState<'image' | 'video'>('image');
  const [music, setMusic] = useState<ReelProject['music']>(null);
  const [captions, setCaptions] = useState<ReelProject['captions']>({ enabled: true, position: 'bottom', size: 'lg' });
  const [finalReel, setFinalReel] = useState<ReelProject['final']>(null);
  // every AI call made here is counted toward this reel's cost
  useEffect(() => { setGenerationContext(projectId); return () => setGenerationContext(null); }, [projectId]);
  const [sceneCaps, setSceneCaps] = useState<Record<number, CaptionCue[]>>({});
  const [originalAudio, setOriginalAudio] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'local' | 'no_migration' | 'error'>('idle');
  const loadedRef = useRef(false);
  const [, tick] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // arriving from the create studio with a ready brief
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const b = q.get('brief');
    if (b) setBrief(b);
    const md = q.get('media');
    if (md) setPresetVideo(md);
    const id = q.get('id');
    if (id) setProjectId(id);
    else loadedRef.current = true; // new project — nothing to load
  }, []);

  // reopen a saved reel exactly where it was left (waits for the account data to arrive)
  useEffect(() => {
    if (loadedRef.current || !projectId) return;
    const item = content.find((c) => c.id === projectId);
    if (!item) return;
    if (!item.reel) {
      // a reel from the weekly plan or the editor: open it here with its idea as the brief,
      // and the project is saved into this same item (keeps its date and time)
      loadedRef.current = true;
      setBrief([item.headline, item.caption].filter(Boolean).join('\n'));
      // the post's own image or video comes along into scene 1
      const m = item.mediaId ? useApp.getState().media.find((x) => x.id === item.mediaId) : undefined;
      if (m?.kind === 'video') setPresetVideo(m.id);
      if (m?.kind === 'image') setPresetImage(m.id);
      return;
    }
    const p = item.reel;
    loadedRef.current = true;
    setBrief(p.brief); setTotal(p.total); setRes(p.res); setSeamless(p.seamless); setBoard(p.board);
    const toMap = <T,>(arr: (T | null)[]) => Object.fromEntries(arr.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined));
    setClips(Object.fromEntries(p.clips.map((c, i) => [i, c ? { status: 'done', url: c.url, kind: c.kind, draft: c.draft, still: c.still } : null]).filter(([, v]) => v)) as Record<number, Clip>);
    setDraftMode(p.draftMode ?? false);
    setAnchorId(p.anchorId ?? null);
    setPhotos(toMap(p.photos) as Record<number, string | null>);
    setImageMode(Object.fromEntries(p.imageMode.map((v, i) => [i, v])));
    setNarr(Object.fromEntries(p.narration.map((n, i) => [i, n ? { ...n, persisted: true } : null]).filter(([, v]) => v)) as Record<number, Narr>);
    setMusic(p.music); setCaptions(p.captions); setFinalReel(p.final);
    setSceneCaps(Object.fromEntries((p.sceneCaptions ?? []).map((c, i) => [i, c]).filter(([, c]) => c)) as Record<number, CaptionCue[]>);
    setOriginalAudio(p.originalAudio !== false);
    if (p.voice?.voiceId) useApp.getState().setVoice({ voiceId: p.voice.voiceId, style: p.voice.style as any, language: p.voice.language as any });
    setSaveState('saved');
  }, [content, projectId]);

  const anyActive = Object.values(clips).some((c) => c.status === 'queued' || c.status === 'running');
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyActive]);

  const scenes = board?.scenes ?? [];
  /** what is still to pay: now (draft or direct) and for the final version */
  const costs = useMemo(() => {
    let now = 0, final = 0, videoSec = 0;
    scenes.forEach((sc, i) => {
      const src = sc.source ?? (imageMode[i] ? 'ai_image' : 'ai_video');
      const c = clips[i];
      const sec = sc.seconds || 5;
      if (src === 'ai_video') videoSec += sec;
      if (c?.status === 'done' && !c.draft) return;
      if (src === 'graphic' || src === 'user' || (src === 'ai_image' && photos[i])) return;
      if (src === 'ai_image') { now += PRICE_PER_IMAGE; return; }
      // AI video
      if (c?.draft) { final += sec * PRICE_PER_SECOND[res]; return; }
      if (draftMode) { now += PRICE_PER_IMAGE; final += sec * PRICE_PER_SECOND[res]; } else now += sec * PRICE_PER_SECOND[res];
    });
    const totalSec = scenes.reduce((a, x) => a + (x.seconds || 5), 0);
    return { now, final, videoSec, totalSec };
  }, [scenes, res, imageMode, clips, photos, draftMode]);
  const cost = costs.now;
  const doneUrls = scenes.map((_, i) => clips[i]?.url).filter(Boolean) as string[];
  const allDone = scenes.length > 0 && doneUrls.length === scenes.length;

  const setScenes = (next: ReelScene[]) => setBoard((b) => (b ? { ...b, scenes: next } : b));

  /** Reorder or remove scenes WITHOUT throwing away clips that were already paid for. */
  function remap(order: (number | null)[]) {
    const nextClips: Record<number, Clip> = {};
    const nextPhotos: Record<number, string | null> = {};
    const nextMode: Record<number, boolean> = {};
    const nextNarr: Record<number, Narr> = {};
    const nextCaps: Record<number, CaptionCue[]> = {};
    order.forEach((from, to) => {
      if (from === null) return;
      if (narr[from]) nextNarr[to] = narr[from];
      if (sceneCaps[from]) nextCaps[to] = sceneCaps[from];
      if (clips[from]) nextClips[to] = clips[from];
      if (photos[from] !== undefined) nextPhotos[to] = photos[from];
      if (imageMode[from] !== undefined) nextMode[to] = imageMode[from];
    });
    setClips(nextClips); setPhotos(nextPhotos); setImageMode(nextMode); setNarr(nextNarr); setSceneCaps(nextCaps);
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
  const clearClip = (i: number) => {
    setClips((c) => { const { [i]: _drop, ...rest } = c; return rest; });
    // captions transcribed from a clip belong to that clip
    setSceneCaps((c) => { const { [i]: _drop, ...rest } = c; return rest; });
  };
  const setSceneCaption = (i: number, lines: CaptionCue[] | null) =>
    setSceneCaps((c) => { const { [i]: _drop, ...rest } = c; return lines ? { ...rest, [i]: lines } : rest; });

  async function plan() {
    setPlanning(true); setPlanError(null); setClips({}); setPhotos({}); setNarr({}); setFinalReel(null); setSceneCaps({});
    try {
      const b = await AIService.storyboard(brand, brief, total);
      const per = Math.round(total / Math.min(10, Math.max(3, Math.round(total / 5))));
      const SOURCES: SceneSource[] = ['ai_video', 'ai_image', 'graphic'];
      const MOTIONS: SceneMotion[] = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'none'];
      const planned = b.scenes.map((sc, k) => {
        const source: SceneSource = SOURCES.includes(sc.source as SceneSource) ? sc.source! : 'ai_image';
        const motion: SceneMotion = source === 'ai_video' || source === 'graphic' ? 'none'
          : MOTIONS.includes(sc.motion as SceneMotion) && sc.motion !== 'none' ? sc.motion! : (k % 2 ? 'zoom_out' : 'zoom_in');
        const seconds = Number.isFinite(sc.seconds) && sc.seconds >= 2 && sc.seconds <= 15 ? Math.round(sc.seconds) : per;
        return { ...sc, source, motion, seconds };
      });
      if (shape === 'single') {
        // one continuous AI shot: the planned moments become one prompt, the narration one text
        const len = Math.min(30, total);
        const moments = b.scenes.map((sc) => sc.videoPrompt || sc.visual).filter(Boolean);
        const one: ReelScene = {
          role: 'hook', seconds: len, source: 'ai_video', motion: 'none',
          onScreen: b.scenes[0]?.onScreen ?? '', emoji: b.scenes[0]?.emoji,
          voiceover: b.scenes.map((sc) => sc.voiceover).filter(Boolean).join(' '),
          visual: b.scenes.map((sc) => sc.visual).filter(Boolean).join(' ← '),
          videoPrompt: `One continuous shot, no cuts, ${len} seconds. ${moments.map((m, k) => `${k === 0 ? 'It starts' : 'Then'}: ${m}`).join(' ')}`,
        } as ReelScene;
        setBoard({ ...b, scenes: [one] });
        setImageMode({ 0: false });
        setDraftMode(false);
      } else {
        setBoard({ ...b, scenes: planned });
        setImageMode(Object.fromEntries(planned.map((sc, k) => [k, sc.source !== 'ai_video'])));
        setDraftMode(true);
      }
      const v = presetVideo ? media.find((m) => m.id === presetVideo && m.kind === 'video') : undefined;
      if (v) { setClips({ 0: { status: 'done', url: v.url, kind: 'video' } as Clip }); setPresetVideo(null); }
      if (presetImage) { setPhotos({ 0: presetImage }); setPresetImage(null); }
    }
    catch (e: any) { setPlanError(aiErrorMessage(e.code)); }
    finally { setPlanning(false); }
  }

  /**
   * Narration for a video (or image) you already have — no script, no AI, no generation cost.
   * One scene with your file; the narration text starts from the brief and can be edited.
   */
  async function quickBoard() {
    const v = presetVideo ? media.find((m) => m.id === presetVideo) : undefined;
    const img = !v && presetImage ? media.find((m) => m.id === presetImage) : undefined;
    if (!v && !img) return;
    let seconds = 10;
    if (v) {
      seconds = await new Promise<number>((res) => {
        const el = document.createElement('video');
        const t = setTimeout(() => res(10), 6000);
        el.preload = 'metadata';
        el.onloadedmetadata = () => { clearTimeout(t); res(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : 10); };
        el.onerror = () => { clearTimeout(t); res(10); };
        el.src = v.url;
      });
    }
    const text = brief.trim();
    setBoard({
      title: text.split('\n')[0].slice(0, 60) || 'ריל',
      caption: text, hashtags: [],
      scenes: [{ role: 'hook', seconds, onScreen: '', voiceover: text, visual: '', videoPrompt: '' }],
    } as Storyboard);
    setNarr({}); setFinalReel(null); setPhotos({}); setSceneCaps({});
    if (v) { setClips({ 0: { status: 'done', url: v.url, kind: 'video' } as Clip }); setImageMode({}); }
    else if (img) { setClips({ 0: { status: 'done', url: img.url, kind: 'image' } as Clip }); setImageMode({ 0: true }); }
    setPresetVideo(null); setPresetImage(null);
  }

  // a video the user already has (from the library or the post) sits in scene 1 — it is never charged
  const hasExistingVideo = Boolean(presetVideo || (clips[0]?.status === 'done' && clips[0]?.kind === 'video'));
  const perScene = Math.round(total / Math.max(1, Math.round(total / 15)));
  const newVideoCost = shape === 'single'
    ? Math.max(0, Math.min(30, total) - (hasExistingVideo ? perScene : 0)) * PRICE_PER_SECOND[res]
    // scenes: about a third is AI video, the rest stills (8¢ each) and a free card
    : Math.max(0, Math.round(total * 0.35) - (hasExistingVideo ? perScene : 0)) * PRICE_PER_SECOND[res]
      + Math.max(0, Math.round(total / 5) - 2) * PRICE_PER_IMAGE;

  const photoUrl = (i: number) => {
    const id = photos[i];
    return id ? media.find((m) => m.id === id)?.url : undefined;
  };

  /** What a scene is made of (older projects: from the video / image switch). */
  const sourceOf = (i: number): SceneSource => scenes[i]?.source ?? (imageMode[i] ? 'ai_image' : 'ai_video');
  function setSource(i: number, source: SceneSource) {
    setScenes(scenes.map((s, n) => (n === i ? {
      ...s, source,
      motion: source === 'ai_video' || source === 'graphic' ? 'none' : s.motion && s.motion !== 'none' ? s.motion : 'zoom_in',
    } : s)));
    setImageMode((m) => ({ ...m, [i]: source !== 'ai_video' }));
    const c = clips[i];
    if (c?.status === 'done' && c.kind === 'image' && source !== 'graphic' && sourceOf(i) !== 'graphic') {
      // the still stays: as a moving still, or as the draft (first frame) of the AI video
      setClips((all) => ({ ...all, [i]: { ...c, draft: source === 'ai_video' ? true : undefined } }));
    } else {
      clearClip(i);
    }
  }
  /** the camera move a still shows (studio preview and final render agree) */
  const motionOf = (i: number) => {
    const m = scenes[i]?.motion;
    if (m && m !== 'none') return m;
    return clips[i]?.draft || sourceOf(i) === 'graphic' ? 'zoom_in' : null;
  };
  const setMotion = (i: number, motion: SceneMotion) => setScenes(scenes.map((s, n) => (n === i ? { ...s, motion } : s)));

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
      const base: Narr = {
        url: out.audioUrl, srt: out.srt, cues: out.cues, originalText: out.originalText, spokenText: out.spokenText,
        durationSec: out.durationSec, voiceId: voice.voiceId, style: voice.style, language: voice.language,
      };
      setNarr((n) => ({ ...n, [i]: base }));
      // the audio lives in storage, not in this tab — a refresh must not cost another narration
      try {
        const file = new File([out.audioBlob], `${board?.title || 'reel'} · קריינות ${i + 1}.mp3`, { type: out.mimeType });
        const asset = await MediaService.upload(file);
        if (asset.persistent) {
          addMedia(asset);
          setNarr((n) => ({ ...n, [i]: { ...base, url: asset.url, mediaId: asset.id, persisted: true } }));
        }
      } catch { /* stays playable in this session; the save indicator shows it is not stored */ }
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

  /**
   * The reel's look anchor: the first AI still already made. Every other AI still is generated
   * FROM it (as a reference image), so the same person, outfit and place carry through the reel.
   */
  const anchorFor = (i: number): string | undefined => {
    const chosen = anchorId ? media.find((m) => m.id === anchorId && m.kind === 'image')?.url : undefined;
    if (chosen) return chosen;
    for (let j = 0; j < scenes.length; j++) {
      if (j === i) continue;
      const c = clips[j], src = sourceOf(j);
      if ((src === 'ai_image' || src === 'ai_video') && c?.status === 'done' && !photos[j]) {
        if (c.kind === 'image' && c.url) return c.url;
        if (c.still) return c.still; // a video made from an approved still keeps that still as the anchor
      }
    }
    return undefined;
  };
  const CONSISTENT = 'Keep the exact same main person as in the reference image: same face, same hair, same skin tone, same age, same clothing. Same location style, same light and color grading. Photorealistic, natural, vertical 9:16. No text, no logos.';

  async function renderScene(i: number, startImage?: string, opts: { final?: boolean; anchor?: string } = {}): Promise<string> {
    const sc = scenes[i];
    const startedAt = Date.now();
    const set = (u: ClipUpdate) => setClips((c) => ({ ...c, [i]: { ...c[i], ...u, startedAt } }));

    const source = sourceOf(i);

    // a branded card, drawn here — no AI, no cost
    if (source === 'graphic') {
      set({ status: 'running' });
      try {
        const logo = brand.logoId ? media.find((m) => m.id === brand.logoId)?.url : undefined;
        const file = await drawGraphicCard(brand, sc.onScreen, logo);
        const asset = await MediaService.upload(file);
        if (asset.persistent) addMedia(asset);
        setClips((c) => ({ ...c, [i]: { status: 'done', url: asset.url, kind: 'image', startedAt } }));
        return asset.url;
      } catch (e: any) {
        setClips((c) => ({ ...c, [i]: { status: 'failed', error: e.message, kind: 'image', startedAt } }));
        throw e;
      }
    }

    // the user's own photo as a moving still: free
    const own = photoUrl(i);
    if (own && (source === 'ai_image' || source === 'user')) {
      setClips((c) => ({ ...c, [i]: { status: 'done', url: own, kind: 'image', startedAt } }));
      return own;
    }

    // a still image costs 8 cents instead of 50+ — enough for most scenes.
    // In draft mode an AI-video scene starts as a still too (draft: true): it becomes the first
    // frame of the video in the final version, so the look you approved is the look you get.
    const draftStill = draftMode && !opts.final && source === 'ai_video' && !own && !startImage;
    if (imageMode[i] || draftStill) {
      set({ status: 'running' });
      try {
        const anchor = opts.anchor ?? anchorFor(i);
        const base = [board?.cast, sc.videoPrompt || sc.visual].filter(Boolean).join('\n');
        const urls = await ImageService.generate({
          prompt: anchor ? `${base}\n\n${CONSISTENT}` : base, aspectRatio: '9:16', count: 1,
          ...(anchor ? { imageUrls: [anchor] } : {}),
        }, undefined, abort.current?.signal);
        setClips((c) => ({ ...c, [i]: { status: 'done', url: urls[0], kind: 'image', startedAt, draft: draftStill || undefined } }));
        void keepInLibrary(i, urls[0], 'image');
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
    // from here on this scene is a video: a draft still it replaces stops being "the clip"
    setClips((c) => ({ ...c, [i]: { status: 'queued', kind: 'video', startedAt } }));
    try {
      return await VideoService.generate({
        // nobody talks on camera: the voice is the Hebrew narration (AI speech came out in English)
        prompt: `${[board?.cast, sc.videoPrompt || sc.visual].filter(Boolean).join('. ')}. The person does not speak; no dialogue, no lip movement.`,
        duration: sc.seconds || 15,
        resolution: res,
        aspectRatio: '9:16',
        startImage,
        audio: false,
      }, (u) => { set(u); if (u.status === 'done' && u.url) void keepInLibrary(i, u.url, 'video'); }, abort.current?.signal);
    } catch (e: any) {
      setClips((c) => ({ ...c, [i]: { ...c[i], status: 'failed', error: e.message, code: e.code, startedAt } }));
      throw e;
    }
  }

  /** Every finished asset lands in the media library immediately — no manual save. */
  async function keepInLibrary(i: number, url: string, kind: 'video' | 'image') {
    const name = `${board?.title || 'reel'} · ${kind === 'video' ? 'קליפ' : 'תמונה'} ${i + 1}`;
    // copied into the account's own storage, so a provider link expiring costs nothing
    const saved = await archiveAsset(url, kind, name);
    addMedia({ id: saved.id ?? crypto.randomUUID(), url: saved.url, name, kind, persistent: Boolean(saved.id) });
    if (saved.url !== url) setClips((c) => ({ ...c, [i]: { ...c[i], url: saved.url } }));
  }

  async function renderAll(only?: number) {
    if (!scenes.length) return;
    abort.current = new AbortController();
    setRunning(true);
    try {
      if (only !== undefined) { await renderScene(only).catch(() => {}); return; }
      if (seamless && !draftMode) {
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
        // the first AI still is made alone; every other still is then made from it (same person, same place)
        let anchor = anchorFor(-1);
        const needsStill = (i: number) => !photos[i] && (sourceOf(i) === 'ai_image' || (sourceOf(i) === 'ai_video' && draftMode));
        const todo = scenes.map((_, i) => i).filter((i) => clips[i]?.status !== 'done');
        if (!anchor) {
          const first = todo.find(needsStill);
          if (first !== undefined) {
            anchor = await renderScene(first).catch(() => undefined);
            todo.splice(todo.indexOf(first), 1);
          }
        }
        await Promise.allSettled(todo.map((i) => renderScene(i, undefined, { anchor })));
      }
    } catch { /* the failing clip shows its own message */ }
    finally { setRunning(false); }
  }

  /**
   * Final version: only the AI-video scenes that are still drafts become video — each from its
   * approved still as the first frame. Everything already final is kept as is (never paid twice).
   */
  const draftScenes = scenes.map((_, i) => i).filter((i) => clips[i]?.status === 'done' && clips[i]?.draft && sourceOf(i) === 'ai_video');
  async function makeFinal() {
    if (!draftScenes.length) { setDraftMode(false); return; }
    abort.current = new AbortController();
    setRunning(true);
    setDraftMode(false);
    try {
      await Promise.allSettled(draftScenes.map(async (i) => {
        const still = clips[i]?.url;
        let start: string | undefined;
        try { start = still ? await imageToDataUri(still) : undefined; } catch { start = still; }
        try {
          const url = await renderScene(i, start ?? still, { final: true });
          if (still) setClips((c) => ({ ...c, [i]: { ...c[i], still } }));
          return url;
        }
        catch (e) {
          // the approved still stays, so nothing is lost and "final version" can be tried again
          if (still) setClips((c) => ({ ...c, [i]: { status: 'done', url: still, kind: 'image', draft: true, error: videoErrorMessage((e as any)?.message, (e as any)?.code)?.title } }));
          throw e;
        }
      }));
    } finally { setRunning(false); }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length || picking === null) return;
    const target = picking;
    try {
      const asset = await MediaService.upload(files[0]);
      addMedia(asset);
      if (asset.kind === 'video') setClips((c) => ({ ...c, [target]: { status: 'done', url: asset.url, kind: 'video' } as Clip }));
      else setPhotos((p) => ({ ...p, [target]: asset.id }));
      setPicking(null);
    } catch { /* the media screen reports upload problems */ }
  }

  /** The whole project as stored in content.reel — only permanent URLs, never blob: links. */
  const project: ReelProject | null = useMemo(() => {
    if (!board) return null;
    const perm = (u?: string) => Boolean(u && u.startsWith('https://'));
    return {
      v: 1, brief, total, res, seamless, board,
      clips: scenes.map((_, i) => (clips[i]?.status === 'done' && perm(clips[i].url)
        ? { url: clips[i].url!, kind: clips[i].kind ?? 'video', ...(clips[i].draft ? { draft: true } : {}), ...(clips[i].still && perm(clips[i].still!) ? { still: clips[i].still } : {}) } : null)),
      draftMode,
      anchorId,
      photos: scenes.map((_, i) => photos[i] ?? null),
      imageMode: scenes.map((_, i) => Boolean(imageMode[i])),
      narration: scenes.map((_, i) => {
        const n = narr[i];
        return n?.persisted && n.mediaId && perm(n.url) ? {
          mediaId: n.mediaId, url: n.url!, originalText: n.originalText ?? '', spokenText: n.spokenText ?? '',
          cues: n.cues ?? [], durationSec: n.durationSec, voiceId: n.voiceId ?? '', style: n.style ?? '', language: n.language ?? 'he',
        } : null;
      }),
      voice: { voiceId: voice.voiceId, style: voice.style, language: voice.language },
      music, captions, final: finalReel, updatedAt: Date.now(),
      sceneCaptions: scenes.map((_, i) => sceneCaps[i] ?? null),
      originalAudio,
    };
  }, [board, brief, total, res, seamless, scenes, clips, photos, imageMode, narr, voice, music, captions, finalReel, sceneCaps, originalAudio, draftMode, anchorId]);

  // autosave: every change is written to the account within a second
  const saveKey = project ? JSON.stringify({ ...project, updatedAt: 0 }) : '';
  useEffect(() => {
    if (!project || !loadedRef.current) return;
    const t = setTimeout(async () => {
      setSaveState('saving');
      const fields = {
        kind: 'reel' as const, headline: project.board.title, caption: project.board.caption || '',
        hashtags: project.board.hashtags || [],
        scenes: project.board.scenes.map((s, i) => ({ ...s, clipUrl: project.clips[i]?.url, voiceUrl: project.narration[i]?.url })),
        // what the post shows: the finished reel; before that, the first ready clip;
        // and never wipe the media the post already had
        mediaId: project.final?.mediaId
          ?? media.find((m) => m.url === project.clips[0]?.url)?.id
          ?? (projectId ? useApp.getState().content.find((c) => c.id === projectId)?.mediaId : null)
          ?? null,
        reel: project,
      };
      let id = projectId;
      if (!id) {
        const item = addContent({
          ...fields, platform: 'Instagram', goal: '', cta: brand.cta, emoji: '', palette: PALETTE.reel,
          status: 'draft', date: null, time: null,
        });
        id = item.id; setProjectId(id);
        history.replaceState(null, '', `/reels?id=${id}`);
      }
      const err = await saveContentNow(id, fields);
      const unsaved = scenes.some((_, i) => narr[i]?.url && !narr[i]?.persisted);
      setSaveState(err === 'reel_column_missing' ? 'no_migration' : err ? 'error' : !useApp.getState().userId ? 'local' : unsaved ? 'local' : 'saved');
    }, 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveKey]);

  // a narration made before the voice or style was changed
  const narrOutdated = (i: number) => {
    const n = narr[i];
    return Boolean(n?.url && ((n.voiceId && n.voiceId !== voice.voiceId) || (n.style && n.style !== voice.style)));
  };
  const outdatedCount = scenes.filter((_, i) => narrOutdated(i)).length;
  const [renarrating, setRenarrating] = useState(false);
  async function renarrateAll() {
    setRenarrating(true);
    for (let i = 0; i < scenes.length; i++) if (narrOutdated(i)) await narrateScene(i);
    setRenarrating(false);
  }

  const payload: RenderScenePayload[] = scenes.map((sc, i) => ({
    url: clips[i]?.url ?? '', kind: clips[i]?.kind ?? 'video', seconds: sc.seconds,
    // stills move (Ken Burns); a draft still of a video scene gets a gentle push-in
    motion: clips[i]?.kind === 'image' ? (sc.motion && sc.motion !== 'none' ? sc.motion : clips[i]?.draft ? 'zoom_in' : sc.source === 'graphic' ? 'zoom_in' : sc.motion) : undefined,
    narrationUrl: narr[i]?.persisted ? narr[i]?.url : undefined,
    cues: narr[i]?.persisted ? narr[i]?.cues : undefined,
    text: narr[i]?.persisted ? (narr[i]?.originalText || sc.voiceover) : undefined,
    durationSec: narr[i]?.persisted ? narr[i]?.durationSec : undefined,
    label: roleLabel(sc.role, i),
    // AI clips are silent under the narration; the user's own videos (a story, a selfie) keep their sound
    keepAudio: !(sc.source === 'ai_video' || sc.source === 'ai_image' || sc.source === 'graphic'),
  }));
  const renderReady = scenes.length > 0 && payload.every((p) => p.url.startsWith('https://'));
  const missingNarration = payload.filter((p) => !p.narrationUrl).length;

  return (
    <>
      <PageHead title="אולפן הרילס" sub="תסריט מה-AI, קליפים מ-Wan 3.0, ורצף אחד מוכן לצפייה." />

      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card>
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
            <div className="mb-3 rounded-2xl border border-[var(--ok,#16a34a)]/40 bg-[var(--ok-soft,#e8f7ee)] p-3 text-sm">
              <strong className="block">יש כבר סרטון בפרויקט — עליו לא משלמים.</strong>
              <span className="text-ink-2">
                משלמים רק על הקריינות (ElevenLabs){Math.max(1, Math.round(total / 15)) > 1 ? ' ועל הסצנות הנוספות שייווצרו' : ''}.
                הריל הסופי, הכתוביות והמוזיקה חינם.
              </span>
            </div>
          )}
          {(presetVideo || presetImage) && (
            <>
              <Button variant="primary" size="lg" className="mb-2 w-full" onClick={quickBoard} disabled={!presetVideo && !brief.trim()}>
                {presetVideo ? 'ריל מהסרטון הזה, בלי תסריט' : 'קריינות על התמונה הזו, בלי תסריט'}
              </Button>
              <p className="mb-3 text-xs text-muted">
                {presetVideo
                  ? 'מדברים בסרטון? השאירו את השדה ריק — הכתוביות ייווצרו מהדיבור. כתבתם טקסט? הוא יהיה טקסט הקריינות. בלי עלות וידאו.'
                  : 'הטקסט שכתבתם למעלה יהיה טקסט הקריינות (אפשר לערוך אחר כך). בלי AI ובלי עלות וידאו — רק הקול.'}
              </p>
            </>
          )}
          <Button variant={presetVideo || presetImage ? 'ghost' : 'primary'} size="lg" className="w-full" onClick={() => (board && (Object.keys(clips).length || Object.keys(narr).length || finalReel) ? setNewScriptAsk(true) : plan())} disabled={!aiReady || planning}>
            <Sparkle size={20} weight="fill" aria-hidden />{presetVideo || presetImage ? 'או: תסריט מלא עם כמה סצנות' : 'בניית תסריט'}
          </Button>
          {aiReady === false && <div className="mt-4"><AiUnavailable /></div>}
        </Card>

        <div className="lg:col-start-1 lg:row-start-2">
          <VoicePanel />
        </div>

        <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {planning && <GenerationState lines={['קורא את המותג…', 'מחלק לקליפים…', 'כותב כיוון ויזואלי לכל סצנה…']} step={1} />}
          {planError && <AdapterNote title="בניית התסריט נכשלה.">{planError}</AdapterNote>}
          {!planning && !board && !planError && content.some((c) => c.kind === 'reel' && c.reel) && (
            <Card className="mb-4">
              <strong className="block">פרויקטים שמורים</strong>
              <div className="mt-3 flex flex-wrap gap-2">
                {content.filter((c) => c.kind === 'reel' && c.reel).slice(0, 8).map((c) => (
                  <Chip key={c.id} onClick={() => { loadedRef.current = false; setProjectId(c.id); history.replaceState(null, '', `/reels?id=${c.id}`); }}>
                    {c.headline || 'ריל'}{c.reel?.final ? ' · מוכן' : ''}
                  </Chip>
                ))}
              </div>
            </Card>
          )}
          {!planning && !board && !planError && (
            <EmptyState icon={<FilmSlate />} title="אין עדיין תסריט"
              body="תארו את הסרטון, בחרו אורך, וה-AI יחלק אותו לסצנות קצרות — וידאו רק איפה שתנועה באמת חשובה, ותמונות בתנועה בכל השאר." />
          )}

          {board && !planning && (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-display text-xl font-bold">{board.title}</h3>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" disabled={running}
                    onClick={() => (Object.keys(clips).length || Object.keys(narr).length || finalReel ? setNewScriptAsk(true) : plan())}>
                    <ArrowsClockwise size={16} aria-hidden />תסריט חדש
                  </Button>
                  <SaveBadge state={saveState} />
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
                <SequencePlayer items={scenes.map((sc, i) => ({ c: clips[i], sc, i })).filter(({ c }) => c?.url)
                  .map(({ c, sc, i }) => ({ url: c!.url!, kind: c!.kind ?? 'video', motion: motionOf(i), seconds: sc.seconds || 5 }))} />
              )}

              {outdatedCount > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-[var(--warn-soft,#fff4e0)] p-3 text-sm">
                  <span className="flex-1">בחרתם קול או סגנון חדש. {outdatedCount} סצנות עדיין בקול הקודם.</span>
                  <Button size="sm" variant="primary" onClick={renarrateAll} disabled={renarrating}>
                    {renarrating ? <><Spinner />מקריא…</> : 'קריינות מחדש בקול החדש'}
                  </Button>
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-surface-2 p-3 text-sm">
                {anchorId && media.find((m) => m.id === anchorId)
                  ? <img src={media.find((m) => m.id === anchorId)!.url} alt="" className="h-14 w-10 rounded-lg object-cover" />
                  : <span className="flex h-14 w-10 items-center justify-center rounded-lg border border-dashed border-line text-muted">?</span>}
                <span className="min-w-0 flex-1">
                  <strong className="block">דמות / מוצר קבועים לכל הסצנות</strong>
                  <span className="text-xs text-muted">
                    {anchorId ? 'כל תמונות ה-AI בריל נוצרות מהתמונה הזו — אותו אדם, אותו מוצר.' : 'בחרו תמונה אמיתית מהספרייה (אתם, לקוח, מוצר). בלי בחירה — הסצנה הראשונה שנוצרת משמשת עוגן.'}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setAnchorPicking(true)}>{anchorId ? 'החלפה' : 'בחירה מהספרייה'}</Button>
                {anchorId && <Button size="sm" variant="ghost" onClick={() => setAnchorId(null)}>הסרה</Button>}
              </div>
              <div id="reel-scenes" className="mt-4 grid gap-3">
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
                              ? <img key={`${c.url}-${motionOf(i)}`} src={c.url} alt="" style={{ ['--kb-dur' as any]: `${sc.seconds || 5}s` }}
                                  className={cx('absolute inset-0 h-full w-full object-cover', motionOf(i) && `kb kb-${motionOf(i)}`)} />
                              : <video src={`${c.url}#t=0.5`} preload="metadata" muted playsInline className="absolute inset-0 h-full w-full object-cover" />)
                            : pUrl ? <img src={pUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                            : <span className="flex flex-col items-center gap-1 text-[11px] font-semibold"><ImageGlyph size={22} aria-hidden />תמונה</span>}
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <Pill tone="ai">{roleLabel(sc.role, i)} · {sc.seconds || 5} שנ׳{c?.draft ? ' · טיוטה' : ''}</Pill>
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
                            <div className="flex overflow-hidden rounded-full border border-line" role="radiogroup" aria-label="ממה עשויה הסצנה">
                              {([['ai_video', 'וידאו AI'], ['ai_image', 'תמונה בתנועה'], ['graphic', 'כרטיס']] as [SceneSource, string][]).map(([src, label]) => (
                                <button key={src} type="button" role="radio" aria-checked={sourceOf(i) === src} disabled={running}
                                  onClick={() => sourceOf(i) !== src && setSource(i, src)}
                                  className={cx('px-3 py-1.5 text-xs font-semibold transition-colors',
                                    sourceOf(i) === src ? 'bg-primary text-white' : 'hover:bg-surface-2')}>
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

                          {(sourceOf(i) === 'ai_image' || c?.draft) && (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <span className="text-xs text-muted">תנועת מצלמה:</span>
                              {([['zoom_in', 'התקרבות'], ['zoom_out', 'התרחקות'], ['pan_right', 'ימינה'], ['pan_left', 'שמאלה'], ['none', 'בלי']] as [SceneMotion, string][]).map(([m, label]) => (
                                <button key={m} type="button" onClick={() => setMotion(i, m)}
                                  className={cx('rounded-full px-2.5 py-1 text-xs', (sc.motion ?? 'zoom_in') === m ? 'bg-primary-soft font-bold text-ink' : 'bg-surface-2 text-ink-2')}>
                                  {label}
                                </button>
                              ))}
                            </div>
                          )}
                          {c?.draft && (
                            <p className="mt-2 text-xs text-muted">טיוטה: תמונה במקום וידאו. ב"גרסה סופית" היא תהפוך לפריים הראשון של הווידאו.</p>
                          )}
                          {c?.draft && c?.error && (
                            <p className="mt-1 text-xs text-warn">הווידאו לא נוצר ({c.error}). התמונה נשמרה — אפשר לנסות שוב בגרסה הסופית.</p>
                          )}
                          {sourceOf(i) === 'graphic' && !c?.url && (
                            <p className="mt-2 text-xs text-muted">כרטיס בצבעי המותג עם הכיתוב של הסצנה וקריאה לפעולה. בלי עלות.</p>
                          )}

                          {i > 0 && seamless && !draftMode && !photos[i] && !c?.url && sourceOf(i) === 'ai_video' && (
                            <p className="mt-2 text-xs text-muted">ימשיך מהפריים האחרון של קליפ {i}</p>
                          )}

                          {narr[i]?.url && !narr[i]?.busy && narrOutdated(i) && (
                            <p className="mt-3 text-xs text-warn">הקריינות הזו נוצרה בקול או בסגנון אחר ממה שנבחר עכשיו. לחצו "קריינות מחדש" כדי להחליף.</p>
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
                            {narr[i]?.url && !narr[i]?.persisted && !narr[i]?.busy && (
                              <p className="mt-2 text-xs text-warn">הקריינות לא נשמרה בחשבון ולא תיכנס לריל הסופי. התחברו ונסו שוב.</p>
                            )}
                            {narr[i]?.spokenText && narr[i]?.spokenText !== narr[i]?.originalText && (
                              <p className="mt-2 text-xs text-muted">נהגה כ: <span dir="rtl">{narr[i].spokenText}</span> · בכתוביות: {narr[i].originalText}</p>
                            )}
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
                    role: 'cta', seconds: 5, onScreen: 'קריאה לפעולה', voiceover: '',
                    visual: 'סצנה נוספת', videoPrompt: '', source: 'graphic', motion: 'none',
                  }])}>
                  <Plus size={18} aria-hidden />הוספת סצנה
                </Button>
              </div>

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
                    {scenes.length} סצנות · {costs.totalSec} שנ׳ · מתוכן {costs.videoSec} שנ׳ וידאו AI · {res}
                    <br />עכשיו: <strong className="text-ink">${costs.now.toFixed(2)}</strong>
                    {costs.final > 0 && <> · גרסה סופית: <strong className="text-ink">+${costs.final.toFixed(2)}</strong></>}
                  </span>
                  <div className="flex gap-2">
                    {running && (
                      <Button variant="ghost" onClick={() => { abort.current?.abort(); setRunning(false); }}>עצירה</Button>
                    )}
                    {!allDone && (
                      <Button variant="primary" onClick={() => renderAll()} disabled={!videoReady || running}>
                        {running ? <><Spinner />יוצר…</> : <><Play size={18} weight="fill" aria-hidden />{draftMode ? 'יצירת טיוטה' : 'יצירת הסרטון'}</>}
                      </Button>
                    )}
                    {allDone && draftScenes.length > 0 && (
                      <Button variant="primary" onClick={makeFinal} disabled={!videoReady || running}>
                        {running ? <><Spinner />יוצר וידאו…</> : <><Sparkle size={18} weight="fill" aria-hidden />גרסה סופית · {draftScenes.length} סצנות וידאו</>}
                      </Button>
                    )}
                    {allDone && !draftScenes.length && (
                      <Button variant="primary" disabled><Check size={18} aria-hidden />הכול מוכן</Button>
                    )}
                  </div>
                </div>
              </Card>

              <FinalReelPanel projectId={projectId} title={board.title} brief={brief}
                payload={payload} ready={renderReady} missingNarration={missingNarration}
                music={music} setMusic={setMusic} captions={captions} setCaptions={setCaptions}
                sceneCaptions={scenes.map((_, i) => sceneCaps[i] ?? null)} setSceneCaption={setSceneCaption}
                originalAudio={originalAudio} setOriginalAudio={setOriginalAudio}
                social={{ caption: board.caption || '', hashtags: board.hashtags || [] }}
                setSocial={(v) => setBoard((b) => (b ? { ...b, caption: v.caption, hashtags: v.hashtags } : b))}
                final={finalReel} onRendered={(f) => setFinalReel(f)} />

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
              <MicButton className="mt-2" label="הכתבה בקול"
                onText={(t) => { const i = editing; setScenes(scenes.map((s, n) => (n === i ? { ...s, voiceover: s.voiceover?.trim() ? `${s.voiceover.trim()} ${t}` : t } : s))); }} />
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

      <Modal open={newScriptAsk} onClose={() => setNewScriptAsk(false)}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-xl font-bold">תסריט חדש</h3>
          <CloseButton onClick={() => setNewScriptAsk(false)} />
        </div>
        <p className="mb-5 text-sm text-muted">בפרויקט הזה כבר יש קליפים וקריינות. הקבצים עצמם שמורים בספריית המדיה בכל מקרה.</p>
        <div className="grid gap-3">
          <Button variant="primary" onClick={() => {
            // a fresh project; the current one stays saved exactly as it is
            setNewScriptAsk(false);
            setProjectId(null); loadedRef.current = true;
            history.replaceState(null, '', '/reels');
            setMusic(null); setFinalReel(null);
            plan();
          }}>פרויקט חדש (הנוכחי נשמר)</Button>
          <Button variant="ghost" onClick={() => { setNewScriptAsk(false); plan(); }}>
            החלפת התסריט בפרויקט הזה
          </Button>
        </div>
      </Modal>

      {/* ---------- photo picker, with upload built in ---------- */}
      <MediaPicker open={anchorPicking} onClose={() => setAnchorPicking(false)} accept="visual"
        onPick={(id) => {
          // the anchor must be a photo (the image model takes stills as reference)
          if (media.find((m) => m.id === id)?.kind === 'image') setAnchorId(id);
          setAnchorPicking(false);
        }} selectedId={anchorId} />
      <Modal open={picking !== null} onClose={() => setPicking(null)} wide>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-xl font-bold">מדיה לקליפ {(picking ?? 0) + 1}</h3>
          <CloseButton onClick={() => setPicking(null)} />
        </div>
        <div className="mb-4 flex gap-2">
          <Chip on={pickTab === 'image'} onClick={() => setPickTab('image')}>
            תמונות ({media.filter((m) => m.kind === 'image').length})
          </Chip>
          <Chip on={pickTab === 'video'} onClick={() => setPickTab('video')}>
            סרטונים ({media.filter((m) => m.kind === 'video').length})
          </Chip>
        </div>
        <input ref={fileInput} type="file" accept={pickTab === 'video' ? 'video/*' : 'image/*'} hidden onChange={(e) => onFiles(e.target.files)} />
        <Button variant="ghost" className="mb-4 w-full" onClick={() => fileInput.current?.click()}>
          <UploadSimple size={18} aria-hidden />{pickTab === 'video' ? 'העלאת סרטון מהמחשב' : 'העלאת תמונה מהמחשב'}
        </Button>
        <p className="mb-3 text-xs text-muted">
          {pickTab === 'video'
            ? 'סרטון שנבחר ישובץ כקליפ של הסצנה כמו שהוא — בלי לייצר מחדש ובלי עלות.'
            : 'תמונה שנבחרה תשמש כפריים הפתיחה של הקליפ שייווצר.'}
        </p>
        {media.filter((m) => m.kind === pickTab).length ? (
          <div className="grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
            {media.filter((m) => m.kind === pickTab).map((m) => (
              <button key={m.id} type="button"
                onClick={() => {
                  if (pickTab === 'video') {
                    setClips((c) => ({ ...c, [picking!]: { status: 'done', url: m.url, kind: 'video' } as Clip }));
                  } else setPhotos((p) => ({ ...p, [picking!]: m.id }));
                  setPicking(null);
                }}
                className={cx('overflow-hidden rounded-xl text-start ring-2 ring-offset-2 ring-offset-surface',
                  (pickTab === 'image' ? photos[picking ?? -1] === m.id : clips[picking ?? -1]?.url === m.url) ? 'ring-primary' : 'ring-transparent hover:ring-line')}>
                {m.kind === 'video'
                  ? <video src={`${m.url}#t=1`} preload="metadata" muted playsInline className="aspect-[9/16] w-full bg-black object-cover" />
                  : <img src={m.url} alt={m.name} className="aspect-square w-full object-cover" />}
                <p className="truncate bg-surface-2 px-2 py-1 text-[11px]" title={m.name}>{m.name}</p>
              </button>
            ))}
          </div>
        ) : (
          <p className="rounded-2xl bg-surface-2 p-4 text-sm text-muted">
            {pickTab === 'video' ? 'אין עדיין סרטונים בספרייה.' : 'אין עדיין תמונות בספרייה. העלו אחת מכאן, או השאירו בלי תמונה והמנוע ייצר את הסצנה מאפס.'}
          </p>
        )}
        {picking !== null && photos[picking] && pickTab === 'image' && (
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
function SequencePlayer({ items }: { items: { url: string; kind: 'video' | 'image'; motion?: string | null; seconds?: number }[] }) {
  const [i, setI] = useState(0);
  useEffect(() => { if (i >= items.length) setI(0); }, [items.length, i]);
  // stills hold the screen for four seconds, the way they will in the finished reel
  useEffect(() => {
    if (items[i]?.kind !== 'image') return;
    const t = setTimeout(() => setI((n) => (n + 1 < items.length ? n + 1 : n)), (items[i]?.seconds || 4) * 1000);
    return () => clearTimeout(t);
  }, [i, items]);

  const cur = items[i];
  if (!cur) return null;
  return (
    <Card className="p-3">
      <div className="mx-auto w-full max-w-[300px]">
        {cur.kind === 'image'
          ? <div className="aspect-[9/16] w-full overflow-hidden rounded-xl bg-black">
              <img key={`${i}-${cur.url}`} src={cur.url} alt="" style={{ ['--kb-dur' as any]: `${cur.seconds || 4}s` }}
                className={cx('h-full w-full object-cover', cur.motion && `kb kb-${cur.motion}`)} />
            </div>
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

function SaveBadge({ state }: { state: 'idle' | 'saving' | 'saved' | 'local' | 'no_migration' | 'error' }) {
  if (state === 'idle') return null;
  if (state === 'saving') return <Pill><Spinner />שומר…</Pill>;
  if (state === 'saved') return <Pill tone="ok"><Check size={13} weight="bold" aria-hidden />נשמר בחשבון</Pill>;
  if (state === 'no_migration') return <Pill tone="warn">הפרויקט לא נשמר — צריך להריץ את המיגרציה ב-Supabase</Pill>;
  if (state === 'local') return <Pill tone="warn">חלק מהקבצים לא נשמרו בחשבון</Pill>;
  return <Pill tone="warn">השמירה נכשלה</Pill>;
}
