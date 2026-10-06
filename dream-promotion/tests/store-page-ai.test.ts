/**
 * ✨ AI for the site's pages and policies (2.59): the law of the store's country goes into a policy, the store's details come
 * from the server for the business the user works in (never from the browser, never another business's), and what comes back
 * is plain text with no claim nobody checked — a policy always keeps its lawyer line. The editor writes by itself only on an
 * empty page or one still holding "[…]".
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { cleanPageCopy, cleanShortCopy, copyClaims, factsText, LEGAL_CHECK, legalFacts, wantsAutoFill, wantsShortFill, type PageFacts } from '../src/features/store/page-ai';
import { storePagePrompt, storeTextPrompt } from '../src/lib/services/prompts';
import { pageFacts } from '../src/lib/server/page-facts';
import { hasPlaceholders, pageProblem } from '../src/features/store/store';

const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b1';
const tables: Record<string, any[]> = {
  profiles: [{ id: 'owner', is_super_admin: false }, { id: 'cashier', is_super_admin: false }, { id: 'other', is_super_admin: false }],
  business_members: [{ business_id: A, user_id: 'owner', access: 'full' }, { business_id: A, user_id: 'cashier', access: 'register' }, { business_id: B, user_id: 'other', access: 'full' }],
  stores: [
    { id: 's-a', business_id: A, name: 'FollowMe', address: 'המגנים 56 גן יבנה', phone: '0503566969', email: 'a@x.co', whatsapp: '972503566969', country: 'IL',
      description: 'שקיות ממותגות', checkout_enabled: true, delivery_enabled: true, delivery_price: 30, free_delivery_over: 300, delivery_note: 'כל הארץ',
      pickup_enabled: false, pickup_note: '', ga4_id: 'G-1', storefront_password: 'secret-pass' },
    { id: 's-b', business_id: B, name: 'Other', country: 'IL' },
  ],
  register_settings: [{ business_id: A, legal_name: 'פולו מי אופנה בע"מ', dealer_number: '515778223', company_number: '', entity_type: null }],
};
const memberOf: Record<string, string> = { owner: A, cashier: A, other: B };
before(() => { (globalThis as any).__DP_TEST_ADMIN_DB__ = { ...fakeDb(tables), rpc: async (_: string, a: any) => ({ data: memberOf[a.uid] ?? null, error: null }) }; });

test('Israel: a returns policy is written by the Consumer Protection Law — 14 days, 5% or ₪100, 4 months, the exceptions', () => {
  const r = legalFacts('IL', 'returns').join('\n');
  assert.match(r, /14 ימים/); assert.match(r, /5%/); assert.match(r, /100 ₪/); assert.match(r, /4 חודשים/);
  assert.match(r, /שיוצרו במיוחד/, 'a product made for the customer (a printed bag) is an exception');
  assert.match(legalFacts('IL', 'privacy').join('\n'), /תיקון 13/);
  assert.match(legalFacts('IL', 'accessibility').join('\n'), /5568/);
  assert.match(legalFacts('IL', 'accessibility').join('\n'), /אסור לכתוב "האתר נגיש"/);
  assert.match(legalFacts('US', 'returns').join('\n'), /\[לבדוק לפי החוק המקומי\]/, 'another country: its law, every number in brackets');
});

test('the AI\'s answer: plain text in the page format, a policy keeps the lawyer line, a claim nobody checked is refused', () => {
  const p = cleanPageCopy({ title: '<b>ביטולים</b>', body: '# ביטול\n\n<script>x</script>**חשוב** לדעת\n\n* 14 ימים\n• דמי ביטול\n\n\n\n### החזר', seoTitle: 'x'.repeat(90), seoDescription: 'y' }, 'policy')!;
  assert.equal(p.title, 'ביטולים');
  assert.equal(p.body, `## ביטול\n\nxחשוב לדעת\n\n- 14 ימים\n- דמי ביטול\n\n## החזר\n\n${LEGAL_CHECK}`);
  assert.equal(p.seoTitle.length, 60);
  assert.ok(hasPlaceholders(p.body), 'a policy from the AI cannot be published before the lawyer line is removed');
  assert.match(pageProblem({ kind: 'policy', policy: 'returns', title: 'ביטולים', slug: 'policy-returns', body: p.body, published: true } as any, []) ?? '', /סוגריים/);
  assert.equal(cleanPageCopy({ body: 'עמוד אודות.' }, 'page')!.body, 'עמוד אודות.', 'a page of the business gets no lawyer line');
  assert.equal(cleanPageCopy({ body: 'האתר נגיש לכולם.' }, 'policy'), null);
  assert.equal(cleanPageCopy({ body: 'האתר עומד בתקן 5568.' }, 'policy'), null);
  assert.equal(cleanPageCopy({ body: 'נוסח מאושר ע"י עורך דין.' }, 'policy'), null);
  assert.equal(cleanPageCopy({ body: '' }, 'page'), null);
  assert.equal(cleanPageCopy('nothing', 'page'), null);
  assert.deepEqual(copyClaims('מה שנעשה באתר: ניווט במקלדת.'), []);
});

test('the editor writes by itself only on an empty page or one with "[…]" — never over the owner\'s own text', () => {
  assert.equal(wantsAutoFill(''), true);
  assert.equal(wantsAutoFill('## מי אנחנו\n\n[כמה מילים על העסק]'), true);
  assert.equal(wantsAutoFill('אנחנו עסק משפחתי מ-1990.'), false);
});

test('the store\'s details come from the server, for the business the user works in — never a password, never another business', async () => {
  const f = (await pageFacts('owner', { kind: 'policy', policy: 'returns', title: 'ביטולים', current: '[…]' }))!;
  assert.equal(f.store.name, 'FollowMe'); assert.equal(f.store.legalName, 'פולו מי אופנה בע"מ'); assert.equal(f.store.number, '515778223');
  assert.equal(f.selling.deliveryPrice, 30); assert.equal(f.selling.freeDeliveryOver, 300); assert.equal(f.analytics, true);
  assert.ok(!JSON.stringify(f).includes('secret-pass'), 'the store password never reaches the AI');
  assert.equal((await pageFacts('other', { kind: 'page', title: 'x' }))!.store.name, 'Other');
  assert.equal(await pageFacts('cashier', { kind: 'page' }), null, 'a cashier works in the register only');
  assert.equal(await pageFacts('nobody', { kind: 'page' }), null);
  assert.equal((await pageFacts('owner', { kind: 'policy', policy: 'evil' }))!.policy, null, 'an unknown policy is a page');
});

test('the prompt: the store\'s details and the law in; the rules on brackets, claims and the lawyer line', async () => {
  const f = (await pageFacts('owner', { kind: 'policy', policy: 'returns', title: 'ביטולים והחזרות', current: '' })) as PageFacts;
  const text = factsText(f);
  assert.match(text, /משלוח: 30 ₪, חינם מעל 300 ₪ \(כל הארץ\)/);
  assert.match(text, /ע\.מ\.: 515778223/);
  const prompt = storePagePrompt({ name: 'FollowMe', industry: 'שקיות' } as any, f);
  assert.match(prompt, /14 ימים/); assert.match(prompt, /\[3–5 ימי עסקים — לעדכן\]/); assert.match(prompt, /אסור לכתוב "האתר נגיש"/);
  assert.match(prompt, /לבדוק עם עורך דין לפני הפרסום/);
  const page = storePagePrompt({ name: 'FollowMe' } as any, { ...f, kind: 'page', policy: null, title: 'אודות' });
  assert.doesNotMatch(page, /עורך דין/, 'a page of the business is not a policy');
});

test('short texts people leave empty: a category\'s description, the store\'s sentence — written once when empty, plain, no claims', async () => {
  assert.equal(wantsShortFill({ field: 'collection', title: 'שקיות נייר', current: '' }), true);
  assert.equal(wantsShortFill({ field: 'collection', title: '', current: '' }), false, 'a category without a name: nothing to write from');
  assert.equal(wantsShortFill({ field: 'store', title: 'FollowMe', current: 'כבר כתוב' }), false, 'never over the owner\'s text');
  const c = cleanShortCopy({ text: '<p>שקיות **נייר**\n\nעם הדפסה</p>', seoTitle: 'שקיות נייר', seoDescription: 'ד' }, 'collection')!;
  assert.equal(c.text, 'שקיות נייר עם הדפסה'); assert.equal(c.seoTitle, 'שקיות נייר');
  const s = cleanShortCopy({ text: 'x'.repeat(400), seoTitle: 'no' }, 'store')!;
  assert.equal(s.text.length, 320); assert.equal(s.seoTitle, '', 'the store\'s sentence has no Google fields of its own');
  assert.equal(cleanShortCopy({ text: 'האתר נגיש ועומד בתקן' }, 'store'), null);
  const f = (await pageFacts('owner', { kind: 'page' }))!;
  const prompt = storeTextPrompt({ name: 'FollowMe' } as any, f.store, { field: 'collection', title: 'שקיות בד', tags: ['בד'], current: '' });
  assert.match(prompt, /שקיות בד/); assert.match(prompt, /בלי מחירים, מבצעים, משלוח/);
  assert.doesNotMatch(prompt, /515778223|0503566969/, 'a category\'s text needs no legal number or phone');
});
