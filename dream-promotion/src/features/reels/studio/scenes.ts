import { PRICE_PER_SECOND } from '@/lib/services/video.service';
import { PRICE_PER_IMAGE } from '@/lib/services/image.service';
import { reelPlan } from '@/lib/services/prompts';
import type { CaptionCue, ReelProject, ReelScene, SceneMotion, SceneNarration, SceneSource, Storyboard } from '@/types';
import type { RenderScenePayload } from '@/features/reels/FinalReelPanel';
import { roleLabel, type Clip, type Res } from './parts';

/**
 * Reel studio — the scenes and the project, as pure functions (no React, no network): moved out of
 * app/(app)/reels/page.tsx without changing what they do (2.75), so each can be tested on its own
 * (tests/reel-scenes.test.ts). The page keeps the state and calls these.
 */

/** a scene's narration as the page keeps it (busy / error while it is made; persisted once it is in the account) */
export type Narr = Partial<SceneNarration> & { srt?: string; busy?: boolean; error?: string; persisted?: boolean };

/** everything the page keeps per scene, by the scene's place */
export interface SceneMaps {
  clips: Record<number, Clip>;
  photos: Record<number, string | null>;
  imageMode: Record<number, boolean>;
  narr: Record<number, Narr>;
  sceneCaps: Record<number, CaptionCue[]>;
}

/** Reorder or remove scenes WITHOUT throwing away clips that were already paid for: `order[to] = from` (null: a new scene). */
export function remapScenes(m: SceneMaps, order: (number | null)[]): SceneMaps {
  const out: SceneMaps = { clips: {}, photos: {}, imageMode: {}, narr: {}, sceneCaps: {} };
  order.forEach((from, to) => {
    if (from === null) return;
    if (m.narr[from]) out.narr[to] = m.narr[from];
    if (m.sceneCaps[from]) out.sceneCaps[to] = m.sceneCaps[from];
    if (m.clips[from]) out.clips[to] = m.clips[from];
    if (m.photos[from] !== undefined) out.photos[to] = m.photos[from];
    if (m.imageMode[from] !== undefined) out.imageMode[to] = m.imageMode[from];
  });
  return out;
}
/** two scenes change places: the scenes, and the order to remap what each one has */
export function swapScenes(scenes: ReelScene[], i: number, j: number): { scenes: ReelScene[]; order: number[] } {
  const next = [...scenes];
  [next[i], next[j]] = [next[j], next[i]];
  return { scenes: next, order: scenes.map((_, n) => (n === i ? j : n === j ? i : n)) };
}
/** one scene out: the scenes left, and the order to remap what each one has */
export function removeScene(scenes: ReelScene[], i: number): { scenes: ReelScene[]; order: number[] } {
  return { scenes: scenes.filter((_, n) => n !== i), order: scenes.map((_, n) => n).filter((n) => n !== i) };
}
/** the scene "הוספת סצנה" adds: a card with a call to action, free */
export const NEW_SCENE: ReelScene = {
  role: 'cta', seconds: 5, onScreen: 'קריאה לפעולה', voiceover: '',
  visual: 'סצנה נוספת', videoPrompt: '', source: 'graphic', motion: 'none',
} as ReelScene;

/**
 * The model's storyboard, made safe to show: a known source and camera move per scene, sensible lengths — or, for one
 * continuous AI shot ("single"), the planned moments as one prompt and one narration.
 */
export function planBoard(b: Storyboard, total: number, shape: 'scenes' | 'single'): { board: Storyboard; imageMode: Record<number, boolean>; draftMode: boolean } {
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
    return { board: { ...b, scenes: [one] }, imageMode: { 0: false }, draftMode: false };
  }
  return { board: { ...b, scenes: planned }, imageMode: Object.fromEntries(planned.map((sc, k) => [k, sc.source !== 'ai_video'])), draftMode: true };
}

/**
 * what the video will cost, roughly, before there is a script ("עלות וידאו משוערת") — a video already there is free.
 * Scenes: the plan the storyboard is asked for (reelPlan) — its AI-video seconds, in clips of about 5 seconds; the last
 * scene a free card; every other scene a still (8¢ each). A 10-second reel = 3 scenes: one clip, one still, the card.
 */
export function estimateVideoCost(o: { shape: 'scenes' | 'single'; total: number; res: Res; hasExistingVideo: boolean }): number {
  const plan = reelPlan(o.total);
  if (o.shape === 'single') return Math.max(0, Math.min(30, o.total) - (o.hasExistingVideo ? plan.per : 0)) * PRICE_PER_SECOND[o.res];
  const clips = Math.max(1, Math.round(plan.videoBudget / 5));
  const stills = Math.max(0, plan.count - 1 - clips);
  return Math.max(0, plan.videoBudget - (o.hasExistingVideo ? plan.per : 0)) * PRICE_PER_SECOND[o.res] + stills * PRICE_PER_IMAGE;
}

/** What a scene is made of (older projects: from the video / image switch). */
export const sourceOf = (scenes: ReelScene[], imageMode: Record<number, boolean>, i: number): SceneSource =>
  scenes[i]?.source ?? (imageMode[i] ? 'ai_image' : 'ai_video');

/** the camera move a still shows (studio preview and final render agree) */
export function motionOf(scenes: ReelScene[], imageMode: Record<number, boolean>, clips: Record<number, Clip>, i: number): SceneMotion | null {
  const m = scenes[i]?.motion;
  if (m && m !== 'none') return m;
  return clips[i]?.draft || sourceOf(scenes, imageMode, i) === 'graphic' ? 'zoom_in' : null;
}

/** a scene's narration made before its text, voice or style changed */
export function narrationOutdated(n: Narr | undefined, scene: ReelScene | undefined, voice: { voiceId: string; style: string }): boolean {
  // a different voice / style, or the narration text was edited after it was read
  const textChanged = n?.originalText != null && n.originalText.trim() !== (scene?.voiceover ?? '').trim();
  return Boolean(n?.url && ((n.voiceId && n.voiceId !== voice.voiceId) || (n.style && n.style !== voice.style) || textChanged));
}

export interface ProjectState extends SceneMaps {
  brief: string; total: number; res: Res; seamless: boolean; board: Storyboard | null; draftMode: boolean;
  anchorId: string | null; withNarration: boolean; voice: { voiceId: string; style: string; language: string };
  music: ReelProject['music']; captions: ReelProject['captions']; finalReel: ReelProject['final']; originalAudio: boolean;
}

/** The whole project as stored in content.reel — only permanent URLs, never blob: links. */
export function projectOf(s: ProjectState, now = Date.now()): ReelProject | null {
  const { board } = s;
  if (!board) return null;
  const scenes = board.scenes;
  const perm = (u?: string) => Boolean(u && u.startsWith('https://'));
  return {
    v: 1, brief: s.brief, total: s.total, res: s.res, seamless: s.seamless, board,
    clips: scenes.map((_, i) => (s.clips[i]?.status === 'done' && perm(s.clips[i].url)
      ? { url: s.clips[i].url!, kind: s.clips[i].kind ?? 'video', ...(s.clips[i].draft ? { draft: true } : {}), ...(s.clips[i].still && perm(s.clips[i].still!) ? { still: s.clips[i].still } : {}) } : null)),
    draftMode: s.draftMode,
    anchorId: s.anchorId,
    withNarration: s.withNarration,
    pendingClips: scenes.map((sc, i) => ({ sc, i, c: s.clips[i] }))
      .filter(({ c }) => c && (c.status === 'queued' || c.status === 'running') && c.requestId && c.model)
      .map(({ sc, i, c }) => ({ scene: i, requestId: c!.requestId!, model: c!.model!, seconds: sc.seconds || 5, startedAt: c!.startedAt ?? now })),
    photos: scenes.map((_, i) => s.photos[i] ?? null),
    imageMode: scenes.map((_, i) => Boolean(s.imageMode[i])),
    narration: scenes.map((_, i) => {
      const n = s.narr[i];
      return n?.persisted && n.mediaId && perm(n.url) ? {
        mediaId: n.mediaId, url: n.url!, originalText: n.originalText ?? '', spokenText: n.spokenText ?? '',
        cues: n.cues ?? [], durationSec: n.durationSec, voiceId: n.voiceId ?? '', style: n.style ?? '', language: n.language ?? 'he',
      } : null;
    }),
    voice: { voiceId: s.voice.voiceId, style: s.voice.style, language: s.voice.language },
    music: s.music, captions: s.captions, final: s.finalReel, updatedAt: now,
    sceneCaptions: scenes.map((_, i) => s.sceneCaps[i] ?? null),
    originalAudio: s.originalAudio,
  };
}

/** a saved project, back into what the page keeps per scene (clips that were still being made: the page follows them) */
export function restoreScenes(p: ReelProject): SceneMaps {
  const toMap = <T,>(arr: (T | null)[]) => Object.fromEntries(arr.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined));
  return {
    clips: Object.fromEntries(p.clips.map((c, i) => [i, c ? { status: 'done', url: c.url, kind: c.kind, draft: c.draft, still: c.still } : null]).filter(([, v]) => v)) as Record<number, Clip>,
    photos: toMap(p.photos) as Record<number, string | null>,
    imageMode: Object.fromEntries(p.imageMode.map((v, i) => [i, v])),
    narr: Object.fromEntries(p.narration.map((n, i) => [i, n ? { ...n, persisted: true } : null]).filter(([, v]) => v)) as Record<number, Narr>,
    sceneCaps: Object.fromEntries((p.sceneCaptions ?? []).map((c, i) => [i, c]).filter(([, c]) => c)) as Record<number, CaptionCue[]>,
  };
}

/** what the final render gets for each scene */
export function renderPayload(scenes: ReelScene[], clips: Record<number, Clip>, narr: Record<number, Narr>, withNarration: boolean): RenderScenePayload[] {
  return scenes.map((sc, i) => ({
    url: clips[i]?.url ?? '', kind: clips[i]?.kind ?? 'video', seconds: sc.seconds,
    // stills move (Ken Burns); a draft still of a video scene gets a gentle push-in
    motion: clips[i]?.kind === 'image' ? (sc.motion && sc.motion !== 'none' ? sc.motion : clips[i]?.draft ? 'zoom_in' : sc.source === 'graphic' ? 'zoom_in' : sc.motion) : undefined,
    // no narration chosen: none goes into the reel, even if some was made earlier
    narrationUrl: withNarration && narr[i]?.persisted ? narr[i]?.url : undefined,
    onScreen: sc.onScreen,
    cues: narr[i]?.persisted ? narr[i]?.cues : undefined,
    text: narr[i]?.persisted ? (narr[i]?.originalText || sc.voiceover) : undefined,
    durationSec: narr[i]?.persisted ? narr[i]?.durationSec : undefined,
    label: roleLabel(sc.role, i),
    // AI clips are silent under the narration; the user's own videos (a story, a selfie) keep their sound
    keepAudio: !(sc.source === 'ai_video' || sc.source === 'ai_image' || sc.source === 'graphic'),
  }));
}
