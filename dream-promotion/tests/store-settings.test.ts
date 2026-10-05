/**
 * The store's rules in the dashboard (Dream Commerce 2.55, src/features/store/store.ts): the domain the owner types, the
 * WhatsApp number, the Google codes, the checklist's refusal, the policy drafts, and what a collection, a page and a menu
 * may hold — the same rules as migration 20261005003400 (tests/sql/commerce-store.check.sql checks the database side).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allTags, cleanGa4, cleanGscCode, collectionProblem, domainRows, hasPlaceholders, linkOk, linkTargets, matchesTags, menuProblem,
  missingFromError, normalizeDomain, normalizeWhatsapp, pageProblem, policyDraft, policySlug, REQUIRED_POLICIES, suggestSlug,
  toCollection, toDomain, toStore, validEmail, validPhone, CHECKLIST,
} from '../src/features/store/store';

test('a domain: what the owner types → the name itself; a bare name gets www beside it', () => {
  const ok = (s: string) => { const r = normalizeDomain(s); assert.ok(r.ok, s); return r as { ok: true; domain: string; bare: boolean }; };
  assert.deepEqual(ok('https://followmecollection.com/'), { ok: true, domain: 'followmecollection.com', bare: true });
  assert.deepEqual(ok('  WWW.FollowMeCollection.com/products?x=1 '), { ok: true, domain: 'followmecollection.com', bare: true }, 'www, path and case');
  assert.deepEqual(ok('http://shop.example.com:8080/'), { ok: true, domain: 'shop.example.com', bare: false }, 'a subdomain stands alone');
  assert.deepEqual(ok('example.co.il'), { ok: true, domain: 'example.co.il', bare: true }, 'co.il is Israel\'s second level');
  assert.deepEqual(ok('shop.example.co.il'), { ok: true, domain: 'shop.example.co.il', bare: false });
  assert.equal(ok('שקיות.co.il').domain, 'xn--9dbh5bhi.co.il', 'a Hebrew name in punycode (as Python\'s idna gives it)');
  assert.equal(ok('example.com.').domain, 'example.com', 'the root dot');
  for (const bad of ['', 'followme', 'http://', '1.2.3.4', 'localhost', 'my-store.vercel.app', 'x.supabase.co', '-bad.com', 'bad-.com', 'a..com', 'example.123', 'a b.com']) {
    const r = normalizeDomain(bad);
    assert.ok(!r.ok, bad);
    assert.match((r as { error: string }).error, /[א-ת]/, 'a sentence in Hebrew');
  }
  assert.deepEqual(domainRows({ domain: 'followmecollection.com', bare: true }), [
    { domain: 'followmecollection.com', isPrimary: true }, { domain: 'www.followmecollection.com', isPrimary: false }]);
  assert.deepEqual(domainRows({ domain: 'shop.example.com', bare: false }), [{ domain: 'shop.example.com', isPrimary: true }]);
});

test('contact: WhatsApp in the international form; phone and e-mail as the database checks them', () => {
  assert.deepEqual(normalizeWhatsapp('050-123-4567'), { ok: true, value: '972501234567' });
  assert.deepEqual(normalizeWhatsapp('+972 50 1234567'), { ok: true, value: '972501234567' });
  assert.deepEqual(normalizeWhatsapp('00972501234567'), { ok: true, value: '972501234567' }, '00 is the international prefix, not a local 0');
  assert.deepEqual(normalizeWhatsapp(''), { ok: true, value: '' }, 'empty = no WhatsApp button');
  assert.ok(!normalizeWhatsapp('123').ok);
  assert.ok(!normalizeWhatsapp('0'.repeat(20)).ok);
  assert.ok(validPhone('') && validPhone('03-1234567') && validPhone('+972 (3) 123-4567'));
  assert.ok(!validPhone('12') && !validPhone('03-1234567 שלוחה 2'));
  assert.ok(validEmail('') && validEmail('a@b.co'));
  assert.ok(!validEmail('a@b') && !validEmail('a b@c.com') && !validEmail(`${'a'.repeat(120)}@b.co`));
});

test('Google: a GA4 measurement id, and Search Console\'s code — from the whole meta tag too', () => {
  assert.equal(cleanGa4(' g-abc1234 '), 'G-ABC1234');
  assert.equal(cleanGa4(''), '');
  assert.equal(cleanGa4('UA-12345-1'), null, 'the old Universal Analytics id is not GA4');
  assert.equal(cleanGscCode('<meta name="google-site-verification" content="AbC_def-1234567890xyz" />'), 'AbC_def-1234567890xyz');
  assert.equal(cleanGscCode("content='AbC_def-1234567890xyz'"), 'AbC_def-1234567890xyz');
  assert.equal(cleanGscCode('AbC_def-1234567890xyz'), 'AbC_def-1234567890xyz');
  assert.equal(cleanGscCode(''), '');
  assert.equal(cleanGscCode('<script>alert(1)</script>'), null);
  assert.equal(cleanGscCode('short'), null);
});

test('the checklist: the database\'s refusal → what is missing; every item leads to where it is completed', () => {
  assert.deepEqual(missingFromError('store_not_ready: accessibility,domain'), ['accessibility', 'domain']);
  assert.deepEqual(missingFromError('new row violates check constraint'), []);
  assert.deepEqual(CHECKLIST.map((c) => c.code), ['legal', 'contact', 'returns', 'privacy', 'accessibility', 'domain', 'product']);
  assert.equal(CHECKLIST.find((c) => c.code === 'legal')!.href, '/finance/settings', 'the legal details are the documents\' (one place)');
  for (const p of REQUIRED_POLICIES) assert.equal(CHECKLIST.find((c) => c.code === p)!.href, `/store/pages?policy=${p}`);
});

test('policies: a draft to start from, with "[…]" for what only the business knows — never "approved"', () => {
  const b = { name: 'FollowMe', phone: '03-1234567', email: 'hi@followme.test', address: '' };
  for (const kind of ['returns', 'privacy', 'accessibility', 'terms', 'shipping'] as const) {
    const d = policyDraft(kind, b);
    assert.ok(d.title && d.body, kind);
    assert.ok(hasPlaceholders(d.body), `${kind}: has a bracket to fill`);
    // outside the brackets (the notes to the business, which block publishing) nothing is claimed
    assert.doesNotMatch(d.body.replace(/\[[^\]]*\]/g, ''), /מאושר|אושר על ידי|עומד בתקן|האתר נגיש/, `${kind}: claims nothing`);
  }
  assert.match(policyDraft('returns', b).body, /03-1234567/);
  assert.match(policyDraft('returns', { name: 'X' }).body, /\[פרטי קשר\]/, 'no contact → a bracket');
  assert.match(policyDraft('accessibility', b).body, /5568/);
  assert.ok(!hasPlaceholders('פסקה רגילה.\n\n## כותרת\n- רשימה'));
  assert.ok(!hasPlaceholders('[x]'), 'one letter in brackets is not a placeholder');
  assert.equal(policySlug('returns'), 'policy-returns');
});

test('a collection: a name, a free address (not "all"), a tag for an automatic one', () => {
  const base = { title: 'שקיות נייר', slug: 'שקיות-נייר', description: '', kind: 'manual' as const, tags: [], seoTitle: '', seoDescription: '' };
  assert.equal(collectionProblem(base, []), null);
  assert.match(collectionProblem({ ...base, title: '  ' }, [])!, /שם/);
  assert.match(collectionProblem({ ...base, slug: 'all' }, [])!, /all/);
  assert.match(collectionProblem({ ...base, slug: 'שקיות נייר' }, [])!, /אותיות, ספרות ומקפים/);
  assert.match(collectionProblem(base, ['שקיות-נייר'])!, /בשימוש/);
  assert.match(collectionProblem({ ...base, kind: 'auto' }, [])!, /תגית/);
  assert.equal(collectionProblem({ ...base, kind: 'auto', tags: ['נייר'] }, []), null);
  assert.match(collectionProblem({ ...base, seoTitle: 'x'.repeat(121) }, [])!, /גוגל/);
  assert.equal(suggestSlug('שקיות נייר!', [], 'קולקציה'), 'שקיות-נייר');
  assert.equal(suggestSlug('שקיות נייר', ['שקיות-נייר'], 'קולקציה'), 'שקיות-נייר-2');
  assert.equal(suggestSlug('All', [], 'קולקציה'), 'all-2', '"all" is taken by every product');
  assert.equal(suggestSlug('!!!', [], 'קולקציה'), 'קולקציה');
  assert.ok(matchesTags(['נייר', 'קראפט'], ['קראפט']) && !matchesTags(['בד'], ['נייר']) && !matchesTags([], []));
  assert.deepEqual(allTags([{ tags: ['נייר', 'בד'] }, { tags: ['בד', 'אקו'] }]), ['אקו', 'בד', 'נייר']);
});

test('a page: a title, a free address; a policy is not published with "[…]" left, nor an empty page', () => {
  const page = { kind: 'page' as const, title: 'אודות', slug: 'אודות', body: 'טקסט', seoTitle: '', seoDescription: '', published: true };
  assert.equal(pageProblem(page, []), null);
  assert.match(pageProblem(page, ['אודות'])!, /בשימוש/);
  assert.match(pageProblem({ ...page, body: '  ' }, [])!, /ריק/);
  assert.equal(pageProblem({ ...page, body: '', published: false }, []), null, 'an empty draft may be saved');
  assert.match(pageProblem({ ...page, body: 'x'.repeat(30001) }, [])!, /ארוך/);
  const policy = { ...page, kind: 'policy' as const, slug: policySlug('returns'), body: policyDraft('returns', { name: 'X' }).body };
  assert.match(pageProblem(policy, [])!, /סוגריים/);
  assert.equal(pageProblem({ ...policy, published: false }, []), null, 'a draft with brackets may be saved');
  assert.equal(pageProblem({ ...page, body: 'ראו [קישור] באתר', published: true }, []), null, 'a page of the business\'s own is not checked for brackets');
});

test('menus: the database\'s link rule, and the store\'s own addresses to choose from', () => {
  assert.ok(linkOk({ label: 'בית', href: '/' }) && linkOk({ label: 'שקיות', href: '/collections/שקיות-נייר' }) && linkOk({ label: 'אינסטגרם', href: 'https://instagram.com/x' }));
  for (const bad of [
    { label: '', href: '/' }, { label: 'x'.repeat(41), href: '/' }, { label: 'x', href: '' }, { label: 'x', href: '//evil.com' },
    { label: 'x', href: 'http://a.com' }, { label: 'x', href: 'javascript:alert(1)' }, { label: 'x', href: '/a b' }, { label: 'x', href: '/"x' },
    { label: 'x', href: `/${'a'.repeat(300)}` },
  ]) assert.ok(!linkOk(bad), JSON.stringify(bad));
  assert.equal(menuProblem([{ label: 'בית', href: '/' }]), null);
  assert.match(menuProblem([{ label: 'בית', href: '/' }, { label: '', href: '/' }])!, /קישור 2/);
  assert.match(menuProblem([{ label: 'אתר', href: 'http://x.com' }])!, /https/);
  assert.match(menuProblem(Array.from({ length: 31 }, () => ({ label: 'x', href: '/' })))!, /30/);
  const targets = linkTargets(
    [{ title: 'שקיות נייר', slug: 'שקיות-נייר', publishOnline: true }, { title: 'טיוטה', slug: 'טיוטה', publishOnline: false }],
    [{ kind: 'page', policy: null, slug: 'אודות', title: 'אודות', published: true }, { kind: 'policy', policy: 'returns', slug: 'policy-returns', title: 'ביטולים', published: false }]);
  assert.deepEqual(targets.map((t) => t.href), ['/', '/collections/all', '/collections', '/search', '/collections/שקיות-נייר', '/collections/טיוטה', '/pages/אודות', '/policies/returns']);
  assert.equal(targets.find((t) => t.href === '/collections/טיוטה')!.note, 'לא באתר');
  for (const t of targets) assert.ok(linkOk({ label: t.label, href: t.href }), t.href);
});

test('rows from the database → the screen\'s shape (missing values are empty, never undefined)', () => {
  const s = toStore({ id: 's', business_id: 'b', name: 'X', status: 'draft' });
  assert.equal(s.whatsapp, ''); assert.equal(s.showStockCount, false); assert.equal(s.template, 'bags');
  const d = toDomain({ id: 'd', store_id: 's', domain: 'a.com', is_primary: true, vercel: null });
  assert.deepEqual(d.vercel, {}); assert.equal(d.status, 'pending');
  const c = toCollection({ id: 'c', title: 'T', slug: 't', kind: 'auto', rules: { tags: ['א', 3] }, position: '2' },
    [{ collection_id: 'c', item_id: 'i2', position: 1 }, { collection_id: 'c', item_id: 'i1', position: 0 }, { collection_id: 'z', item_id: 'i9', position: 0 }]);
  assert.deepEqual(c.tags, ['א'], 'only text tags');
  assert.deepEqual(c.items.map((x) => x.itemId), ['i1', 'i2'], 'in their order, only this collection\'s');
  assert.equal(c.position, 2);
});
