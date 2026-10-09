'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { MediaService } from '@/lib/services/media.service';
import { VideoService, type ClipUpdate } from '@/lib/services/video.service';
import { ImageService } from '@/lib/services/image.service';
import { imageToDataUri, lastFrameDataUri } from '@/lib/media';
import { videoErrorMessage, aiErrorMessage } from '@/lib/errors';
import { archiveAsset } from '@/lib/services/archive.service';
import { VoiceService } from '@/lib/services/voice.service';
import { VoicePanel, voiceErrorText } from '@/features/reels/VoicePanel';
import { useAiReady } from '@/hooks/useAiReady';
import { Button, Card, Chip, PageHead } from '@/components/ui/primitives';
import { AdapterNote, EmptyState, GenerationState, Spinner } from '@/components/ui/feedback';
import { FilmSlate, ArrowsClockwise, Plus, PaperPlaneTilt } from '@/components/ui/Icon';
import { PALETTE, cx } from '@/lib/utils';
import type { CaptionCue, ReelProject, ReelScene, SceneMotion, SceneSource, Storyboard } from '@/types';
import { drawGraphicCard } from '@/features/reels/graphicCard';
import { MediaPicker } from '@/features/media/MediaPicker';
import { SCENE_ANGLES } from '@/lib/services/prompts';
import { setGenerationContext } from '@/lib/services/http';
import { FinalReelPanel, type RenderScenePayload } from '@/features/reels/FinalReelPanel';
import { SaveBadge, SequencePlayer, type Clip, type Res } from '@/features/reels/studio/parts';
import { reelCosts, stepStatus, wizardSteps } from '@/features/reels/studio/logic';
import { ReelStepper } from '@/features/reels/studio/ReelStepper';
import { SceneCard } from '@/features/reels/studio/SceneCard';
import { ScriptStep } from '@/features/reels/studio/ScriptStep';
import { RenderOptions } from '@/features/reels/studio/RenderOptions';
import { SceneEditor } from '@/features/reels/studio/SceneEditor';
import { NewScriptDialog } from '@/features/reels/studio/NewScriptDialog';
import { SceneMediaPicker } from '@/features/reels/studio/SceneMediaPicker';
import {
  estimateVideoCost, motionOf as motionAt, narrationOutdated, planBoard, projectOf, remapScenes, removeScene as removeAt, renderPayload,
  restoreScenes, sourceOf as sourceAt, swapScenes as swapAt, NEW_SCENE, type Narr,
} from '@/features/reels/studio/scenes';


export default function ReelsPage() {
  const aiReady = useAiReady();
  const { brand, media, addMedia, addContent, saveContentNow, content, voice, pronunciations } = useApp();
  const [narr, setNarr] = useState<Record<number, Narr>>({});

  const [videoReady, setVideoReady] = useState<boolean | null>(null);
  useEffect(() => { VideoService.available().then(setVideoReady); }, []);

  const [brief, setBrief] = useState('');
  const [total, setTotal] = useState(45);
  // "scenes": short mixed scenes (cheaper) · "single": one continuous AI video for the whole length
  const [shape, setShape] = useState<'scenes' | 'single'>('scenes');
  // the wizard: ① script ② video ③ narration ④ final reel ⑤ publish — one step on screen at a time
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  // false: no narration — the reel is music + each scene's on-screen text (step 3 is skipped)
  const [withNarration, setWithNarration] = useState(true);
  // AI ideas for "what is the video about?", from the brand profile
  const [ideas, setIdeas] = useState<{ title: string; format: string; hook: string; brief: string; why: string }[]>([]);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [ideasError, setIdeasError] = useState<string | null>(null);
  const shownIdeas = useRef<string[]>([]);
  // every direction already tried per scene, so "another scene" never comes back to one of them
  const sceneTries = useRef<Record<number, string[]>>({});
  // scripts already built for this topic, so "new script" is really new
  const pastScripts = useRef<string[]>([]);
  const autoStepFor = useRef<string | null>(null);
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
    const saved = restoreScenes(p);
    setClips(saved.clips);
    setDraftMode(p.draftMode ?? false);
    setAnchorId(p.anchorId ?? null);
    // clips that were still being made when the page closed: follow them to the end (already paid for)
    const pending = (p.pendingClips ?? []).filter((j) => Date.now() - j.startedAt < 60 * 60_000 && !p.clips[j.scene]);
    for (const j of pending) {
      setClips((c) => ({ ...c, [j.scene]: { status: 'running', kind: 'video', requestId: j.requestId, model: j.model, startedAt: j.startedAt } }));
      VideoService.resume({ requestId: j.requestId, model: j.model }, j.seconds,
        (u) => {
          setClips((c) => ({ ...c, [j.scene]: { ...c[j.scene], ...u, kind: 'video' } }));
          if (u.status === 'done' && u.url) void keepInLibrary(j.scene, u.url, 'video');
        }).catch((e) => setClips((c) => ({ ...c, [j.scene]: { ...c[j.scene], status: 'failed', error: e?.message } })));
    }
    setWithNarration(p.withNarration !== false);
    setPhotos(saved.photos);
    setImageMode(saved.imageMode);
    setNarr(saved.narr);
    setMusic(p.music); setCaptions(p.captions); setFinalReel(p.final);
    setSceneCaps(saved.sceneCaps);
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
  const costs = useMemo(() => reelCosts({ scenes, clips, imageMode, photos, draftMode, res }), [scenes, res, imageMode, clips, photos, draftMode]);
  const cost = costs.now;
  const doneUrls = scenes.map((_, i) => clips[i]?.url).filter(Boolean) as string[];
  const allDone = scenes.length > 0 && doneUrls.length === scenes.length;

  const setScenes = (next: ReelScene[]) => setBoard((b) => (b ? { ...b, scenes: next } : b));

  /** Reorder or remove scenes WITHOUT throwing away clips that were already paid for. */
  function remap(order: (number | null)[]) {
    const m = remapScenes({ clips, photos, imageMode, narr, sceneCaps }, order);
    setClips(m.clips); setPhotos(m.photos); setImageMode(m.imageMode); setNarr(m.narr); setSceneCaps(m.sceneCaps);
  }
  function swapScenes(i: number, j: number) {
    const r = swapAt(scenes, i, j);
    setScenes(r.scenes); remap(r.order);
  }
  function removeScene(i: number) {
    const r = removeAt(scenes, i);
    setScenes(r.scenes); remap(r.order);
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
      if (board) pastScripts.current = [`${board.title}: ${board.scenes.map((x) => x.onScreen).filter(Boolean).join(' / ')}`, ...pastScripts.current].slice(0, 5);
      const b = await AIService.storyboard(brand, brief, total, pastScripts.current);
      const planned = planBoard(b, total, shape);
      setBoard(planned.board);
      setImageMode(planned.imageMode);
      setDraftMode(planned.draftMode);
      autoStepFor.current = null; // the new script opens on step 2
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
  const newVideoCost = estimateVideoCost({ shape, total, res, hasExistingVideo });

  const photoUrl = (i: number) => {
    const id = photos[i];
    return id ? media.find((m) => m.id === id)?.url : undefined;
  };

  /** What a scene is made of (older projects: from the video / image switch). */
  const sourceOf = (i: number): SceneSource => sourceAt(scenes, imageMode, i);
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
  const motionOf = (i: number) => motionAt(scenes, imageMode, clips, i);
  const setMotion = (i: number, motion: SceneMotion) => setScenes(scenes.map((s, n) => (n === i ? { ...s, motion } : s)));

  async function getIdeas(more = false) {
    setIdeasBusy(true); setIdeasError(null);
    try {
      const recent = content.filter((c) => c.headline).slice(0, 15).map((c) => c.headline as string);
      const r = await AIService.ideas(brand, { recent, avoid: more ? shownIdeas.current : [] });
      const list = (r.ideas ?? []).filter((x) => x?.brief);
      shownIdeas.current = [...list.map((x) => x.title), ...(more ? shownIdeas.current : [])].slice(0, 30);
      setIdeas(list);
    } catch (e: any) { setIdeasError(aiErrorMessage(e.code)); }
    finally { setIdeasBusy(false); }
  }

  /** Ask the model for a different visual direction for one clip. */
  async function rethinkScene(i: number) {
    const sc = scenes[i];
    setRethinking(i);
    try {
      const tried = [sc.videoPrompt || sc.visual || '', ...(sceneTries.current[i] ?? [])].filter(Boolean);
      const angle = SCENE_ANGLES[(tried.length + Math.floor(Math.random() * SCENE_ANGLES.length)) % SCENE_ANGLES.length];
      const idea = await AIService.sceneIdea(brand, sc.role || '', sc.onScreen || '', tried.slice(0, 6).map((t, k) => `${k + 1}. ${t}`).join('\n'),
        { voiceover: sc.voiceover, cast: board?.cast, angle });
      sceneTries.current[i] = tried.slice(0, 8);
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
      setNarr((n) => ({ ...n, [i]: { error: voiceErrorText(e.code, e.message) } }));
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
    // re-rendering a scene that already had a result: ask for a fresh take, not a near-copy
    const vary = clips[i]?.url && !opts.final
      ? ` Fresh take, different from the previous version: ${SCENE_ANGLES[Math.floor(Math.random() * SCENE_ANGLES.length)]}.` : '';

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
        const base = [board?.cast, sc.videoPrompt || sc.visual].filter(Boolean).join('\n') + vary;
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
        prompt: `${[board?.cast, sc.videoPrompt || sc.visual].filter(Boolean).join('. ')}. The person does not speak; no dialogue, no lip movement.${vary}`,
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
  const project: ReelProject | null = useMemo(() => projectOf({
    brief, total, res, seamless, board, draftMode, anchorId, withNarration, voice, music, captions, finalReel, originalAudio,
    clips, photos, imageMode, narr, sceneCaps,
  }), [board, brief, total, res, seamless, clips, photos, imageMode, narr, voice, music, captions, finalReel, sceneCaps, originalAudio, draftMode, anchorId, withNarration]);

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
  const narrOutdated = (i: number) => narrationOutdated(narr[i], scenes[i], voice);
  const outdatedCount = scenes.filter((_, i) => narrOutdated(i)).length;
  const [renarrating, setRenarrating] = useState(false);
  async function renarrateAll() {
    setRenarrating(true);
    for (let i = 0; i < scenes.length; i++) if (narrOutdated(i)) await narrateScene(i);
    setRenarrating(false);
  }

  const payload: RenderScenePayload[] = renderPayload(scenes, clips, narr, withNarration);
  const renderReady = scenes.length > 0 && payload.every((p) => p.url.startsWith('https://'));

  // ---- wizard status: a step is done when what it makes exists
  const { done: stepDone, firstOpen } = stepStatus({
    hasBoard: Boolean(board), scenes, clips, narr, withNarration, hasFinal: Boolean(finalReel),
  });
  // opening a saved reel (or a new script) lands on the first step that still needs work
  useEffect(() => {
    const key = board ? `${projectId ?? 'new'}:${board.title}` : null;
    if (!key || autoStepFor.current === key) return;
    autoStepFor.current = key;
    setStep(firstOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, projectId]);
  const STEPS = wizardSteps(withNarration);
  // a step opens once everything before it is done (steps already done stay open for changes)
  const canOpen = (n: number) => n <= firstOpen;
  const missingVoice = scenes.map((_, i) => i).filter((i) => scenes[i].voiceover?.trim() && !narr[i]?.url && !narr[i]?.busy);
  async function narrateMissing() { for (const i of missingVoice) await narrateScene(i); }
  const missingNarration = payload.filter((p) => !p.narrationUrl).length;

  return (
    <>
      <PageHead title="אולפן הרילס" sub="חמישה שלבים, אחד אחרי השני — המסך מראה רק את השלב שבו אתם נמצאים." />

      {/* ---------- the wizard: where you are, what is done, what comes next ---------- */}
      <ReelStepper steps={STEPS} step={step} done={stepDone} canOpen={canOpen} onSelect={setStep} />

      <div className={cx('grid items-start gap-6', (step === 1 || (step === 3 && withNarration)) && 'lg:grid-cols-[340px_minmax(0,1fr)]')}>
        {step === 1 && (
          <ScriptStep brief={brief} setBrief={setBrief} ideas={ideas} ideasBusy={ideasBusy} ideasError={ideasError}
            onIdeas={() => getIdeas(ideas.length > 0)} onIdea={(b) => { setBrief(b); setIdeas([]); }}
            presetImage={presetImage} presetVideo={presetVideo} shape={shape} setShape={setShape} total={total} setTotal={setTotal}
            withNarration={withNarration} setWithNarration={setWithNarration} res={res} setRes={setRes}
            newVideoCost={newVideoCost} hasExistingVideo={hasExistingVideo} aiReady={aiReady} planning={planning}
            onQuick={quickBoard} onStart={() => (board && (Object.keys(clips).length || Object.keys(narr).length || finalReel) ? setNewScriptAsk(true) : plan())} />
        )}

        {step === 3 && withNarration && (
          <div>
            <VoicePanel />
          </div>
        )}

        <div className={cx('min-w-0', (step === 1 || (step === 3 && withNarration)) && 'lg:col-start-2 lg:row-start-1')}>
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

              {step === 2 && videoReady === false && (
                <div className="mb-4">
                  <AdapterNote title="מנוע הווידאו לא מוגדר.">
                    הוסיפו <code>FAL_KEY</code> במשתני הסביבה של Vercel ובצעו פריסה מחדש. עד אז אפשר לבנות ולערוך תסריט, אבל לא לרנדר.
                  </AdapterNote>
                </div>
              )}

              {(step === 2 || step === 3) && doneUrls.length > 0 && (
                <SequencePlayer items={scenes.map((sc, i) => ({ c: clips[i], sc, i })).filter(({ c }) => c?.url)
                  .map(({ c, sc, i }) => ({ url: c!.url!, kind: c!.kind ?? 'video', motion: motionOf(i), seconds: sc.seconds || 5 }))} />
              )}

              {step === 3 && !withNarration && (
                <Card className="mt-4">
                  <strong className="block">הסרטון בלי קריינות</strong>
                  <p className="mt-1 text-sm text-muted">על המסך יופיע הכיתוב של כל סצנה (אפשר לערוך אותו ב"עריכה" בשלב התסריט), ובשלב הבא בוחרים מוזיקת רקע.</p>
                  <Button size="sm" variant="ghost" className="mt-3" onClick={() => setWithNarration(true)}>בכל זאת להוסיף קריינות</Button>
                </Card>
              )}
              {step === 3 && withNarration && (
                <Card className="mt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-sm">
                      {missingVoice.length ? `${missingVoice.length} סצנות עוד בלי קריינות.` : 'לכל הסצנות יש קריינות.'}
                    </span>
                    {missingVoice.length > 0 && (
                      <Button variant="ghost" onClick={() => setWithNarration(false)}>דילוג — בלי קריינות (מוזיקה וכיתוב)</Button>
                    )}
                    {missingVoice.length > 0 && (
                      <Button variant="primary" onClick={narrateMissing} disabled={scenes.some((_, i) => narr[i]?.busy)}>
                        {scenes.some((_, i) => narr[i]?.busy) ? <><Spinner />מקריא…</> : <><PaperPlaneTilt size={18} aria-hidden />קריינות לכל הסצנות</>}
                      </Button>
                    )}
                  </div>
                </Card>
              )}
              {step === 3 && outdatedCount > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-[var(--warn-soft,#fff4e0)] p-3 text-sm">
                  <span className="flex-1">{outdatedCount} סצנות עם קריינות ישנה (טקסט, קול או סגנון השתנו).</span>
                  <Button size="sm" variant="primary" onClick={renarrateAll} disabled={renarrating}>
                    {renarrating ? <><Spinner />מקריא…</> : 'קריינות מחדש בקול החדש'}
                  </Button>
                </div>
              )}
              {step === 2 && (<div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-surface-2 p-3 text-sm">
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
              </div>)}
              {(step <= 2 || (step === 3 && withNarration)) && (<div id="reel-scenes" className="mt-4 grid gap-3">
                {scenes.map((sc, i) => (
                  <SceneCard key={i} sc={sc} i={i} c={clips[i]} pUrl={photoUrl(i)} n={narr[i]} step={step} count={scenes.length}
                    source={sourceOf(i)} motion={motionOf(i)} outdated={narrOutdated(i)} hasPhoto={Boolean(photos[i])}
                    running={running} rethinking={rethinking} aiReady={aiReady} videoReady={videoReady} seamless={seamless} draftMode={draftMode}
                    onPick={() => setPicking(i)} onSource={(src) => setSource(i, src)} onEdit={() => setEditing(i)} onRethink={() => rethinkScene(i)}
                    onRender={() => renderAll(i)} onMove={(by) => swapScenes(i, i + by)} onRemove={() => removeScene(i)}
                    onMotion={(m) => setMotion(i, m)} onNarrate={() => narrateScene(i)} onSrt={() => downloadText(`clip-${i + 1}.srt`, narr[i]?.srt || '')} />
                ))}

                {step !== 3 && <Button variant="ghost" className="w-full" disabled={running}
                  onClick={() => setScenes([...scenes, { ...NEW_SCENE }])}>
                  <Plus size={18} aria-hidden />הוספת סצנה
                </Button>}
              </div>)}

              {step === 2 && (
                <RenderOptions draftMode={draftMode} setDraftMode={setDraftMode} seamless={seamless} setSeamless={setSeamless} running={running}
                  count={scenes.length} costs={costs} res={res} allDone={allDone} draftScenes={draftScenes} videoReady={videoReady}
                  onStop={() => { abort.current?.abort(); setRunning(false); }} onCreate={() => renderAll()} onFinal={makeFinal} />
              )}

              {(step === 4 || step === 5) && <FinalReelPanel section={step === 4 ? 'render' : 'publish'} textOnly={!withNarration} projectId={projectId} title={board.title} brief={brief}
                payload={payload} ready={renderReady} missingNarration={withNarration ? missingNarration : 0}
                music={music} setMusic={setMusic} captions={captions} setCaptions={setCaptions}
                sceneCaptions={scenes.map((_, i) => sceneCaps[i] ?? null)} setSceneCaption={setSceneCaption}
                originalAudio={originalAudio} setOriginalAudio={setOriginalAudio}
                social={{ caption: board.caption || '', hashtags: board.hashtags || [] }}
                setSocial={(v) => setBoard((b) => (b ? { ...b, caption: v.caption, hashtags: v.hashtags } : b))}
                final={finalReel} onRendered={(f) => setFinalReel(f)} />}

              {/* ---------- back / next ---------- */}
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                {step > 1 ? <Button variant="ghost" onClick={() => setStep((step - 1) as 1 | 2 | 3 | 4)}>→ חזרה ל{STEPS[step - 2].label}</Button> : <span />}
                {step < 5 && (stepDone[step]
                  ? <Button variant="primary" onClick={() => setStep((step + 1) as 2 | 3 | 4 | 5)}>הבא: {STEPS[step].label} ←</Button>
                  : step === 3
                    ? <Button variant="ghost" onClick={() => { setWithNarration(false); setStep(4); }}>בלי קריינות — הבא: ריל סופי ←</Button>
                    : <span className="text-sm text-muted">{STEPS[step - 1].hint}</span>)}
              </div>

              {step === 4 && <p className="mt-3 text-xs text-muted">
                הכיתובים והקריינות בעברית מתווספים בשלב החיבור לקובץ אחד — מודלי וידאו לא כותבים עברית באופן אמין, ולכן הם לא מתבקשים לכתוב טקסט בתוך התמונה.
              </p>}
            </>
          )}
        </div>
      </div>

      {/* ---------- scene editor ---------- */}
      <SceneEditor editing={editing} scenes={scenes} setScenes={setScenes} onClose={() => setEditing(null)} />

      <NewScriptDialog open={newScriptAsk} onClose={() => setNewScriptAsk(false)}
        onFresh={() => {
          // a fresh project; the current one stays saved exactly as it is
          setNewScriptAsk(false);
          setProjectId(null); loadedRef.current = true;
          history.replaceState(null, '', '/reels');
          setMusic(null); setFinalReel(null);
          plan();
        }}
        onReplace={() => { setNewScriptAsk(false); plan(); }} />

      {/* ---------- photo picker, with upload built in ---------- */}
      <MediaPicker open={anchorPicking} onClose={() => setAnchorPicking(false)} accept="visual"
        onPick={(id) => {
          // the anchor must be a photo (the image model takes stills as reference)
          if (media.find((m) => m.id === id)?.kind === 'image') setAnchorId(id);
          setAnchorPicking(false);
        }} selectedId={anchorId} />
      <SceneMediaPicker picking={picking} media={media} photoId={picking !== null ? photos[picking] : undefined} clipUrl={picking !== null ? clips[picking]?.url : undefined}
        onClose={() => setPicking(null)} onFiles={onFiles}
        onVideo={(url) => { setClips((c) => ({ ...c, [picking!]: { status: 'done', url, kind: 'video' } as Clip })); setPicking(null); }}
        onPhoto={(id) => { setPhotos((p) => ({ ...p, [picking!]: id })); setPicking(null); }} />
    </>
  );
}
