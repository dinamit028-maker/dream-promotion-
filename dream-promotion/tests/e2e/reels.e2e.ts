/**
 * The reels studio (2.75 — the page split into parts): a saved reel opened as it was left, on a computer and a phone,
 * every step of the wizard; what the owner does on it — move a scene (its clip and narration move with it), edit a
 * scene's text, add and remove a scene, pick a picture from the library — and the autosave that writes it back.
 * With REELS_SHOTS=<dir> every screen is saved there; with REELS_COMPARE=<dir> it is held against the pictures in that
 * folder (the page before a change), pixel by pixel in the browser's canvas — a change that was not meant fails.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_REELS_PORT ?? 3221);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-000000000001';
const OWNER = 'a0000000-0000-4000-8000-0000000000a1';
const REEL = 'e0000000-0000-4000-8000-0000000000e9';
const PHOTO = 'e0000000-0000-4000-8000-0000000000f1';
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };

const narration = (n: number) => ({
  mediaId: `e0000000-0000-4000-8000-00000000010${n}`, url: `https://cdn.test/voice-${n}.mp3`, originalText: `קריינות סצנה ${n}`,
  spokenText: `קריינות סצנה ${n}`, cues: [], durationSec: 4, voiceId: 'v1', style: 'warm', language: 'he',
});
const project = {
  v: 1, brief: 'טיפול פנים לפני החורף', total: 15, res: '720p', seamless: true, draftMode: false, anchorId: null, withNarration: true,
  board: {
    title: 'טיפול פנים לחורף', caption: 'העור שלכם מוכן לחורף?', hashtags: ['#טיפוח'],
    scenes: [
      { role: 'hook', seconds: 5, onScreen: 'העור יבש בחורף?', voiceover: 'קריינות סצנה 1', visual: 'אישה מול מראה', videoPrompt: 'woman at a mirror', source: 'ai_video', motion: 'none' },
      { role: 'solution', seconds: 5, onScreen: 'טיפול לחות עמוק', voiceover: 'קריינות סצנה 2', visual: 'טיפול בקליניקה', videoPrompt: 'facial treatment', source: 'ai_image', motion: 'zoom_out' },
      { role: 'cta', seconds: 5, onScreen: 'קבעו תור', voiceover: '', visual: 'כרטיס', videoPrompt: '', source: 'graphic', motion: 'none' },
    ],
  },
  clips: [
    { url: 'https://cdn.test/still-1.png', kind: 'image', still: 'https://cdn.test/still-1.png' },
    { url: 'https://cdn.test/still-2.png', kind: 'image' },
    { url: 'https://cdn.test/card-3.png', kind: 'image' },
  ],
  photos: [null, null, null], imageMode: [false, true, true],
  narration: [narration(1), narration(2), null],
  voice: { voiceId: 'v1', style: 'warm', language: 'he' },
  music: null, captions: { enabled: true, position: 'bottom', size: 'lg' }, final: { mediaId: 'e0000000-0000-4000-8000-0000000001f0', url: 'https://cdn.test/final.mp4', durationSec: 15, renderedAt: 1 }, updatedAt: 1, sceneCaptions: [null, null, null], originalAudio: true,
};

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'SaGabot', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    content: [{ ...base, id: REEL, kind: 'reel', platform: 'Instagram', goal: '', headline: 'טיפול פנים לחורף', caption: 'העור שלכם מוכן לחורף?', hashtags: ['#טיפוח'],
      cta: '', palette: ['#6B3BF5', '#A96BF8'], media_id: null, scenes: null, status: 'draft', date: null, time: null, reel: project }],
    media: [{ ...base, id: PHOTO, url: 'https://cdn.test/library-photo.png', name: 'תמונה מהספרייה', kind: 'image' }],
    register_settings: [], catalog_items: [], employees: [], leads: [], sales: [], documents: [], sale_refunds: [], stock_movements: [],
    register_shifts: [], appointments: [], booking_services: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
  };
}

/** a small PNG of one colour (no image library) */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const COLORS: Record<string, [number, number, number]> = { 'still-1': [200, 120, 80], 'still-2': [80, 140, 200], 'card-3': [120, 60, 200], 'library-photo': [60, 160, 90] };

async function waitForServer(dev: ChildProcess) {
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`next dev did not start:\n${out}`)), 120_000);
    const on = (b: Buffer) => { out += b.toString(); if (/Ready|ready on|started server/i.test(out)) { clearTimeout(t); resolve(); } };
    dev.stdout?.on('data', on); dev.stderr?.on('data', on);
    dev.on('exit', (c) => { clearTimeout(t); reject(new Error(`next dev exited ${c}\n${out}`)); });
  });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const saveTo = process.env.REELS_SHOTS, compareTo = process.env.REELS_COMPARE;
  if (saveTo) mkdirSync(saveTo, { recursive: true });
  const pw: any = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.js' as string));
  const { chromium } = pw.default ?? pw;
  const dev = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key', NEXT_TELEMETRY_DISABLED: '1' },
  });
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const browser = await (async () => { await waitForServer(dev); return chromium.launch(); })();
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@sagabot.test' });
  const errors: string[] = [];

  async function open(viewport: { width: number; height: number }, p: string) {
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'user@sagabot.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    });
    await ctx.route('https://cdn.test/**', (r: any) => {
      const name = new URL(r.request().url()).pathname.slice(1).replace(/\.\w+$/, '');
      if (/\.mp3$/.test(r.request().url())) return r.fulfill({ status: 200, body: Buffer.alloc(0), contentType: 'audio/mpeg' });
      if (/\.mp4$/.test(r.request().url())) return r.fulfill({ status: 200, body: Buffer.alloc(0), contentType: 'video/mp4' });
      return r.fulfill({ status: 200, body: png(270, 480, COLORS[name] ?? [180, 180, 180]), contentType: 'image/png' });
    });
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'SaGabot', state: 'active' }, businesses: [{ id: BIZ, name: 'SaGabot', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/ai`, (r: any) => r.fulfill(r.request().method() === 'GET' ? { json: { available: true, model: 'test' } } : { status: 400, json: { code: 'unknown_task' } }));
    await ctx.route(`${BASE}/api/video`, (r: any) => r.fulfill(r.request().method() === 'GET' ? { json: { available: true } } : { status: 400, json: { error: 'no' } }));
    await ctx.route(`${BASE}/api/voice**`, (r: any) => r.fulfill({ json: { available: true, provider: 'test', usage: null,
      voices: [{ id: 'v1', name: 'נועה', gender: 'female', accent: 'he', preview: '' }, { id: 'v2', name: 'דן', gender: 'male', accent: 'he', preview: '' }] } }));
    await ctx.route(`${BASE}/api/music/**`, (r: any) => r.fulfill({ json: { tracks: [], total: 0 } }));
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page };
  }
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 6).join('\n  ')}`); }
  };

  // a screen: saved (REELS_SHOTS), held against the earlier one (REELS_COMPARE)
  const cmpPage = await (await browser.newContext()).newPage();
  await cmpPage.evaluate('window.__name = (f) => f');
  const diffs: string[] = [];
  const shot = async (page: any, name: string) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
    await page.waitForTimeout(300);
    // a <video> shows the browser's own loading wheel, at another angle each time: covered
    const buf: Buffer = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled', caret: 'hide', mask: [page.locator('video')] });
    if (saveTo) writeFileSync(path.join(saveTo, `${name}.png`), buf);
    if (!compareTo) return;
    const before = path.join(compareTo, `${name}.png`);
    if (!existsSync(before)) { diffs.push(`${name}: no earlier picture`); return; }
    const r = await cmpPage.evaluate(async ([a, b]: string[]) => {
      const load = (src: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return { size: `${x.width}x${x.height} ≠ ${y.width}x${y.height}`, n: 0 };
      const px = (img: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d')!; g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const [p, q] = [px(x), px(y)];
      let n = 0;
      for (let i = 0; i < p.length; i += 4) if (Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2])) > 40) n++;
      return { size: '', n };
    }, [`data:image/png;base64,${readFileSync(before).toString('base64')}`, `data:image/png;base64,${buf.toString('base64')}`]);
    if (r.size || r.n > 0) { diffs.push(`${name}: ${r.size || `${r.n} pixels changed`}`); writeFileSync(path.join(SHOTS, `reels-${name}.after.png`), buf); }
  };
  const stored = () => fake.tables.content.find((c) => c.id === REEL)!.reel;
  /** a step of the wizard, by its place in the step bar (its name is its number and its label) */
  const toStep = async (page: any, n: number) => { await page.getByRole('navigation', { name: 'שלבי יצירת הריל' }).getByRole('button').nth(n - 1).click(); await page.waitForTimeout(300); };
  const sceneTexts = (page: any) => page.locator('#reel-scenes strong').allInnerTexts();
  const waitSaved = async (want: (r: any) => boolean) => { for (let i = 0; i < 60 && !want(stored()); i++) await new Promise((r) => setTimeout(r, 100)); assert.ok(want(stored()), 'saved'); };

  try {
    for (const [device, viewport] of [['computer', DESK], ['phone', PHONE]] as const) {
      await step(`a new reel on a ${device}: the first step, nothing to lose`, async () => {
        const { ctx, page } = await open(viewport, '/reels');
        await page.getByRole('heading', { name: 'אולפן הרילס' }).waitFor({ timeout: 120_000 });
        await page.getByText('אין עדיין תסריט').waitFor();
        await page.getByRole('button', { name: 'טיפול פנים לחורף' }).waitFor();   // the saved projects
        await shot(page, `new-${device}`);
        await ctx.close();
      });
      await step(`a saved reel on a ${device}: opened where it was left; every step of the wizard`, async () => {
        const { ctx, page } = await open(viewport, `/reels?id=${REEL}`);
        await page.getByRole('heading', { name: 'טיפול פנים לחורף' }).waitFor({ timeout: 120_000 });
        // every step is done, the final reel too: it opens on the last one, "פרסום"
        assert.equal(await page.getByRole('navigation', { name: 'שלבי יצירת הריל' }).getByRole('button').nth(4).getAttribute('aria-current'), 'step');
        for (const n of [1, 2, 3, 4, 5]) {
          await toStep(page, n);
          if (n === 1) assert.deepEqual(await sceneTexts(page), ['העור יבש בחורף?', 'טיפול לחות עמוק', 'קבעו תור']);
          await shot(page, `step${n}-${device}`);
        }
        await ctx.close();
      });
    }

    await step('moving a scene: its clip and its narration move with it, and the new order is saved', async () => {
      const { ctx, page } = await open(DESK, `/reels?id=${REEL}`);
      await page.getByRole('heading', { name: 'טיפול פנים לחורף' }).waitFor({ timeout: 120_000 });
      await toStep(page, 2);
      await page.getByRole('button', { name: 'הזזה קדימה' }).first().click();
      assert.deepEqual(await sceneTexts(page), ['טיפול לחות עמוק', 'העור יבש בחורף?', 'קבעו תור']);
      await waitSaved((r) => r.board.scenes[0].onScreen === 'טיפול לחות עמוק');
      assert.deepEqual(stored().clips.map((c: any) => c?.url), ['https://cdn.test/still-2.png', 'https://cdn.test/still-1.png', 'https://cdn.test/card-3.png'], 'the clips moved with their scenes');
      assert.equal(stored().clips[1].still, 'https://cdn.test/still-1.png', 'the clip kept its approved still');
      assert.deepEqual(stored().narration.map((n: any) => n?.url ?? null), ['https://cdn.test/voice-2.mp3', 'https://cdn.test/voice-1.mp3', null], 'the narration too');
      await shot(page, 'moved');
      // and back
      await page.getByRole('button', { name: 'הזזה אחורה' }).nth(1).click();
      await waitSaved((r) => r.board.scenes[0].onScreen === 'העור יבש בחורף?');
      assert.deepEqual(stored().clips.map((c: any) => c?.url), project.clips.map((c) => c.url));
      await ctx.close();
    });

    await step('editing a scene\'s text; adding a scene and removing it', async () => {
      const { ctx, page } = await open(DESK, `/reels?id=${REEL}`);
      await page.getByRole('heading', { name: 'טיפול פנים לחורף' }).waitFor({ timeout: 120_000 });
      await toStep(page, 1);
      await page.getByRole('button', { name: 'עריכה', exact: true }).nth(1).click();
      const dlg = page.getByRole('dialog');
      await dlg.getByLabel('כיתוב על המסך').fill('לחות לכל החורף');
      await dlg.locator('textarea').first().fill('טקסט חדש');   // the narration
      await shot(page, 'editor');
      await dlg.getByRole('button', { name: 'סיום' }).click();
      assert.deepEqual(await sceneTexts(page), ['העור יבש בחורף?', 'לחות לכל החורף', 'קבעו תור']);
      await waitSaved((r) => r.board.scenes[1].onScreen === 'לחות לכל החורף' && r.board.scenes[1].voiceover === 'טקסט חדש');
      await page.getByRole('button', { name: 'הוספת סצנה' }).click();
      assert.equal((await sceneTexts(page)).length, 4);
      await waitSaved((r) => r.board.scenes.length === 4 && r.clips.length === 4 && r.clips[3] === null);
      await page.getByRole('button', { name: 'מחיקת סצנה' }).first().click();
      assert.deepEqual(await sceneTexts(page), ['לחות לכל החורף', 'קבעו תור', 'קריאה לפעולה']);
      await waitSaved((r) => r.board.scenes.length === 3 && r.clips[0]?.url === 'https://cdn.test/still-2.png' && r.narration[0]?.url === 'https://cdn.test/voice-2.mp3');
      await ctx.close();
    });

    await step('a picture from the library for a scene; and "without a picture" again', async () => {
      const { ctx, page } = await open(DESK, `/reels?id=${REEL}`);
      await page.getByRole('heading', { name: 'טיפול פנים לחורף' }).waitFor({ timeout: 120_000 });
      await toStep(page, 2);
      await page.getByRole('button', { name: /תמונת פתיחה/ }).first().click();
      const dlg = page.getByRole('dialog');
      await dlg.getByRole('heading', { name: 'מדיה לקליפ 1' }).waitFor();
      await shot(page, 'picker');
      await dlg.getByRole('button', { name: /תמונה מהספרייה/ }).click();
      await waitSaved((r) => r.photos[0] === PHOTO);
      await page.getByRole('button', { name: /תמונת פתיחה/ }).first().click();
      await page.getByRole('dialog').getByRole('button', { name: 'בלי תמונה — לייצר מטקסט בלבד' }).click();
      await waitSaved((r) => r.photos[0] === null);
      await ctx.close();
    });

    await step('nothing broke in the browser; the pictures are as they were', async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(diffs, [], diffs.join('\n'));
    });
  } finally {
    await browser.close().catch(() => {});
    try { process.kill(-dev.pid!, 'SIGTERM'); } catch { /* gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`# e2e reels: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
