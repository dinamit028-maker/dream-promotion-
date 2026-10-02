/**
 * Video providers — request format against the official docs, with the network mocked.
 * (A real generation needs real keys: see TESTING.md.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HF_API_KEY_ID = 'kid'; process.env.HF_API_KEY_SECRET = 'ksec';
const calls: { url: string; init: any }[] = [];
let reply: (url: string) => Response = () => new Response('{}');
(globalThis as any).fetch = async (u: any, init: any = {}) => { calls.push({ url: String(u), init }); return reply(String(u)); };

test('Higgsfield Wan 3.0: documented endpoint, auth, idempotency and body', async () => {
  const { HiggsfieldWanProvider: H } = await import('../src/lib/server/ai/providers/higgsfield');
  reply = () => new Response(JSON.stringify({ status: 'queued', request_id: 'r1' }));
  const t = await H.submit({ prompt: 'p', duration: 5, resolution: '720p', aspectRatio: '9:16', audio: false } as any);
  assert.equal(calls[0].url, 'https://api.higgsfield.ai/alibaba/wan-3.0/text-to-video');
  assert.equal(calls[0].init.headers.Authorization, 'Key kid:ksec');
  assert.ok(calls[0].init.headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: 'p', duration: 5, resolution: '720p', aspect_ratio: '9:16', generate_audio: false });
  assert.equal(t.jobId, 'r1');
  await H.submit({ prompt: 'p', duration: 5, resolution: '480p', aspectRatio: '9:16', startImage: 'https://x.supabase.co/a.jpg', audio: false } as any);
  assert.equal(calls[1].url, 'https://api.higgsfield.ai/alibaba/wan-3.0/image-to-video');
  assert.equal(JSON.parse(calls[1].init.body).image_url, 'https://x.supabase.co/a.jpg');
  assert.equal(H.supports({ prompt: 'p', duration: 5, resolution: '720p', aspectRatio: '9:16', startImage: 'data:image/png;base64,x' } as any), false);
  assert.equal(H.supports({ prompt: 'p', duration: 31, resolution: '720p', aspectRatio: '9:16' } as any), false);
});

test('Higgsfield status mapping', async () => {
  const { HiggsfieldWanProvider: H } = await import('../src/lib/server/ai/providers/higgsfield');
  reply = () => new Response(JSON.stringify({ status: 'completed', video: { url: 'https://cdn.higgsfield.ai/o.mp4' } }));
  assert.deepEqual(await H.status('m', 'r1'), { state: 'succeeded', url: 'https://cdn.higgsfield.ai/o.mp4', durationSec: null, billedSeconds: null });
  reply = () => new Response(JSON.stringify({ status: 'nsfw' }));
  assert.equal((await H.status('m', 'r1') as any).kind, 'policy');
  reply = () => new Response(JSON.stringify({ status: 'in_progress' }));
  assert.equal((await H.status('m', 'r1')).state, 'running');
  reply = () => new Response('{"detail":"bad key"}', { status: 401 });
  await assert.rejects(H.status('m', 'r1'), (e: any) => e.kind === 'auth');
  assert.equal(H.estimate({ duration: 5, resolution: '720p' } as any), null, 'no price is invented');
});
