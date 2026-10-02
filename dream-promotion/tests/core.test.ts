/**
 * Dream Promotion — automated tests for the pure logic (no network, no database).
 * Run:  npm test        (uses tsx + node:test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { israelToIso, israelParts } from '../src/lib/il-time';
import { reelCosts, stepStatus, wizardSteps } from '../src/features/reels/studio/logic';
import { friendlyRenderError, friendlyMediaError } from '../src/lib/friendly-errors';
import { hostAllowed, ipIsPrivate, urlLooksAllowed } from '../src/lib/server/safe-fetch';
import { classifyFailure } from '../src/lib/server/scheduler';
import type { ReelScene } from '../src/types';

const sc = (p: Partial<ReelScene>): ReelScene => ({ role: 'hook', seconds: 5, onScreen: '', voiceover: '', visual: '', ...p } as ReelScene);

test('Israel time: same moment from any device, summer and winter', () => {
  assert.equal(israelToIso('2026-10-06', '19:30'), '2026-10-06T16:30:00.000Z'); // summer UTC+3
  assert.equal(israelToIso('2026-12-01', '20:00'), '2026-12-01T18:00:00.000Z'); // winter UTC+2
  assert.equal(israelToIso('2026-03-27', '03:30'), '2026-03-27T00:30:00.000Z'); // the night the clock moves
  for (const [d, t] of [['2026-10-25', '01:30'], ['2026-07-15', '09:00']]) {
    const back = israelParts(new Date(israelToIso(d, t)));
    assert.equal(`${back.date} ${back.time}`, `${d} ${t}`);
  }
  assert.equal(israelParts(new Date('2026-10-04T09:00:00Z')).weekday, 0); // Sunday
});

test('reel cost: what is left to pay now and for the final version', () => {
  const scenes = [sc({ source: 'ai_video', seconds: 5 }), sc({ source: 'ai_image' }), sc({ source: 'graphic' })];
  const base = { scenes, clips: {}, imageMode: {}, photos: {}, res: '480p' as const };
  const direct = reelCosts({ ...base, draftMode: false });
  assert.equal(+direct.now.toFixed(2), 0.33); // 5s × $0.05 + one image $0.08; the card is free
  assert.equal(direct.final, 0);
  assert.equal(direct.videoSec, 5);
  const draft = reelCosts({ ...base, draftMode: true });
  assert.equal(+draft.now.toFixed(2), 0.16);  // two stills now
  assert.equal(+draft.final.toFixed(2), 0.25); // the video later
  const paid = reelCosts({ ...base, draftMode: false, clips: { 0: { status: 'done', url: 'u' }, 1: { status: 'done', url: 'u' } } });
  assert.equal(paid.now, 0); // never pay twice for what is done
});

test('wizard: each step opens when the one before is done; no-narration skips step 3', () => {
  const scenes = [sc({ voiceover: 'שלום' })];
  const none = stepStatus({ hasBoard: false, scenes: [], clips: {}, narr: {}, withNarration: true, hasFinal: false });
  assert.equal(none.firstOpen, 1);
  const video = stepStatus({ hasBoard: true, scenes, clips: {}, narr: {}, withNarration: true, hasFinal: false });
  assert.equal(video.firstOpen, 2);
  const draftOnly = stepStatus({ hasBoard: true, scenes, clips: { 0: { status: 'done', url: 'u', draft: true } }, narr: {}, withNarration: true, hasFinal: false });
  assert.equal(draftOnly.firstOpen, 2, 'a draft still is not a finished video');
  const voice = stepStatus({ hasBoard: true, scenes, clips: { 0: { status: 'done', url: 'u' } }, narr: {}, withNarration: true, hasFinal: false });
  assert.equal(voice.firstOpen, 3);
  const noVoice = stepStatus({ hasBoard: true, scenes, clips: { 0: { status: 'done', url: 'u' } }, narr: {}, withNarration: false, hasFinal: false });
  assert.equal(noVoice.firstOpen, 4);
  assert.equal(wizardSteps(false)[2].label, 'בלי קריינות');
});

test('safe fetch: only approved hosts, never private addresses', () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
  for (const h of ['abc.supabase.co', 'v3.fal.media', 'scontent.cdninstagram.com', 'video.fbcdn.net', 'prod-1.storage.jamendo.com']) assert.ok(hostAllowed(h), h);
  for (const h of ['evil.supabase.co', 'fal.media.evil.com', 'fbcdn.net.attacker.com', 'localhost', 'example.com']) assert.ok(!hostAllowed(h), h);
  for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.1', '172.16.0.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(ipIsPrivate(ip), ip);
  for (const ip of ['8.8.8.8', '151.101.1.1']) assert.ok(!ipIsPrivate(ip), ip);
  assert.ok(!urlLooksAllowed('http://v3.fal.media/a.mp4'), 'http is refused');
  assert.ok(!urlLooksAllowed('https://127.0.0.1/a'), 'raw IP is refused');
});

test('scheduler: hiccups are retried, refusals fail at once', () => {
  assert.equal(classifyFailure('fetch failed: ETIMEDOUT'), 'retry');
  assert.equal(classifyFailure('meta_http_503'), 'retry');
  assert.equal(classifyFailure('meta_4: Application request limit reached'), 'retry');
  assert.equal(classifyFailure('meta_100: Invalid parameter'), 'fail');
  assert.equal(classifyFailure('reconnect_required: session expired'), 'fail');
  assert.equal(classifyFailure('permission_denied: (#200)'), 'fail');
});

test('friendly errors: no raw technical text reaches the user', () => {
  const r = friendlyRenderError('ffmpeg_failed: [mov,mp4] moov atom not found');
  assert.ok(!/ffmpeg|moov/i.test(r.title + r.body));
  assert.match(r.body, /שום דבר לא אבד/);
  assert.match(friendlyRenderError('download_failed 404: https://x').title, /לא היה זמין/);
  assert.match(friendlyRenderError('too_many_running').title, /עוד רץ/);
  assert.ok(!/500|stack/i.test(friendlyMediaError('HTTP 500 internal stack trace')));
});
