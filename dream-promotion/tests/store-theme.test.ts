/**
 * The contract between the dashboard's "עיצוב" and the storefront (Dream Commerce 2.55). The two apps never import each
 * other; this test reads both: the dashboard's copy of the template is the storefront's template, every field the editor
 * offers is one the storefront accepts (same kind, same length), and what the editor saves comes back from the storefront's
 * resolveTheme unchanged. The storefront's code runs in its own process, with its own settings (storefront/node_modules is
 * needed: `npm ci` in storefront/). Also: the preview link's format (both apps sign the same vector) and the DNS records.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BAGS, SECTION_DEFS, contrast, draftErrors, draftOf, fieldError, settingsOf, type Draft } from '../src/features/store/theme-fields';
import { makePreviewToken, previewUrl, PREVIEW_SECONDS } from '../src/features/store/preview-token';
import { recordsFor, vercelEnv, wwwRecord } from '../src/features/store/vercel';

const STOREFRONT = fileURLToPath(new URL('../../storefront/', import.meta.url));

/** run a snippet with the storefront's own TypeScript settings ("@/…" is the storefront's src) */
function inStorefront(code: string, input = ''): any {
  const tsx = `${STOREFRONT}node_modules/.bin/tsx`;
  assert.ok(existsSync(tsx), 'storefront/node_modules is missing — run `npm ci` in storefront/ first');
  const r = spawnSync(tsx, ['-e', code], { cwd: STOREFRONT, input, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('the template: the dashboard\'s copy is the storefront\'s "שקיות ממותגות"', async () => {
  const theirs = (await import(`${STOREFRONT}src/templates/bags.ts`)).BAGS;
  assert.deepEqual(BAGS, theirs);
});

test('every field the editor offers is one the storefront accepts — same kind, same length — and none is missing', () => {
  const schema = inStorefront(`import { SCHEMA } from './src/lib/theme.ts'; console.log(JSON.stringify(SCHEMA));`) as Record<string, Record<string, any>>;
  const kindOf: Record<string, (f: any) => boolean> = {
    text: (f) => f.kind === 'text', longtext: (f) => f.kind === 'longtext', link: (f) => f.kind === 'href', image: (f) => f.kind === 'image',
    number: (f) => f.kind === 'int' && f.min === 2 && f.max === 12, side: (f) => f.kind === 'choice' && f.values.join() === 'start,end',
    collection: (f) => f.kind === 'slug', kitpick: (f) => f.kind === 'int' && f.min === 1 && f.max === 2,
  };
  assert.deepEqual(Object.keys(SECTION_DEFS).sort(), Object.keys(schema).sort(), 'the same kinds of sections');
  for (const [type, def] of Object.entries(SECTION_DEFS)) {
    const theirs = schema[type];
    const ours = [...def.fields.map((f) => f.key), ...(def.list ? [def.list.key] : [])];
    assert.deepEqual(ours.sort(), Object.keys(theirs).sort(), `${type}: the same fields`);
    for (const f of def.fields) {
      assert.ok(kindOf[f.kind](theirs[f.key]), `${type}.${f.key}: ${f.kind} vs ${JSON.stringify(theirs[f.key])}`);
      if (f.kind === 'text' || f.kind === 'longtext') assert.equal(f.max, theirs[f.key].max, `${type}.${f.key}: the same length`);
    }
    if (def.list) {
      const l = theirs[def.list.key];
      assert.equal(l.kind, 'list'); assert.equal(def.list.max, l.max, `${type}: as many rows`);
      assert.deepEqual(def.list.fields.map((f) => f.key).sort(), Object.keys(l.item).sort());
      for (const f of def.list.fields) assert.equal(f.max, l.item[f.key].max, `${type}.items.${f.key}`);
    }
  }
});

test('what the editor saves comes back from the storefront unchanged (order, hidden, texts, links, colours)', () => {
  const d = draftOf('bags', {});
  const edited: Draft = {
    ...d,
    colors: { ...d.colors, primary: '#123456', accent: '#aa3300' },
    radius: 'large',
    announcement: { enabled: false, text: 'משלוח חינם מעל 300 ₪', href: 'whatsapp' },
    product: { related: false, whatsapp: true },
    sections: [...d.sections].reverse().map((s) => s.id === 'hero'
      ? { ...s, settings: { ...s.settings, title: 'כותרת חדשה', primaryHref: '/collections/שקיות-נייר', image: 'https://cdn.test/a.webp' } }
      : s.id === 'faq' ? { ...s, hidden: false, settings: { ...s.settings, items: [{ q: 'כמה זמן?', a: 'שבוע.' }] } } : s),
  };
  assert.deepEqual(draftErrors(edited), []);
  const saved = settingsOf(edited);
  const back = inStorefront(`import { resolveTheme } from './src/lib/theme.ts'; import { readFileSync } from 'node:fs';
    console.log(JSON.stringify(resolveTheme('bags', JSON.parse(readFileSync(0, 'utf8')))));`, JSON.stringify(saved));
  assert.deepEqual(back.sections.map((s: any) => [s.id, s.hidden]), saved.sections.map((s) => [s.id, s.hidden]));
  for (const s of saved.sections) assert.deepEqual(back.sections.find((x: any) => x.id === s.id).settings, s.settings, s.id);
  assert.equal(back.colors.primary, '#123456'); assert.equal(back.colors.accent, '#aa3300');
  assert.equal(back.radius, 'large');
  assert.deepEqual(back.announcement, edited.announcement);
  assert.deepEqual(back.product, edited.product);
  // and the editor opens what it saved as it was
  assert.deepEqual(draftOf('bags', saved), edited);
});

test('the editor\'s checks: links, pictures, numbers, lengths, unreadable colours; a saved value it does not know is dropped', () => {
  const link = { key: 'h', label: 'קישור', kind: 'link' as const };
  for (const ok of ['', '/', '/collections/all', 'https://x.co/a', 'whatsapp', '#contact']) assert.equal(fieldError(link, ok), null, ok);
  for (const bad of ['//evil.com', 'http://x.co', 'javascript:alert(1)', '/a b', 'collections', `/${'a'.repeat(300)}`]) assert.ok(fieldError(link, bad), bad);
  assert.ok(fieldError({ key: 'i', label: 'תמונה', kind: 'image' }, 'http://x.co/a.png'));
  assert.equal(fieldError({ key: 'n', label: 'כמה', kind: 'number' }, 8), null);
  assert.ok(fieldError({ key: 'n', label: 'כמה', kind: 'number' }, 13));
  assert.ok(fieldError({ key: 't', label: 'כותרת', kind: 'text', max: 5 }, '123456'));
  const d = draftOf('bags', {});
  assert.deepEqual(draftErrors(d), [], 'the template as it is has no problem');
  assert.ok(contrast(BAGS.colors.text, BAGS.colors.background) >= 4.5, 'the template reads');
  assert.equal(draftErrors({ ...d, colors: { ...d.colors, text: '#f0f0f0', background: '#ffffff' } }).length, 1);
  const odd = draftOf('bags', { colors: { primary: 'red', accent: '#ABCDEF' }, radius: 'huge', sections: [{ id: 'nope' }, { id: 'faq', hidden: false }, { id: 'faq', hidden: true }], announcement: { enabled: 'yes' } });
  assert.equal(odd.colors.primary, BAGS.colors.primary, 'not a colour → the template\'s');
  assert.equal(odd.colors.accent, '#abcdef');
  assert.equal(odd.radius, BAGS.radius);
  assert.equal(odd.sections[0].id, 'faq'); assert.equal(odd.sections[0].hidden, false, 'the first of a repeated section counts');
  assert.equal(odd.sections.length, BAGS.sections.length, 'an unknown section is dropped, a missing one comes back');
  assert.equal(odd.announcement.enabled, BAGS.announcement.enabled);
});

test('a preview link: the same signature as the storefront checks (one shared vector), for one hour, on the store\'s address', () => {
  const store = '00000000-0000-4000-8000-000000000001', secret = 'k'.repeat(32);
  const vector = `${store}.2000000000.etcj1FtX2uQt0wWYJMeWvRvUyrqRpC_n-dlyxhzqymo`;
  assert.equal(makePreviewToken(store, secret, 2_000_000_000), vector, 'storefront/tests/unit/storefront.test.ts verifies this same token');
  assert.equal(makePreviewToken(store, secret, 2_000_000_000.9), vector, 'whole seconds');
  assert.notEqual(makePreviewToken(store, 'x'.repeat(32), 2_000_000_000), vector);
  assert.equal(PREVIEW_SECONDS, 3600);
  assert.equal(previewUrl('https://followmecollection.com', 'a.b.c'), 'https://followmecollection.com/?preview=a.b.c');
  assert.equal(previewUrl('https://sf.vercel.app/', 'a.b.c'), 'https://sf.vercel.app/?preview=a.b.c');
});

test('the storefront verifies the dashboard\'s token (run in the storefront\'s own code)', () => {
  const store = '00000000-0000-4000-8000-000000000001', secret = 'e'.repeat(32);
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_SECONDS;
  const token = makePreviewToken(store, secret, exp);
  const r = inStorefront(`import { verifyPreviewToken } from './src/lib/preview.ts'; import { readFileSync } from 'node:fs';
    const { token, secret } = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify({ good: verifyPreviewToken(token, secret), other: verifyPreviewToken(token, 'f'.repeat(32)) }));`, JSON.stringify({ token, secret }));
  assert.deepEqual(r.good, { store, expires: exp });
  assert.equal(r.other, null);
});

test('DNS records: what Vercel answers; its documented defaults only when it answered nothing (marked as such)', () => {
  assert.equal(vercelEnv({}), null, 'no token → nothing is called');
  assert.deepEqual(vercelEnv({ VERCEL_API_TOKEN: 't', VERCEL_STOREFRONT_PROJECT: 'p' }), { token: 't', project: 'p', team: undefined });
  assert.deepEqual(recordsFor('followmecollection.com', true), [{ type: 'A', name: '@', value: '76.76.21.21', fromVercel: false }]);
  assert.deepEqual(recordsFor('shop.example.com', false), [{ type: 'CNAME', name: 'shop', value: 'cname.vercel-dns.com', fromVercel: false }]);
  const config = { recommendedIPv4: [{ rank: 1, value: ['216.150.1.1'] }], recommendedCNAME: [{ rank: 1, value: 'abc.vercel-dns-017.com.' }] };
  const added = { verification: [{ type: 'TXT', domain: '_vercel.followmecollection.com', value: 'vc-domain-verify=x' }, { type: 'X', domain: 'a', value: 'b' }] };
  assert.deepEqual(recordsFor('followmecollection.com', true, added, config), [
    { type: 'A', name: '@', value: '216.150.1.1', fromVercel: true },
    { type: 'TXT', name: '_vercel', value: 'vc-domain-verify=x', fromVercel: true },
  ]);
  assert.deepEqual(wwwRecord(config), { type: 'CNAME', name: 'www', value: 'abc.vercel-dns-017.com', fromVercel: true });
  assert.deepEqual(wwwRecord(), { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com', fromVercel: false });
});
