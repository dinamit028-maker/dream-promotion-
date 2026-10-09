/**
 * Client file — photos (docs/CLIENT FILE ENGINEERING HE.md §4, /api/client-file/photos) with an in-memory database and
 * storage (the real route code and the real image library run): only the owner and marked practitioners; only customers
 * of the business worked in now; the kept copy has no EXIF / GPS, is at most 2048px WebP; the original is removed; a retry
 * never makes a second photo; every link is given only after the view is written in the log.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fakeDb } from './fakedb';
import { resetRateLimits } from '../src/lib/server/rate-limit';
import { cleanPhoto, israelDayStart } from '../src/lib/server/client-file';
import {
  DAILY_PHOTO_LIMIT, cleanTakenAt, comparePair, galleryGroups, inLead, incomingPath, photoPath, retryDelay, sniffImage,
  type PhotoRow, type TreatmentRow,
} from '../src/features/client-file/photos';

const OWN = 'user-own', PRAC = 'user-prac', STAFF = 'user-staff', CASH = 'user-cash', VIEW = 'user-view', OTHER = 'user-other';
const B1 = '00000000-0000-4000-8000-00000000c001', B2 = '00000000-0000-4000-8000-00000000c002';
const NOA = '00000000-0000-4000-8000-0000000000a1', DANA = '00000000-0000-4000-8000-0000000000a2', MICHAL = '00000000-0000-4000-8000-0000000000b1';
const T_NOA = '00000000-0000-4000-8000-0000000000e1', T_DANA = '00000000-0000-4000-8000-0000000000e2';
const UP = '00000000-0000-4000-8000-0000000000f1';
const tables: Record<string, any[]> = {};
const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
const current: Record<string, string> = { [OWN]: B1, [PRAC]: B1, [STAFF]: B1, [CASH]: B1, [VIEW]: B1, [OTHER]: B2 };
/** who client_files_allowed_for says yes to (the database's rule: owner or marked, full access) */
const allowed = new Set([`${OWN}:${B1}`, `${PRAC}:${B1}`, `${VIEW}:${B1}`, `${OTHER}:${B2}`]);
let installed = true;
let logFails = false;
const views: { user: string; business: string; id: string }[] = [];
const events: string[] = [];

function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  files.clear(); views.length = 0; events.length = 0; installed = true; logFails = false;
  resetRateLimits();
  Object.assign(tables, {
    profiles: [OWN, PRAC, STAFF, CASH, VIEW, OTHER].map((id) => ({ id, is_super_admin: false })),
    businesses: [{ id: B1, status: 'active', paid_until: null, grace_days: 0 }, { id: B2, status: 'active', paid_until: null, grace_days: 0 }],
    business_members: [
      { business_id: B1, user_id: OWN, role: 'owner', access: 'full' }, { business_id: B1, user_id: PRAC, role: 'editor', access: 'full' },
      { business_id: B1, user_id: STAFF, role: 'editor', access: 'full' }, { business_id: B1, user_id: CASH, role: 'editor', access: 'register' },
      { business_id: B1, user_id: VIEW, role: 'viewer', access: 'full' }, { business_id: B2, user_id: OTHER, role: 'owner', access: 'full' }],
    leads: [{ id: NOA, business_id: B1, name: 'נועה' }, { id: DANA, business_id: B1, name: 'דנה' }, { id: MICHAL, business_id: B2, name: 'מיכל' }],
    client_treatments: [
      { id: T_NOA, business_id: B1, lead_id: NOA, title: 'לייזר', area: 'רגליים', started_at: '2026-10-01', status: 'active', treatment_type_id: null },
      { id: T_DANA, business_id: B1, lead_id: DANA, title: 'מיצוק', area: '', started_at: '2026-10-02', status: 'active', treatment_type_id: null }],
    client_photos: [], treatment_types: [],
  });
}
const storage = {
  from: (bucket: string) => {
    assert.equal(bucket, 'client-files');
    return {
      createSignedUploadUrl: async (path: string) => ({ data: { token: `tok:${path}`, path }, error: null }),
      download: async (path: string) => {
        const f = files.get(path);
        return f ? { data: new Blob([f.bytes as BlobPart], { type: f.contentType }), error: null } : { data: null, error: { message: 'not found' } };
      },
      upload: async (path: string, bytes: Uint8Array, o: { contentType: string }) => { files.set(path, { bytes: new Uint8Array(bytes), contentType: o.contentType }); return { data: { path }, error: null }; },
      remove: async (paths: string[]) => { for (const p of paths) files.delete(p); return { data: [], error: null }; },
      createSignedUrl: async (path: string, seconds: number) => { events.push(`sign:${path}`); return { data: { signedUrl: `https://sb.test/sign/${path}?ttl=${seconds}` }, error: null }; },
    };
  },
};
const missing = { code: 'PGRST202', message: 'function not found' };
before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    from: (t: string) => fakeDb(tables).from(t),
    auth: { getUser: async (t: string) => ({ data: { user: Object.keys(current).includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string, a: any) => {
      if (fn === 'business_for_user') return { data: current[a.uid] ?? null, error: null };
      if (fn === 'client_files_allowed_for') return installed ? { data: allowed.has(`${a.p_user}:${a.p_business}`), error: null } : { data: null, error: missing };
      if (fn === 'client_file_log_view') {
        const p = tables.client_photos.find((r) => r.id === a.p_id && r.business_id === a.p_business);
        if (logFails || !p || !allowed.has(`${a.p_user}:${a.p_business}`)) return { data: null, error: { message: 'not allowed' } };
        views.push({ user: a.p_user, business: a.p_business, id: a.p_id }); events.push(`log:${a.p_id}`);
        return { data: p.lead_id, error: null };
      }
      return { data: null, error: null };
    },
    storage,
  };
});
beforeEach(reset);

const call = async (user: string | null, body: unknown) => {
  const { POST } = await import('../src/app/api/client-file/photos/route');
  const r = await POST(new Request('http://x/api/client-file/photos', { method: 'POST', headers: user ? { authorization: `Bearer ${user}` } : {}, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
/** a phone photo: 3000×2000 JPEG, rotated by EXIF (orientation 6), with GPS and the camera's name */
const phonePhoto = () => sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 120, b: 90 } } })
  .jpeg().withExif({ IFD0: { Make: 'PhoneCo', Model: 'X1' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '32/1 4/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '34/1 46/1 0/1' } })
  .withMetadata({ orientation: 6 }).toBuffer();

test('the rules: paths, what the bytes are, the gallery and the comparison', () => {
  assert.equal(incomingPath(B1, NOA, UP), `${B1}/${NOA}/incoming/${UP}`);
  assert.equal(photoPath(B1, NOA, UP), `${B1}/${NOA}/${UP}.webp`);
  assert.ok(inLead(photoPath(B1, NOA, UP), B1, NOA));
  assert.ok(!inLead(photoPath(B1, NOA, UP), B1, DANA) && !inLead(`${B1}/${NOA}/../${DANA}/x.webp`, B1, NOA) && !inLead(`${B2}/${MICHAL}/x`, B1, MICHAL));
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffImage(new TextEncoder().encode('RIFF....WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(new TextEncoder().encode('%PDF-1.7')), null);
  assert.equal(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>')), null, 'an SVG is not a photo');
  const now = Date.parse('2026-10-09T10:00:00Z');
  assert.equal(cleanTakenAt('2026-10-08T09:00:00.000Z', now), '2026-10-08T09:00:00.000Z');
  assert.equal(cleanTakenAt('2030-01-01T00:00:00Z', now), new Date(now).toISOString(), 'not in the future');
  assert.equal(cleanTakenAt('1990-01-01', now), new Date(now).toISOString(), 'not before 2000');
  assert.equal(cleanTakenAt(42, now), new Date(now).toISOString());
  assert.deepEqual([1, 2, 3, 10].map(retryDelay), [2000, 4000, 8000, 60000], 'backing off, at most a minute');

  const ph = (id: string, stage: PhotoRow['stage'], at: string, treatment_id: string | null): PhotoRow =>
    ({ id, lead_id: NOA, treatment_id, session_id: null, stage, width: 1, height: 1, taken_at: at, by_user: OWN, marketing_ok: false });
  const tr = (id: string, started_at: string): TreatmentRow => ({ id, lead_id: NOA, title: id, area: '', started_at, status: 'active', treatment_type_id: null });
  const photos = [ph('p3', 'after', '2026-10-05', 'old'), ph('p1', 'before', '2026-10-01', 'old'), ph('p2', 'process', '2026-10-03', 'old'),
    ph('p4', 'after', '2026-10-06', 'old'), ph('p5', 'before', '2026-10-07', 'new'), ph('p6', 'before', '2026-10-02', null), ph('p7', 'after', '2026-10-02', 'gone')];
  const groups = galleryGroups(photos, [tr('old', '2026-09-01'), tr('new', '2026-10-07'), tr('empty', '2026-10-08')]);
  assert.deepEqual(groups.map((g) => [g.treatment?.id ?? null, g.photos.map((p) => p.id)]),
    [['new', ['p5']], ['old', ['p1', 'p2', 'p3', 'p4']], [null, ['p6', 'p7']]], 'newest treatment first, photos by time, the rest last, no empty group');
  const pair = comparePair(groups[1].photos);
  assert.deepEqual([pair?.before.id, pair?.after.id], ['p1', 'p4'], 'the first before and the last after');
  assert.equal(comparePair(groups[0].photos), null, 'no "after" yet: no comparison');
  assert.equal(israelDayStart(new Date('2026-10-09T10:00:00Z')), '2026-10-08T21:00:00.000Z', 'summer time: midnight is 21:00 UTC');
  assert.equal(israelDayStart(new Date('2026-12-09T23:30:00Z')), '2026-12-09T22:00:00.000Z', 'winter: 22:00 UTC (and it is already the 10th in Israel)');
});

test('the kept copy: no EXIF, no GPS, upright, at most 2048px, WebP', async () => {
  const original = await phonePhoto();
  const before = await sharp(original).metadata();
  assert.ok(before.exif && before.orientation === 6, 'the phone photo has EXIF (GPS, orientation)');
  const out = await cleanPhoto(original);
  const m = await sharp(out.bytes).metadata();
  assert.equal(m.format, 'webp');
  assert.equal(m.exif, undefined, 'no EXIF at all — the GPS is gone');
  assert.equal(m.xmp, undefined); assert.equal(m.icc, undefined); assert.equal(m.orientation, undefined);
  assert.deepEqual([m.width, m.height, out.width, out.height], [1365, 2048, 1365, 2048], 'turned upright (portrait), the long side 2048');
  assert.ok(!Buffer.from(out.bytes).includes(Buffer.from('PhoneCo')), 'not even the camera’s name in the bytes');
  const small = await cleanPhoto(await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).png().toBuffer());
  assert.deepEqual([small.width, small.height], [800, 600], 'never enlarged');
  await assert.rejects(cleanPhoto(new TextEncoder().encode('<svg/>')), /אינו תמונה/);
  await assert.rejects(cleanPhoto(new Uint8Array([0xff, 0xd8, 0xff, 0, 1, 2, 3])), /לא הצלחנו לקרוא/, 'a broken JPEG');
  await assert.rejects(cleanPhoto(new Uint8Array(15 * 1024 * 1024 + 1)), /15MB/);
});

test('who: the owner and marked practitioners; never a cashier, unmarked staff or another business', async () => {
  assert.equal((await call(null, { action: 'list', leadId: NOA })).status, 401);
  for (const u of [CASH, STAFF]) {
    for (const action of ['list', 'sign', 'open']) {
      const r = await call(u, { action, leadId: NOA, photoIds: [UP] });
      assert.deepEqual([r.status, r.body.code], [403, 'no_access'], `${u} ${action}`);
    }
  }
  assert.equal((await call(OWN, { action: 'list', leadId: NOA })).status, 200);
  assert.equal((await call(PRAC, { action: 'list', leadId: NOA })).status, 200);
  const v = await call(VIEW, { action: 'list', leadId: NOA });
  assert.equal(v.status, 200, 'a marked viewer reads');
  assert.deepEqual([(await call(VIEW, { action: 'sign', leadId: NOA })).body.code], ['view_only'], 'and never uploads');
  assert.equal((await call(OTHER, { action: 'list', leadId: NOA })).status, 404, 'another business: no such customer');
  assert.equal((await call(OTHER, { action: 'sign', leadId: NOA })).status, 404);
  installed = false;
  assert.deepEqual([(await call(OWN, { action: 'list', leadId: NOA })).body.code], ['not_ready'], 'before the migration: the card shows nothing');
});

test('a photo from the phone: signed into incoming, cleaned by the server, the original removed, once', async () => {
  const s = await call(PRAC, { action: 'sign', leadId: NOA, uploadId: UP });
  assert.equal(s.status, 200);
  assert.equal(s.body.path, incomingPath(B1, NOA, UP));
  const notYet = await call(PRAC, { action: 'commit', leadId: NOA, uploadId: UP, stage: 'before', treatmentId: T_NOA });
  assert.deepEqual([notYet.status, notYet.body.code], [409, 'not_uploaded'], 'nothing landed yet: try again later');

  files.set(s.body.path, { bytes: new Uint8Array(await phonePhoto()), contentType: 'image/jpeg' });
  const c = await call(PRAC, { action: 'commit', leadId: NOA, uploadId: UP, stage: 'before', treatmentId: T_NOA, takenAt: '2026-10-08T09:00:00Z' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.photo.id, UP);
  const row = tables.client_photos[0];
  assert.deepEqual([row.business_id, row.lead_id, row.treatment_id, row.stage, row.by_user, row.width, row.height, row.path, row.taken_at],
    [B1, NOA, T_NOA, 'before', PRAC, 1365, 2048, photoPath(B1, NOA, UP), '2026-10-08T09:00:00.000Z']);
  assert.ok(!files.has(incomingPath(B1, NOA, UP)), 'the original (with its GPS) is removed');
  const kept = files.get(photoPath(B1, NOA, UP))!;
  assert.equal(kept.contentType, 'image/webp');
  assert.equal((await sharp(kept.bytes).metadata()).exif, undefined, 'what is stored has no EXIF');

  const again = await call(PRAC, { action: 'commit', leadId: NOA, uploadId: UP, stage: 'before', treatmentId: T_NOA });
  assert.deepEqual([again.status, again.body.photo.id, tables.client_photos.length], [200, UP, 1], 'a retry on a weak network: the same photo, not a second');
});

test('a photo is hung only on this customer, in this business', async () => {
  files.set(incomingPath(B1, NOA, UP), { bytes: new Uint8Array(await phonePhoto()), contentType: 'image/jpeg' });
  const wrong = await call(OWN, { action: 'commit', leadId: NOA, uploadId: UP, stage: 'after', treatmentId: T_DANA });
  assert.equal(wrong.status, 400, 'Dana’s treatment on Noa’s photo');
  assert.equal((await call(OWN, { action: 'commit', leadId: NOA, uploadId: UP, stage: 'side' })).status, 400, 'before / after / process only');
  assert.equal((await call(OWN, { action: 'commit', leadId: NOA, uploadId: 'x/../y', stage: 'after' })).status, 400);
  assert.equal((await call(OTHER, { action: 'commit', leadId: NOA, uploadId: UP, stage: 'after' })).status, 404, 'B’s owner on A’s customer');
  assert.equal(tables.client_photos.length, 0);

  files.set(incomingPath(B1, DANA, UP), { bytes: new TextEncoder().encode('<svg onload=alert(1)>'), contentType: 'image/jpeg' });
  const notImage = await call(OWN, { action: 'commit', leadId: DANA, uploadId: UP, stage: 'after' });
  assert.deepEqual([notImage.status, notImage.body.code], [400, 'not_image'], 'what the bytes are, not what the phone said');
  assert.ok(!files.has(incomingPath(B1, DANA, UP)), 'a refused file is removed');
});

test('a business has a daily limit', async () => {
  const today = new Date().toISOString();
  for (let i = 0; i < DAILY_PHOTO_LIMIT; i++) tables.client_photos.push({ id: `p${i}`, business_id: B1, lead_id: DANA, created_at: today });
  tables.client_photos.push({ id: 'b2', business_id: B2, lead_id: MICHAL, created_at: today });
  files.set(incomingPath(B1, NOA, UP), { bytes: new Uint8Array(await phonePhoto()), contentType: 'image/jpeg' });
  const r = await call(OWN, { action: 'commit', leadId: NOA, uploadId: UP, stage: 'before' });
  assert.deepEqual([r.status, r.body.code], [429, 'quota']);
});

test('opening: the view is logged first, then a 5-minute link — never for another business, never without the log', async () => {
  tables.client_photos.push(
    { id: UP, business_id: B1, lead_id: NOA, path: photoPath(B1, NOA, UP), stage: 'before', taken_at: '2026-10-01T00:00:00Z' },
    { id: 'b2-photo', business_id: B2, lead_id: MICHAL, path: photoPath(B2, MICHAL, 'b2-photo'), stage: 'before', taken_at: '2026-10-01T00:00:00Z' });
  const r = await call(PRAC, { action: 'open', photoIds: [UP] });
  assert.deepEqual(Object.keys(r.body.urls), [UP]);
  assert.match(r.body.urls[UP], /ttl=300$/, 'a link of 5 minutes');
  assert.deepEqual(events, [`log:${UP}`, `sign:${photoPath(B1, NOA, UP)}`], 'the log line before the link');
  assert.deepEqual(views, [{ user: PRAC, business: B1, id: UP }]);

  events.length = 0;
  const other = await call(OTHER, { action: 'open', photoIds: [UP] });
  assert.deepEqual([other.status, other.body.urls, events], [200, {}, []], 'B asks for A’s photo: nothing signed, nothing told');
  assert.equal((await call(OWN, { action: 'open', photoIds: ['../x'] })).status, 400);

  logFails = true;
  const noLog = await call(OWN, { action: 'open', photoIds: [UP] });
  assert.deepEqual([noLog.body.urls, events], [{}, []], 'when the log can not be written, there is no link');
});

test('changing a photo: its stage and treatment — of the same customer only', async () => {
  tables.client_photos.push({ id: UP, business_id: B1, lead_id: NOA, treatment_id: null, session_id: null, path: photoPath(B1, NOA, UP), stage: 'before', taken_at: '2026-10-01T00:00:00Z' });
  const ok = await call(PRAC, { action: 'update', photoId: UP, stage: 'after', treatmentId: T_NOA });
  assert.deepEqual([ok.status, ok.body.photo.stage, ok.body.photo.treatment_id], [200, 'after', T_NOA]);
  assert.equal((await call(PRAC, { action: 'update', photoId: UP, treatmentId: T_DANA })).status, 400);
  assert.equal((await call(PRAC, { action: 'update', photoId: UP, marketingOk: true })).status, 400, 'marketing consent is not set here');
  assert.equal((await call(OTHER, { action: 'update', photoId: UP, stage: 'before' })).status, 404);
  assert.equal(tables.client_photos[0].path, photoPath(B1, NOA, UP), 'the file never moves');

  const t = await call(PRAC, { action: 'treatment', leadId: NOA, title: '  מיקרובליידינג  ', area: 'גבות' });
  assert.deepEqual([t.status, t.body.treatment.title, t.body.treatment.area], [200, 'מיקרובליידינג', 'גבות']);
  assert.equal(tables.client_treatments.at(-1).business_id, B1);
  assert.equal((await call(PRAC, { action: 'treatment', leadId: NOA, title: ' ' })).status, 400);
  assert.equal((await call(OTHER, { action: 'treatment', leadId: NOA, title: 'x' })).status, 404);
});
