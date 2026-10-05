/**
 * Product pictures on the server (Dream Commerce 2.54, /api/store/media) with an in-memory database and storage (the real
 * route code runs): only a member who may write, only items of the business worked in now, only files that really landed
 * in storage with the right type and size; delete and purge remove the files too — never another business's.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { cleanSizes, fitWithin, inBusiness, pickSize, plannedSizes } from '../src/features/catalog/images';
import { resetRateLimits } from '../src/lib/server/rate-limit';

const OWN = 'user-own', CASH = 'user-cash', VIEW = 'user-view', OTHER = 'user-other';
const B1 = '00000000-0000-4000-8000-00000000b001', B2 = '00000000-0000-4000-8000-00000000b002';
const SHIRT = '00000000-0000-4000-8000-0000000000f1', MASK = '00000000-0000-4000-8000-0000000000f2', HAT = '00000000-0000-4000-8000-0000000000f3';
const VS = '00000000-0000-4000-8000-0000000003a1', VMASK = '00000000-0000-4000-8000-0000000003a2';
const tables: Record<string, any[]> = {};
const files = new Map<string, { size: number; mimetype: string }>();
const current: Record<string, string> = { [OWN]: B1, [CASH]: B1, [VIEW]: B1, [OTHER]: B2 };

function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  files.clear();
  resetRateLimits();
  Object.assign(tables, {
    profiles: [OWN, CASH, VIEW, OTHER].map((id) => ({ id, is_super_admin: false })),
    businesses: [{ id: B1, status: 'active', paid_until: null, grace_days: 0 }, { id: B2, status: 'active', paid_until: null, grace_days: 0 }],
    business_members: [
      { business_id: B1, user_id: OWN, role: 'owner', access: 'full' }, { business_id: B1, user_id: CASH, role: 'editor', access: 'register' },
      { business_id: B1, user_id: VIEW, role: 'viewer', access: 'full' }, { business_id: B2, user_id: OTHER, role: 'owner', access: 'full' }],
    catalog_items: [{ id: SHIRT, business_id: B1, name: 'חולצה' }, { id: HAT, business_id: B1, name: 'כובע' }, { id: MASK, business_id: B2, name: 'מסכה' }],
    catalog_variants: [{ id: VS, item_id: SHIRT, business_id: B1, option1: 'S' }, { id: VMASK, item_id: MASK, business_id: B2, option1: 'ורוד' }],
    catalog_media: [],
  });
}
const storage = {
  from: (bucket: string) => ({
    createSignedUploadUrl: async (path: string) => ({ data: { token: `tok:${path}`, path, signedUrl: `https://sb.test/upload/${path}` }, error: null }),
    list: async (folder: string) => ({
      data: [...files.entries()].filter(([p]) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/'))
        .map(([p, m]) => ({ name: p.slice(folder.length + 1), metadata: m })), error: null,
    }),
    remove: async (paths: string[]) => { for (const p of paths) files.delete(p); return { data: [], error: null }; },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://sb.test/storage/v1/object/public/${bucket}/${path}` } }),
  }),
};
before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    from: (t: string) => fakeDb(tables).from(t),
    auth: { getUser: async (t: string) => ({ data: { user: [OWN, CASH, VIEW, OTHER].includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string, a: { uid: string }) => ({ data: fn === 'business_for_user' ? current[a.uid] ?? null : null, error: null }),
    storage,
  };
});
beforeEach(reset);

const call = async (user: string | null, body: unknown) => {
  const { POST } = await import('../src/app/api/store/media/route');
  const r = await POST(new Request('http://x/api/store/media', { method: 'POST', headers: user ? { authorization: `Bearer ${user}` } : {}, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
/** the browser's part: put every signed size into storage */
const upload = (uploads: { path: string }[], type = 'image/webp', size = 40_000) => { for (const u of uploads) files.set(u.path, { size, mimetype: type }); };

test('the sizes: 400 always, bigger only when the picture is bigger — never enlarged', () => {
  assert.deepEqual(plannedSizes(4000, 3000).map((s) => [s.size, s.w, s.h]), [[400, 400, 300], [800, 800, 600], [1600, 1600, 1200]]);
  assert.deepEqual(plannedSizes(600, 900).map((s) => [s.size, s.w, s.h]), [[400, 267, 400], [800, 533, 800], [1600, 600, 900]], 'a 900px picture: its own size as the biggest');
  assert.deepEqual(plannedSizes(600, 700).map((s) => [s.size, s.w, s.h]), [[400, 343, 400], [800, 600, 700]], 'a 700px picture: no second copy of itself');
  assert.deepEqual(plannedSizes(300, 200).map((s) => s.size), [400], 'a small picture: one size, as it is');
  assert.deepEqual(fitWithin(300, 200, 400), { w: 300, h: 200 });
  assert.equal(pickSize({ url: 'u', sizes: { 400: 'a', 1600: 'c', 800: 'b' } }, 500), 'b');
  assert.equal(pickSize({ url: 'u', sizes: { 400: 'a' } }, 1200), 'a', 'the biggest there is');
  assert.equal(pickSize({ url: 'u', sizes: {} }, 400), 'u');
  assert.deepEqual(cleanSizes([1600, 400, 800]), [400, 800, 1600]);
  for (const bad of [[800], [400, 400], [400, 999], [], 'x', [400, 800, 1600, 1600]]) assert.equal(cleanSizes(bad), null, JSON.stringify(bad));
  assert.ok(inBusiness(`${B1}/${SHIRT}/x`, B1));
  assert.ok(!inBusiness(`${B2}/${MASK}/x`, B1) && !inBusiness(`${B1}/../${B2}/x`, B1) && !inBusiness('x/y', 'not-a-uuid'));
});

test('who may upload: a signed-in member who writes, in the business they work in', async () => {
  const sign = { action: 'sign', itemId: SHIRT, sizes: [400, 800, 1600], type: 'image/webp' };
  assert.equal((await call(null, sign)).status, 401);
  assert.equal((await call('stranger', sign)).status, 401);
  const c = await call(CASH, sign);
  assert.equal(c.status, 403); assert.equal(c.body.code, 'register_only', 'a cashier sells, never edits the catalog');
  const v = await call(VIEW, sign);
  assert.equal(v.status, 403); assert.equal(v.body.code, 'view_only');
  assert.equal((await call(OTHER, sign)).status, 404, 'another business\'s item does not exist for them');
  assert.equal((await call(OWN, { ...sign, itemId: MASK })).status, 404, 'nor Beauty\'s item for Fashion');
  assert.equal((await call(OWN, { ...sign, sizes: [800, 1600] })).status, 400, 'the 400 size is always made');
  assert.equal((await call(OWN, { ...sign, type: 'image/png' })).status, 400, 'webp or jpeg only (the bucket\'s own rule)');
});

test('a picture: signed links in the business\'s folder, registered only after the files landed', async () => {
  const s = await call(OWN, { action: 'sign', itemId: SHIRT, sizes: [400, 800, 1600], type: 'image/webp' });
  assert.equal(s.status, 200);
  assert.equal(s.body.uploads.length, 3);
  for (const u of s.body.uploads) assert.ok(u.path.startsWith(`${B1}/${SHIRT}/${s.body.uploadId}/`), u.path);
  const reg = { action: 'register', itemId: SHIRT, uploadId: s.body.uploadId, sizes: [400, 800, 1600], type: 'image/webp', width: 1600, height: 1200, alt: '  חולצה לבנה ' };
  const missing = await call(OWN, reg);
  assert.equal(missing.status, 400, 'nothing uploaded yet');
  assert.equal(tables.catalog_media.length, 0);

  upload(s.body.uploads.slice(0, 2));
  assert.equal((await call(OWN, reg)).status, 400, 'one size is missing');
  assert.equal(files.size, 0, 'a half upload is removed');

  upload(s.body.uploads, 'text/html');
  assert.equal((await call(OWN, reg)).status, 400, 'storage says it is not a picture');
  assert.equal(files.size, 0);

  upload(s.body.uploads);
  const ok = await call(OWN, reg);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const m = tables.catalog_media[0];
  assert.equal(m.business_id, B1);
  assert.equal(m.item_id, SHIRT);
  assert.equal(m.position, 0);
  assert.equal(m.alt, 'חולצה לבנה');
  assert.equal(m.url, `https://sb.test/storage/v1/object/public/store-media/${B1}/${SHIRT}/${s.body.uploadId}/1600.webp`, 'the main size is the biggest');
  assert.deepEqual(Object.keys(m.sizes).sort(), ['1600', '400', '800']);
  assert.equal(m.created_by, OWN);

  const other = await call(OWN, { ...reg, uploadId: s.body.uploadId, variantId: VMASK });
  assert.equal(other.status, 400, 'a variant of another item (another business\'s) is refused');
  const notUuid = await call(OWN, { ...reg, uploadId: '../../x' });
  assert.equal(notUuid.status, 400);
});

test('a variant\'s picture, the order, and the limit of pictures per product', async () => {
  const s = await call(OWN, { action: 'sign', itemId: SHIRT, sizes: [400], type: 'image/jpeg' });
  upload(s.body.uploads, 'image/jpeg');
  const r = await call(OWN, { action: 'register', itemId: SHIRT, uploadId: s.body.uploadId, sizes: [400], type: 'image/jpeg', variantId: VS });
  assert.equal(r.status, 200);
  assert.equal(tables.catalog_media[0].variant_id, VS);
  assert.ok(tables.catalog_media[0].url.endsWith('/400.jpg'));
  const s2 = await call(OWN, { action: 'sign', itemId: SHIRT, sizes: [400], type: 'image/webp' });
  upload(s2.body.uploads);
  await call(OWN, { action: 'register', itemId: SHIRT, uploadId: s2.body.uploadId, sizes: [400], type: 'image/webp' });
  assert.equal(tables.catalog_media[1].position, 1, 'the next picture comes after');
  for (let k = 2; k < 12; k++) tables.catalog_media.push({ id: `m${k}`, item_id: SHIRT, business_id: B1, position: k, path: `${B1}/${SHIRT}/x${k}` });
  const full = await call(OWN, { action: 'sign', itemId: SHIRT, sizes: [400], type: 'image/webp' });
  assert.equal(full.status, 409, 'up to 12 pictures');
});

test('delete and purge remove the files too — and never another business\'s', async () => {
  const s = await call(OWN, { action: 'sign', itemId: SHIRT, sizes: [400, 800], type: 'image/webp' });
  upload(s.body.uploads);
  await call(OWN, { action: 'register', itemId: SHIRT, uploadId: s.body.uploadId, sizes: [400, 800], type: 'image/webp' });
  const mine = tables.catalog_media[0];
  mine.id = '00000000-0000-4000-8000-0000000004d1'; // the database's ids are uuids (the in-memory one makes "catalog_media-1")
  const beauty = { id: '00000000-0000-4000-8000-0000000004d9', item_id: MASK, business_id: B2, path: `${B2}/${MASK}/u1`, position: 0 };
  tables.catalog_media.push(beauty);
  files.set(`${B2}/${MASK}/u1/400.webp`, { size: 10, mimetype: 'image/webp' });

  assert.equal((await call(OWN, { action: 'delete', mediaId: beauty.id })).status, 404, 'Beauty\'s picture is not found from Fashion');
  assert.ok(files.has(`${B2}/${MASK}/u1/400.webp`));
  assert.equal((await call(VIEW, { action: 'delete', mediaId: mine.id })).status, 403, 'a viewer deletes nothing');
  const d = await call(OWN, { action: 'delete', mediaId: mine.id });
  assert.equal(d.status, 200);
  assert.equal(tables.catalog_media.filter((x) => x.business_id === B1).length, 0);
  assert.equal([...files.keys()].filter((p) => p.startsWith(B1)).length, 0, 'its files are gone');

  const s2 = await call(OWN, { action: 'sign', itemId: HAT, sizes: [400], type: 'image/webp' });
  upload(s2.body.uploads);
  await call(OWN, { action: 'register', itemId: HAT, uploadId: s2.body.uploadId, sizes: [400], type: 'image/webp' });
  assert.equal((await call(OWN, { action: 'purge', itemId: MASK })).status, 404, 'Fashion can not purge Beauty\'s item');
  const p = await call(OWN, { action: 'purge', itemId: HAT });
  assert.equal(p.status, 200);
  assert.equal(p.body.deleted, 1);
  assert.equal(tables.catalog_media.filter((x) => x.item_id === HAT).length, 0);
  assert.deepEqual([...files.keys()], [`${B2}/${MASK}/u1/400.webp`], 'only Beauty\'s file is left');
});
