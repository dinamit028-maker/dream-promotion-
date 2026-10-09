/**
 * The reels studio's scenes and project (2.75, studio/scenes.ts — moved out of the page as they were): what each scene
 * has moves with it when scenes move or go; the model's script made safe; the cost before a script; the project saved
 * with permanent addresses only, and read back the same; what the final render gets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reelPlan, storyboardPrompt } from '../src/lib/services/prompts';
import {
  estimateVideoCost, motionOf, narrationOutdated, NEW_SCENE, planBoard, projectOf, remapScenes, removeScene, renderPayload, restoreScenes,
  sourceOf, swapScenes, type ProjectState,
} from '../src/features/reels/studio/scenes';
import type { ReelScene, Storyboard } from '../src/types';

const sc = (onScreen: string, extra: Partial<ReelScene> = {}): ReelScene => ({ role: 'hook', seconds: 5, onScreen, voiceover: `v-${onScreen}`, visual: '', videoPrompt: '', ...extra } as ReelScene);
const maps = () => ({
  clips: { 0: { status: 'done', url: 'https://x/a.png', kind: 'image' }, 1: { status: 'done', url: 'https://x/b.mp4', kind: 'video' } } as any,
  photos: { 0: 'p0', 2: null } as Record<number, string | null>,
  imageMode: { 0: true, 1: false, 2: true },
  narr: { 1: { url: 'https://x/n1.mp3', persisted: true } } as any,
  sceneCaps: { 2: [{ text: 'x', start: 0, end: 1 }] } as any,
});

test('scenes move and go: their clip, photo, mode, narration and captions follow them', () => {
  const scenes = [sc('a'), sc('b'), sc('c')];
  const s = swapScenes(scenes, 0, 1);
  assert.deepEqual(s.scenes.map((x) => x.onScreen), ['b', 'a', 'c']);
  const m = remapScenes(maps(), s.order);
  assert.deepEqual([m.clips[0].url, m.clips[1].url], ['https://x/b.mp4', 'https://x/a.png']);
  assert.deepEqual([m.photos[1], m.imageMode[0], m.imageMode[1], m.narr[0].url, m.sceneCaps[2]?.length], ['p0', false, true, 'https://x/n1.mp3', 1]);
  assert.equal(scenes[0].onScreen, 'a', 'never changed in place');
  const r = removeScene(scenes, 0);
  assert.deepEqual(r.scenes.map((x) => x.onScreen), ['b', 'c']);
  const k = remapScenes(maps(), r.order);
  assert.deepEqual([k.clips[0]?.url, k.clips[1], k.photos[1], k.sceneCaps[1]?.length], ['https://x/b.mp4', undefined, null, 1]);
  assert.deepEqual(remapScenes(maps(), [null, 0]).clips, { 1: maps().clips[0] }, 'a new scene has nothing yet');
  assert.equal(NEW_SCENE.source, 'graphic');
});

test('the model\'s script, made safe: known sources and moves, lengths 2–15; one continuous shot for "single"', () => {
  const b: Storyboard = { title: 't', caption: '', hashtags: [], scenes: [
    sc('a', { source: 'ai_video' as any, motion: 'zoom_in' as any, seconds: 5 }), sc('b', { source: 'weird' as any, seconds: 40 }), sc('c', { source: 'graphic' as any, motion: 'pan_left' as any, seconds: 3.6 }),
  ] } as Storyboard;
  const p = planBoard(b, 15, 'scenes');
  assert.deepEqual(p.board.scenes.map((x) => [x.source, x.motion, x.seconds]), [['ai_video', 'none', 5], ['ai_image', 'zoom_out', 5], ['graphic', 'none', 4]]);
  assert.deepEqual([p.imageMode, p.draftMode], [{ 0: false, 1: true, 2: true }, true]);
  const one = planBoard(b, 45, 'single');
  assert.equal(one.board.scenes.length, 1);
  assert.deepEqual([one.board.scenes[0].seconds, one.board.scenes[0].voiceover, one.draftMode, one.imageMode], [30, 'v-a v-b v-c', false, { 0: false }]);
  assert.match(one.board.scenes[0].videoPrompt!, /^One continuous shot, no cuts, 30 seconds\./);
});

test('the cost before a script; a video already there is not paid for', () => {
  const a = estimateVideoCost({ shape: 'scenes', total: 15, res: '720p', hasExistingVideo: false });
  const b = estimateVideoCost({ shape: 'scenes', total: 15, res: '720p', hasExistingVideo: true });
  assert.ok(a > b && b >= 0);
  assert.ok(estimateVideoCost({ shape: 'single', total: 45, res: '720p', hasExistingVideo: false }) === estimateVideoCost({ shape: 'single', total: 30, res: '720p', hasExistingVideo: false }), 'one shot: 30 seconds at most');
});

test('the cost before a script is the plan the storyboard asks for — a 10-second reel counts its still (2.78)', () => {
  const cost = (total: number, hasExistingVideo = false) => Number(estimateVideoCost({ shape: 'scenes', total, res: '720p', hasExistingVideo }).toFixed(2));
  // 10 s: 3 scenes — one 5-second clip ($0.10/s), one still ($0.08), the card (free). Before 2.78: $0.40, no still.
  assert.equal(cost(10), 0.58);
  assert.equal(cost(15), 0.58, '15 s: the same three scenes, longer');
  assert.equal(cost(30), 1.34, '30 s: 6 scenes — 11 s of video in 2 clips, 3 stills, the card');
  assert.equal(cost(15, true), 0.08, 'their own video takes a scene of video: only the still is paid for');
  // the numbers are the prompt's own: what the model is asked for is what is counted
  for (const d of [10, 15, 30, 45, 60]) {
    const { count, videoBudget } = reelPlan(d);
    const prompt = storyboardPrompt({ name: 'x' } as any, 'נושא', d);
    assert.ok(prompt.includes(`ב-${count} סצנות קצרות`) && prompt.includes(`עד ${videoBudget} שניות`), `${d} s: the prompt asks for the plan`);
  }
});

test('what a scene is made of, its camera move, a narration that no longer matches', () => {
  const scenes = [sc('a', { source: 'ai_image' as any, motion: 'none' as any }), sc('b'), sc('c', { source: 'graphic' as any })];
  assert.deepEqual([0, 1, 2].map((i) => sourceOf(scenes, { 1: true }, i)), ['ai_image', 'ai_image', 'graphic']);
  assert.deepEqual([0, 1, 2].map((i) => motionOf(scenes, {}, { 1: { status: 'done', draft: true } } as any, i)), [null, 'zoom_in', 'zoom_in']);
  const n = { url: 'u', voiceId: 'v1', style: 's', originalText: 'שלום' };
  assert.equal(narrationOutdated(n, sc('x', { voiceover: 'שלום' }), { voiceId: 'v1', style: 's' }), false);
  assert.equal(narrationOutdated(n, sc('x', { voiceover: 'שלום' }), { voiceId: 'v2', style: 's' }), true, 'another voice');
  assert.equal(narrationOutdated(n, sc('x', { voiceover: 'היי' }), { voiceId: 'v1', style: 's' }), true, 'the text changed');
  assert.equal(narrationOutdated(undefined, sc('x'), { voiceId: 'v1', style: 's' }), false);
});

test('the project: saved with permanent addresses only, read back as it was; what the final render gets', () => {
  const board = { title: 't', caption: 'c', hashtags: [], scenes: [sc('a', { source: 'ai_video' as any }), sc('b', { source: 'ai_image' as any, motion: 'zoom_out' as any })] } as Storyboard;
  const state: ProjectState = {
    brief: 'b', total: 10, res: '720p', seamless: true, board, draftMode: true, anchorId: null, withNarration: true,
    voice: { voiceId: 'v1', style: 's', language: 'he' }, music: null, captions: { enabled: true, position: 'bottom', size: 'lg' }, finalReel: null, originalAudio: true,
    clips: { 0: { status: 'done', url: 'https://x/a.png', kind: 'image', draft: true, still: 'blob:x' }, 1: { status: 'running', requestId: 'r', model: 'm', startedAt: 5 } } as any,
    photos: {}, imageMode: { 1: true },
    narr: { 0: { url: 'https://x/n.mp3', mediaId: 'm0', persisted: true, originalText: 'v-a', cues: [] }, 1: { url: 'blob:y', persisted: false } } as any,
    sceneCaps: {},
  };
  const p = projectOf(state, 99)!;
  assert.deepEqual(p.clips, [{ url: 'https://x/a.png', kind: 'image', draft: true }, null], 'a blob: still is not saved');
  assert.deepEqual(p.pendingClips, [{ scene: 1, requestId: 'r', model: 'm', seconds: 5, startedAt: 5 }]);
  assert.deepEqual(p.narration.map((n) => n?.url ?? null), ['https://x/n.mp3', null]);
  assert.deepEqual([p.updatedAt, p.imageMode, p.photos], [99, [false, true], [null, null]]);
  assert.equal(projectOf({ ...state, board: null }), null);
  const back = restoreScenes(p);
  assert.deepEqual(back.clips, { 0: { status: 'done', url: 'https://x/a.png', kind: 'image', draft: true, still: undefined } });
  assert.equal(back.narr[0].persisted, true);
  const pay = renderPayload(board.scenes, back.clips, back.narr, true);
  assert.deepEqual(pay.map((x) => [x.url, x.motion, x.narrationUrl, x.keepAudio]), [['https://x/a.png', 'zoom_in', 'https://x/n.mp3', false], ['', undefined, undefined, false]]);
  assert.equal(renderPayload(board.scenes, back.clips, back.narr, false)[0].narrationUrl, undefined, 'no narration chosen: none in the reel');
});
