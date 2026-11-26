/**
 * 2.119 — the accountant's answers of 25.11.2026, stage 2, the app's side (docs/ita-registration/CPA_ANSWERS_HE.md rows 1, 2, 3א, 4,
 * 6, 6 נוסף and 20; the database side is migration 20261126006900 and tests/sql/cpa-rules-stage2.check.sql):
 *   1 / 2 / 3א  a document needs an allocation number: 305 / 320 / 330, to a 9-digit dealer, before VAT from the threshold up — the
 *               database's rule; the fallback reading here is the same, and the rows of an older database read as before it
 *   6           the customer's link / PDF: the mark is the database's (the first delivery "מקור", later "העתק נאמן למקור"); a document
 *               waiting for its number is refused (409, a Hebrew message) and nothing of it is told
 *   6 נוסף      the original's PDF is kept as delivered — the same bytes, its sha256 recorded; a failure never breaks the customer's view
 *   staff       the app's PDF is a recorded delivery of the signed-in person only, recent — it never consumes the customer's original
 *   20          the monthly / yearly backups: the period by the day in Israel (also between 00:00 and 03:00, and across a month / a
 *               year), page by page, gzip + sha256, never replacing a file, resumable; expiry only through backup_expire
 * And: an old database (before 6900) works as before — and a document's PDF / HTML there looks exactly as before.
 * Demo data only (dealer numbers 000000018 / 000000026 — fictitious, a valid check digit).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fakeDb } from './fakedb';
import { SEED_RULES, allocationNeed, toRule } from '../src/features/finance/allocation';
import { allocationMissingDocs } from '../src/features/finance/overview-lists';
import {
  AWAITING_CUSTOMER, AWAITING_STAFF, MARK_COPY, MARK_ORIGINAL, WRONG_NUMBER_NOTE, deliveryMark, isAwaiting, isMissing, needFromState, toDelivery, toDeliveryState,
} from '../src/features/finance/delivery';
import { LEGACY_MARK, appDelivery, keepDelivered, pdfMark, softwareLine } from '../src/lib/server/doc-share';
import { buildDocPdf } from '../src/lib/server/doc-pdf';
import { backupCron, backupOne, periodsDue } from '../src/lib/server/backup';
import { docBody } from '../src/features/documents/DocumentsTab';
import { toDoc } from '../src/features/documents/documents';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const BIZ = 'b0000000-0000-4000-8000-000000000119';
const DOC = 'd0000000-0000-4000-8000-000000000119';
const OWNER = 'a0000000-0000-4000-8000-000000000119';
const TOKEN = 'e'.repeat(64);
const ROW = { id: DOC, user_id: OWNER, business_id: BIZ, share_token: TOKEN, doc_type: 305, doc_number: 41, link_no: 1, issued_at: '2026-11-26T08:00:00Z', doc_date: '2026-11-26',
  customer_name: 'לקוח דמו בע״מ', customer_phone: '0500000001', customer_dealer: '000000026', customer_street: 'רחוב הדמו 1', customer_city: 'עיר דמו',
  lines: [{ name: 'שירות דמו', qty: 1, unitPriceExVat: 6000, discountExVat: 0, totalExVat: 6000, vatRate: 18, kind: 1 }], payments: [],
  before_discount: 6000, discount: 0, after_discount: 6000, vat_amount: 1080, total: 7080, vat_rate: 18, print_count: 0, due_date: null, notes: '', issuer: null };
const SETTINGS = { user_id: OWNER, business_id: BIZ, dealer_number: '000000018', legal_name: 'עסק דמו', street: 'הדמו', house_no: '1', city: 'עיר דמו', zip: '', entity_type: 'company', business_type: 'licensed' };

// a Supabase client of the tests: fakeDb + a Storage bucket that never replaces a file (as the real one with upsert: false)
type Files = Map<string, Uint8Array>;
function withStorage(db: any, files: Files, o: { failUpload?: boolean; failRemove?: boolean } = {}) {
  const calls: { op: string; key: string }[] = [];
  db.storage = {
    from: (bucket: string) => ({
      upload: async (key: string, body: Uint8Array, opt: { upsert?: boolean }) => {
        calls.push({ op: 'upload', key: `${bucket}/${key}` });
        assert.equal(opt.upsert, false, 'a kept file is never replaced');
        if (o.failUpload) return { data: null, error: { statusCode: '500', message: 'storage down' } };
        if (files.has(`${bucket}/${key}`)) return { data: null, error: { statusCode: '409', message: 'The resource already exists' } };
        files.set(`${bucket}/${key}`, new Uint8Array(body)); return { data: { path: key }, error: null };
      },
      remove: async (keys: string[]) => {
        calls.push(...keys.map((k) => ({ op: 'remove', key: `${bucket}/${k}` })));
        if (o.failRemove) return { data: null, error: { statusCode: '500', message: 'no' } };
        for (const k of keys) files.delete(`${bucket}/${k}`); return { data: keys.map((name) => ({ name })), error: null };
      },
    }),
  };
  return { db, calls };
}
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(ok(), what); };

// ---- 1 / 2 / 3א: the rule -----------------------------------------------------------------------------------------------------
test('the allocation rule: 305 / 320 / 330 to a dealer, from the threshold up — an older database\'s rows read as before', () => {
  const d = { docType: 305, docDate: '2026-11-26', afterDiscount: 5000, customerDealer: '000000026' };
  const co = { entityType: 'company' };
  assert.equal(allocationNeed(d, co, SEED_RULES).required, true, '5,000 itself (answer 3א: "5,000 ומעלה")');
  assert.equal(allocationNeed({ ...d, afterDiscount: 4999.99 }, co, SEED_RULES).required, false);
  assert.equal(allocationNeed({ ...d, docType: 330 }, co, SEED_RULES).required, true, 'a credit invoice too (answer 2)');
  assert.equal(allocationNeed({ ...d, docType: 320 }, co, SEED_RULES).required, true);
  assert.equal(allocationNeed({ ...d, docType: 300 }, co, SEED_RULES).required, false, 'a transaction invoice never');
  assert.equal(allocationNeed({ ...d, customerDealer: '' }, co, SEED_RULES).required, false, 'a private customer never (answer 1)');
  assert.equal(allocationNeed({ ...d, customerDealer: '12345' }, co, SEED_RULES).required, false, 'not a dealer number');
  assert.equal(allocationNeed(d, { entityType: 'exempt_dealer' }, SEED_RULES).required, false);
  assert.equal(allocationNeed({ ...d, docDate: '2026-05-31', afterDiscount: 9999.99 }, co, SEED_RULES).required, false, 'May 2026: 10,000');
  assert.equal(allocationNeed({ ...d, docDate: '2026-05-31', afterDiscount: 10000 }, co, SEED_RULES).required, true);
  assert.match(allocationNeed(d, co, SEED_RULES).reason, /^מ-₪5,000 לפני מע״מ/);
  // the database before 6900: doc_types {305,320}, no threshold_inclusive — "more than", no credit invoice (as finance_summary of 5100)
  const old = [{ version: 4, effective_from: '2026-06-01', threshold_before_vat: 5000, doc_types: [305, 320], requires_customer_dealer: true, verified: true, source_note: '' }].map(toRule);
  assert.equal(allocationNeed(d, co, old).required, false, 'before 6900: exactly the threshold is not above it');
  assert.equal(allocationNeed({ ...d, afterDiscount: 5000.01, docType: 330 }, co, old).required, false, 'before 6900: no 330');
  assert.equal(allocationNeed({ ...d, afterDiscount: 5000.01 }, co, old).required, true);
  // after it: the new columns
  const now = [{ version: 4, effective_from: '2026-06-01', threshold_before_vat: 5000, doc_types: [305, 320], required_doc_types: [305, 320, 330], threshold_inclusive: true,
    requires_customer_dealer: true, verified: true, source_note: '' }].map(toRule);
  assert.equal(allocationNeed({ ...d, docType: 330 }, co, now).required, true);
});

test('the list of documents waiting for a number: the same reading (the fallback of the view document_allocation_status)', () => {
  const rules = [{ effectiveFrom: '2026-06-01', thresholdBeforeVat: 5000, docTypes: [305, 320, 330], inclusive: true }];
  const d = (id: string, o: Record<string, unknown> = {}) => ({ id, docType: 305, docDate: '2026-11-26', afterDiscount: 5000, customerDealer: '000000026', issuer: null, ...o });
  const docs = [d('a'), d('b', { docType: 330 }), d('c', { afterDiscount: 4999.99 }), d('d', { customerDealer: '' }), d('e'), d('f', { docType: 300 })];
  assert.deepEqual(allocationMissingDocs(docs, rules, [{ documentId: 'e', status: 'manual', isTest: false }], 'company').map((x) => x.id), ['a', 'b']);
  assert.deepEqual(allocationMissingDocs(docs, [{ effectiveFrom: '2026-06-01', thresholdBeforeVat: 5000 }], [], 'company').map((x) => x.id), [], 'before 6900: above 5,000, 305 / 320 only');
});

// ---- the database's answers, read -----------------------------------------------------------------------------------------------
test('a delivery and the delivery state, as the database answers them; its errors in words', () => {
  assert.equal(deliveryMark(true), MARK_ORIGINAL); assert.equal(deliveryMark(false), MARK_COPY);
  assert.equal(MARK_ORIGINAL, 'מקור'); assert.equal(MARK_COPY, 'העתק נאמן למקור');
  const v = toDelivery({ ok: true, delivery_id: 'v1', document_id: DOC, business_id: BIZ, channel: 'link', original: true, mark: 'anything', at: '2026-11-26T08:00:00Z', print_count: 0, file_path: `${BIZ}/${DOC}/v1.pdf` });
  assert.equal(v!.mark, 'מקור', 'the mark is recomputed from is_original — never an odd text from the answer');
  assert.equal(toDelivery({ ok: false, code: 'awaiting_allocation' }), null);
  assert.equal(toDelivery({ ok: true, delivery_id: 'v1', document_id: DOC, original: 'yes' })!.original, false, 'only true is the original');
  const st = toDeliveryState({ allocation: { required: true, awaiting: true, number: null, manual: false,
    rule: { version: 4, effectiveFrom: '2026-06-01', threshold: 5000, inclusive: true, docTypes: [305, 320, 330], verified: true } }, delivered: false, original: null, deliveries: 0, printCount: 0 })!;
  assert.equal(st.allocation.awaiting, true);
  const need = needFromState(st);
  assert.equal(need.required, true); assert.equal(need.rule!.thresholdBeforeVat, 5000); assert.match(need.reason, /^מ-₪5,000 לפני מע״מ ללקוח עם מספר עוסק/);
  assert.equal(needFromState({ ...st, allocation: { ...st.allocation, required: false, awaiting: false } }).required, false);
  assert.equal(toDeliveryState(null), null);
  assert.equal(isAwaiting({ code: '55000', message: 'x' }), true);
  assert.equal(isAwaiting({ code: 'P0001', message: 'awaiting_allocation: המסמך דורש מספר הקצאה' }), true);
  assert.equal(isAwaiting({ code: '42501', message: 'not allowed' }), false);
  assert.equal(isMissing({ code: 'PGRST202', message: 'Could not find the function public.document_delivery_record' }), true);
  assert.equal(isMissing({ code: '42501', message: 'not allowed' }), false);
  assert.match(AWAITING_CUSTOMER, /^המסמך ממתין למספר הקצאה מרשות המסים/);
  assert.match(AWAITING_STAFF, /הזנת מספר שהתקבל/);
  assert.match(WRONG_NUMBER_NOTE, /חשבונית זיכוי/); assert.match(WRONG_NUMBER_NOTE, /חשבונית חדשה/);
  // never a claim of the Tax Authority's approval or a report (CLAUDE.md, רשות המסים)
  for (const t of [AWAITING_CUSTOMER, AWAITING_STAFF, WRONG_NUMBER_NOTE]) assert.doesNotMatch(t, /אושר|מאושר|דווח/);
});

// ---- 6 / 6 נוסף: the customer's link -----------------------------------------------------------------------------------------
let tables: Record<string, any[]>;
let files: Files;
let opens: { token: string; channel: string }[];
let fileAdds: any[];
let answer: (ch: string) => any;
const install = (o: { rpc?: boolean; failUpload?: boolean } = {}) => {
  tables = { documents: [{ ...ROW }], register_settings: [{ ...SETTINGS }], brands: [{ user_id: OWNER, business_id: BIZ, name: 'עסק דמו' }], businesses: [{ id: BIZ, status: 'active', paid_until: null, grace_days: 0 }],
    document_deliveries: [] };
  files = new Map(); opens = []; fileAdds = [];
  let first = true;
  answer = (channel) => { const original = first; first = false; const id = randomUUID();
    tables.document_deliveries.push({ id, business_id: BIZ, document_id: DOC, channel, is_original: original, user_id: null, created_at: new Date().toISOString() });
    return { ok: true, delivery_id: id, document_id: DOC, business_id: BIZ, channel, original, mark: original ? 'מקור' : 'העתק נאמן למקור', at: new Date().toISOString(), print_count: 0, file_path: `${BIZ}/${DOC}/${id}.pdf` }; };
  const db = fakeDb(tables, { rpc: o.rpc === false ? {} : {
    document_share_open: (a: any) => { opens.push({ token: a.p_token, channel: a.p_channel }); return a.p_token === TOKEN ? answer(a.p_channel) : { ok: false, code: 'not_found' }; },
    document_delivery_file_add: (a: any) => { fileAdds.push(a); return { ok: true, created: true }; },
  } });
  withStorage(db, files, { failUpload: o.failUpload });
  (globalThis as any).__DP_TEST_ADMIN_DB__ = db;
};
before(() => { delete process.env.DOC_SIGN_P12_BASE64; });

test('the link: the first open is the original, the next a true copy; the original\'s PDF is kept — the same document, its sha256', async () => {
  install();
  const route = await import('../src/app/api/doc/[token]/route');
  const r1 = await route.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) });
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.mark, 'מקור');
  assert.ok(!('business_id' in j1.doc) && !('id' in j1.doc), 'no internal ids');
  assert.deepEqual(opens, [{ token: TOKEN, channel: 'link' }]);
  await until(() => fileAdds.length === 1, 'the original kept after the answer');
  const [[key, bytes]] = [...files.entries()];
  assert.equal(key, `delivered-documents/${tables.document_deliveries[0].business_id}/${DOC}/${tables.document_deliveries[0].id}.pdf`);
  assert.equal(fileAdds[0].p_sha256, sha(bytes)); assert.equal(fileAdds[0].p_bytes, bytes.byteLength);
  assert.equal(fileAdds[0].p_delivery, tables.document_deliveries[0].id);
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), '%PDF-');
  const r2 = await route.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) });
  assert.equal((await r2.json()).mark, 'העתק נאמן למקור');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(files.size, 1, 'a copy is not kept'); assert.equal(fileAdds.length, 1);
});

test('the PDF: the bytes kept are the bytes sent; the mark is drawn; a copy says so; ?via=storefront is its own channel', async () => {
  install();
  const route = await import('../src/app/api/doc/[token]/pdf/route');
  const r = await route.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) });
  assert.equal(r.status, 200);
  const sent = new Uint8Array(await r.arrayBuffer());
  await until(() => fileAdds.length === 1, 'kept');
  const kept = [...files.values()][0];
  assert.equal(sha(kept), sha(sent), 'exactly as delivered');
  const dir = mkdtempSync(path.join(tmpdir(), 'dp-6900-'));
  const text = (b: Uint8Array, n: string) => { const f = path.join(dir, n); writeFileSync(f, b); return execFileSync('pdftotext', ['-layout', f, '-']).toString(); };
  assert.match(text(sent, 'o.pdf'), /^\W*מקור\W*\s/, 'the mark "מקור" is drawn');
  assert.doesNotMatch(text(sent, 'o2.pdf'), /העתק נאמן למקור/);
  const r2 = await route.GET(new Request('http://x?via=storefront'), { params: Promise.resolve({ token: TOKEN }) });
  assert.match(text(new Uint8Array(await r2.arrayBuffer()), 'c.pdf'), /העתק נאמן למקור/, 'a true copy');
  assert.deepEqual(opens.map((o) => o.channel), ['pdf', 'storefront']);
});

test('awaiting its allocation number: 409, a Hebrew message, nothing of the document; not found / locked as before', async () => {
  install();
  answer = () => ({ ok: false, code: 'awaiting_allocation' });
  const route = await import('../src/app/api/doc/[token]/route');
  const pdf = await import('../src/app/api/doc/[token]/pdf/route');
  for (const r of [await route.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) }), await pdf.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) })]) {
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.deepEqual(j, { code: 'awaiting_allocation', message: AWAITING_CUSTOMER });
  }
  assert.equal(files.size, 0);
  answer = () => ({ ok: false, code: 'unavailable' });
  const locked = await route.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) });
  assert.equal(locked.status, 403); assert.equal((await locked.json()).code, 'unavailable');
  assert.equal((await route.GET(new Request('http://x'), { params: Promise.resolve({ token: 'f'.repeat(64) }) })).status, 404);
  assert.equal((await route.GET(new Request('http://x'), { params: Promise.resolve({ token: '../x' }) })).status, 404);
});

test('keeping the original fails: the customer still gets the document; a copy is never kept; a bad path is refused', async () => {
  install({ failUpload: true });
  const pdf = await import('../src/app/api/doc/[token]/pdf/route');
  const errs: unknown[][] = []; const orig = console.error; console.error = (...a: unknown[]) => { errs.push(a); };
  try {
    const r = await pdf.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) });
    assert.equal(r.status, 200);
    await until(() => errs.length > 0, 'logged');
  } finally { console.error = orig; }
  assert.equal(fileAdds.length, 0);
  const logged = JSON.stringify(errs);
  for (const secret of ['000000026', '000000018', '7080', 'לקוח דמו', TOKEN]) assert.ok(!logged.includes(secret), `the log never carries ${secret}`);
  const db = withStorage(fakeDb({}), new Map()).db;
  const copy = { deliveryId: 'v', documentId: DOC, businessId: BIZ, channel: 'pdf' as const, original: false, mark: MARK_COPY, at: '', printCount: 0, filePath: `${BIZ}/${DOC}/${DOC}.pdf` };
  assert.deepEqual(await keepDelivered(db, copy, new Uint8Array([1])), { kept: false });
  assert.deepEqual(await keepDelivered(db, { ...copy, original: true, filePath: '../../x.pdf' }, new Uint8Array([1])), { kept: false, error: 'bad_path' });
});

test('an old database (before 6900): the link and the PDF as before — "מסמך ממוחשב", nothing recorded, the same drawn PDF', async () => {
  install({ rpc: false });
  const route = await import('../src/app/api/doc/[token]/route');
  const j = await (await route.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) })).json();
  assert.equal(j.mark, LEGACY_MARK); assert.equal(LEGACY_MARK, 'מסמך ממוחשב');
  const pdf = await import('../src/app/api/doc/[token]/pdf/route');
  const r = await pdf.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(files.size, 0, 'nothing kept before the migration');
  // the PDF of 2.118 for the same document: buildDocPdf with the mark and the software line it was given then — the same text
  const doc = { ...toDoc(ROW), cancelled: false };
  const business = { dealerNumber: '000000018', name: 'עסק דמו', street: 'הדמו', houseNo: '1', city: 'עיר דמו', zip: '', entityType: 'company' };
  const reg = process.env.NEXT_PUBLIC_SOFTWARE_REG_NUMBER ?? '';
  const software218 = `Dream Promotion ${process.env.NEXT_PUBLIC_APP_VERSION ?? ''}`.trim() + (/^\d{8}$/.test(reg) && reg !== '00000000' ? ` · תוכנה רשומה מס׳ ${reg}` : '');
  assert.equal(softwareLine(), software218);
  assert.equal(pdfMark(LEGACY_MARK, false), 'מסמך ממוחשב'); assert.equal(pdfMark(LEGACY_MARK, true), 'מסמך ממוחשב · בוטל', 'as 2.118 wrote a cancelled one');
  const before = await (await buildDocPdf(doc, business, { mark: 'מסמך ממוחשב', software: software218, signed: false, allocation: 'מספר הקצאה: טרם התקבל' })).save();
  const dir = mkdtempSync(path.join(tmpdir(), 'dp-6900-old-'));
  const text = (b: Uint8Array, n: string) => { const f = path.join(dir, n); writeFileSync(f, b); return execFileSync('pdftotext', ['-layout', f, '-']).toString(); };
  assert.equal(text(new Uint8Array(await r.arrayBuffer()), 'now.pdf'), text(before, 'before.pdf'), 'the same document, drawn the same');
  // and the HTML: printing without an allocation line is byte for byte the 2.118 call
  assert.equal(docBody(doc, business, 'מקור', { allocation: null }), docBody(doc, business, 'מקור'));
});

test('the app\'s PDF: only a recent delivery recorded by the signed-in person — never the customer\'s link, never another person\'s', async () => {
  const at = Date.parse('2026-11-26T08:00:00Z');
  const v = { id: 'c0000000-0000-4000-8000-000000000001', business_id: BIZ, document_id: DOC, channel: 'pdf', is_original: true, user_id: OWNER, created_at: new Date(at).toISOString() };
  const t = { document_deliveries: [v, { ...v, id: 'c0000000-0000-4000-8000-000000000002', channel: 'link', user_id: null }] };
  const db = fakeDb(t) as any;
  const ok = await appDelivery(db, OWNER, v.id, at + 60_000);
  assert.ok(ok.ok); if (!ok.ok) return;
  assert.equal(ok.delivery.mark, 'מקור'); assert.equal(ok.delivery.filePath, `${BIZ}/${DOC}/${v.id}.pdf`);
  assert.equal((await appDelivery(db, 'someone-else', v.id, at)).ok, false, 'another person\'s delivery');
  assert.equal((await appDelivery(db, OWNER, 'c0000000-0000-4000-8000-000000000002', at)).ok, false, 'the customer\'s link is not the app\'s');
  assert.equal((await appDelivery(db, OWNER, v.id, at + 16 * 60_000)).ok, false, 'older than 15 minutes');
  assert.equal((await appDelivery(db, OWNER, 'not-an-id', at)).ok, false);
  const route = await import('../src/app/api/doc/delivery/route');
  assert.equal((await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ deliveryId: v.id }) }))).status, 401, 'signed in only');
});

test('the screens: no staff PDF through the customer\'s link, deliveries through the database, the request to the Tax Authority not offered', () => {
  const src = (f: string) => readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const f of ['src/features/finance/DocView.tsx', 'src/features/documents/DocumentsTab.tsx', 'src/features/register/RegisterScreen.tsx']) {
    assert.ok(!/href=\{`\/api\/doc\/\$\{/.test(src(f)), `${f}: the staff PDF is not the customer's link`);
    assert.match(src(f), /staffPdf\(/, `${f}: the app's PDF is a recorded delivery`);
  }
  assert.match(src('src/features/documents/DocumentsTab.tsx'), /recordDelivery\(d\.id, 'print'\)/, 'a print is document_delivery_record(…, print)');
  assert.match(src('src/features/finance/DocView.tsx'), /sendDocLink\(doc\.id/, 'WhatsApp asks the database first');
  assert.match(src('src/features/register/PosView.tsx'), /sendDocLink\(done\.docId/);
  assert.doesNotMatch(src('src/features/finance/DocView.tsx'), /בקשה מרשות המסים/, 'the owner, 26.11.2026: manual numbers only for now');
  assert.match(src('src/features/finance/DocView.tsx'), /ממתין למספר הקצאה/);
});

// ---- 20: the backups --------------------------------------------------------------------------------------------------------
test('what is due, by the day in Israel: the month that ended (also at 00:30 on the 1st — still the 30th in UTC), and the year in January', () => {
  assert.deepEqual(periodsDue(new Date('2026-11-30T22:30:00Z')), [{ kind: 'monthly', period: '2026-11' }], '1.12.2026 00:30 in Israel');
  assert.deepEqual(periodsDue(new Date('2026-11-30T21:59:00Z')), [{ kind: 'monthly', period: '2026-10' }], '30.11.2026 23:59 in Israel');
  assert.deepEqual(periodsDue(new Date('2026-12-31T23:00:00Z')), [{ kind: 'monthly', period: '2026-12' }, { kind: 'yearly', period: '2026' }], '1.1.2027 01:00 in Israel');
  assert.deepEqual(periodsDue(new Date('2027-01-31T22:30:00Z')), [{ kind: 'monthly', period: '2027-01' }], '1.2.2027 — no year');
  assert.deepEqual(periodsDue(new Date('2026-07-01T00:30:00Z')), [{ kind: 'monthly', period: '2026-06' }], 'summer time (UTC+3): 03:30 on 1.7');
  assert.deepEqual(periodsDue(new Date('2026-06-30T20:59:00Z')), [{ kind: 'monthly', period: '2026-05' }], '30.6 23:59 in Israel');
});

function backupDb(o: { rows?: number; exportFails?: boolean; failRemove?: boolean } = {}) {
  const B1 = 'b1000000-0000-4000-8000-000000000001', B2 = 'b2000000-0000-4000-8000-000000000002';
  const runs: any[] = [];
  const log: string[] = [];
  const rowsOf = (b: string, t: string) => (t === 'documents' ? Array.from({ length: o.rows ?? 3 }, (_, i) => ({ id: `${b}-${i}`, business_id: b, doc_number: i + 1 })) : []);
  const db = fakeDb({}, { rpc: {
    backup_tables: () => ['documents', 'payments'],
    backup_businesses: () => [B1, B2],
    backup_run_start: (a: any) => {
      log.push(`start ${a.p_kind} ${a.p_period}`);
      const r = runs.find((x) => x.kind === a.p_kind && x.period === a.p_period && x.business === a.p_business && ['running', 'ok'].includes(x.status));
      if (r) return { id: r.id, object_path: r.object_path, status: r.status, created: false };
      const id = randomUUID(); const n = { id, kind: a.p_kind, period: a.p_period, business: a.p_business, status: 'running', object_path: `${a.p_business}/${a.p_kind}/${a.p_period}/${id}.json.gz` };
      runs.push(n); return { id, object_path: n.object_path, status: 'running', created: true };
    },
    backup_export: (a: any) => {
      if (o.exportFails) return null;
      const all = rowsOf(a.p_business, a.p_table); const rows = all.slice(a.p_offset, a.p_offset + a.p_limit);
      log.push(`export ${a.p_table} ${a.p_offset}`);
      return { table: a.p_table, offset: a.p_offset, count: rows.length, total: all.length, more: a.p_offset + rows.length < all.length, rows };
    },
    backup_run_finish: (a: any) => { const r = runs.find((x) => x.id === a.p_run); Object.assign(r, { status: 'ok', sha256: a.p_sha256, bytes: a.p_bytes, counts: a.p_counts }); return { id: r.id, status: 'ok' }; },
    backup_run_fail: (a: any) => { const r = runs.find((x) => x.id === a.p_run); Object.assign(r, { status: 'failed', error: a.p_error }); return { id: r.id, status: 'failed' }; },
    backup_expirable: () => runs.filter((x) => x.status === 'ok' && x.old).map((x) => ({ id: x.id, object_path: x.object_path })),
    backup_expire: (a: any) => { const r = runs.find((x) => x.id === a.p_run); if (!r.old) throw new Error('retention'); r.status = 'expired'; return { id: r.id, changed: true }; },
  } });
  const fs: Files = new Map();
  const { calls } = withStorage(db, fs, { failRemove: o.failRemove });
  return { db: db as any, runs, files: fs, calls, log, B1, B2 };
}

test('a monthly backup: every business, page by page, gzip + sha256 as recorded; the same day again — nothing done twice', async () => {
  const x = backupDb({ rows: 5 });
  const at = new Date('2026-11-30T22:30:00Z');   // 1.12.2026 00:30 in Israel
  const r = await backupCron(x.db, at, Date.now() + 30_000, { pageSize: 2 });
  assert.equal(r.ready, true); assert.equal(r.ok, 2); assert.equal(r.failed, 0);
  assert.deepEqual(x.log.filter((l) => l.startsWith('export documents')).slice(0, 3), ['export documents 0', 'export documents 2', 'export documents 4'], 'pages of 2');
  for (const run of x.runs) {
    assert.equal(run.kind, 'monthly'); assert.equal(run.period, '2026-11'); assert.equal(run.status, 'ok');
    const file = x.files.get(`backups/${run.object_path}`)!;
    assert.ok(file, 'uploaded to its path');
    assert.equal(run.sha256, sha(file)); assert.equal(run.bytes, file.byteLength);
    const j = JSON.parse(gunzipSync(file).toString());
    assert.equal(j.format, 'dream-promotion-backup/1'); assert.equal(j.business_id, run.business); assert.equal(j.period, '2026-11');
    assert.equal(j.tables.documents.length, 5); assert.deepEqual(run.counts, { documents: 5, payments: 0 });
    assert.ok(j.tables.documents.every((d: any) => d.business_id === run.business), 'a business\'s file holds its own rows only');
  }
  const again = await backupCron(x.db, at, Date.now() + 30_000, { pageSize: 2 });
  assert.equal(again.ok, 0); assert.equal(again.skipped, 2);
  assert.equal(x.calls.filter((c) => c.op === 'upload').length, 2, 'never uploaded twice');
});

test('a backup that runs out of time is resumed the next day by the same run; a failure is recorded, never data in its error', async () => {
  const x = backupDb();
  let t = 0; const clock = () => t;
  // the deadline passes during the first business's export: nothing uploaded, its run stays "running"
  const r = await backupCron(x.db, new Date('2026-12-31T23:00:00Z'), 1, { pageSize: 1, clock: () => (t++ > 2 ? 10 : 0) });
  assert.equal(r.outOfTime, true); assert.equal(r.ok, 0); assert.equal(x.files.size, 0);
  assert.equal(x.runs.length, 1); assert.equal(x.runs[0].status, 'running');
  t = 0;
  const next = await backupCron(x.db, new Date('2027-01-01T23:00:00Z'), 1e15, { pageSize: 1, clock });
  assert.equal(next.ok, 4, 'two businesses × (the month and the year)');
  assert.equal(x.runs.length, 4, 'the stopped run was picked up — not a second one for the same period');
  assert.deepEqual([...new Set(x.runs.map((q) => `${q.kind} ${q.period}`))].sort(), ['monthly 2026-12', 'yearly 2026']);
  const f = backupDb({ exportFails: true });
  const bad = await backupCron(f.db, new Date('2026-11-30T22:30:00Z'), Date.now() + 30_000);
  assert.equal(bad.failed, 2); assert.ok(f.runs.every((q) => q.status === 'failed' && /^export documents: /.test(q.error)));
});

test('a file already there is never replaced (busy); a copy goes only after backup_expire, then its file', async () => {
  const x = backupDb();
  const { data: run } = await x.db.rpc('backup_run_start', { p_kind: 'monthly', p_period: '2026-10', p_business: x.B1 });
  x.files.set(`backups/${run.object_path}`, new Uint8Array([1, 2, 3]));
  assert.equal(await backupOne(x.db, run, { kind: 'monthly', period: '2026-10' }, x.B1, ['documents'], Date.now() + 10_000), 'busy');
  assert.deepEqual([...x.files.get(`backups/${run.object_path}`)!], [1, 2, 3], 'the file there is kept as it was');
  assert.equal(x.runs[0].status, 'running');
  // expiry: one copy past its retention (old), one not — only the first goes, the database first, then its file
  x.runs.push({ id: 'old-1', kind: 'monthly', period: '2025-01', business: x.B1, status: 'ok', object_path: `${x.B1}/monthly/2025-01/old-1.json.gz`, old: true });
  x.files.set(`backups/${x.B1}/monthly/2025-01/old-1.json.gz`, new Uint8Array([9]));
  const r = await backupCron(x.db, new Date('2026-11-30T22:30:00Z'), Date.now() + 30_000);
  assert.equal(r.expired, 1); assert.equal(x.runs.find((q) => q.id === 'old-1').status, 'expired');
  assert.equal(x.files.has(`backups/${x.B1}/monthly/2025-01/old-1.json.gz`), false);
  const y = backupDb({ failRemove: true });
  y.runs.push({ id: 'old-2', kind: 'yearly', period: '2018', business: y.B1, status: 'ok', object_path: 'p', old: true });
  const orig = console.error; console.error = () => {};
  try { assert.equal((await backupCron(y.db, new Date('2026-11-30T22:30:00Z'), Date.now() + 30_000)).expireErrors, 1); } finally { console.error = orig; }
});

test('before migration 6900 the timer does nothing; it answers only with CRON_SECRET; it is in vercel.json', async () => {
  const r = await backupCron(fakeDb({}) as any, new Date('2026-11-30T22:30:00Z'));
  assert.equal(r.ready, false); assert.equal(r.ok, 0);
  const route = await import('../src/app/api/cron/backup/route');
  delete process.env.CRON_SECRET;
  assert.equal((await route.GET(new Request('http://x'))).status, 403, 'no secret set: closed');
  process.env.CRON_SECRET = 'test-secret-not-real';
  assert.equal((await route.GET(new Request('http://x', { headers: { authorization: 'Bearer wrong' } }))).status, 403);
  delete process.env.CRON_SECRET;
  const vercel = JSON.parse(readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.ok(vercel.crons.some((c: any) => c.path === '/api/cron/backup' && /^\d+ \d+ \* \* \*$/.test(c.schedule)), 'daily');
});

// ---- follow-ups (2.119): the store's link, the storefront's channel, the debt reminders, the documents tab's preview -------------
test('a debt reminder of a document waiting for its number is not sent — the email says why, nothing goes to Resend', async () => {
  const { reminderAwaiting, sendReminderEmail } = await import('../src/lib/server/reminders');
  const { AWAITING_REMINDER } = await import('../src/features/finance/delivery');
  const t = { debt_reminders: [{ id: 'rem-a', document_id: 'doc-a' }, { id: 'rem-b', document_id: 'doc-b' }],
    document_allocation_status: [{ document_id: 'doc-a', awaiting: true }, { document_id: 'doc-b', awaiting: false }] };
  const db = fakeDb(t, { rpc: { debt_reminder_check: () => ({ state: 'ok', open: 5900, docType: 305, docNumber: 41, customer: 'לקוח דמו', shareToken: TOKEN, tone: 'friendly' }) } }) as any;
  assert.equal(await reminderAwaiting(db, 'rem-a'), true);
  assert.equal(await reminderAwaiting(db, 'rem-b'), false);
  assert.equal(await reminderAwaiting(fakeDb({ debt_reminders: [{ id: 'rem-a', document_id: 'doc-a' }] }) as any, 'rem-a'), false, 'before 6900 (no view): as before');
  const realFetch = globalThis.fetch; let called = 0;
  globalThis.fetch = (async () => { called++; return new Response('{}'); }) as any;
  try {
    assert.deepEqual(await sendReminderEmail(db, { id: 'mail-a', reminder_id: 'rem-a', business_id: BIZ, to_email: 'customer@example.test' }), { error: AWAITING_REMINDER, final: true });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(called, 0, 'nothing sent');
  assert.match(AWAITING_REMINDER, /ממתין למספר הקצאה/); assert.doesNotMatch(AWAITING_REMINDER, /אושר|מאושר|דווח/);
});

test('the preview mark of the documents tab and DocView: from the deliveries (2.119), from the prints before 6900', async () => {
  const { previewMark, wasDelivered } = await import('../src/features/documents/DocumentsTab');
  const st = (delivered: boolean) => toDeliveryState({ allocation: { required: false, awaiting: false, number: null, manual: false, rule: null }, delivered, original: null, deliveries: delivered ? 1 : 0, printCount: 0 });
  assert.equal(previewMark({ printCount: 0 }, st(false)), 'מקור (טרם נמסר)');
  assert.equal(previewMark({ printCount: 0 }, st(true)), 'העתק נאמן למקור', 'the customer opened the link: the next one is a copy');
  assert.equal(previewMark({ printCount: 0 }, null), 'מקור (טרם הודפס)', 'before 6900 — as before');
  assert.equal(previewMark({ printCount: 2 }, null), 'העתק נאמן למקור');
  assert.equal(wasDelivered({ printCount: 1 }, st(false)), true, 'printed before 2.119');
});

test('no staff path through the customer\'s link: the store\'s order page opens the document in "מסמכים"; the storefront names its channel', () => {
  const src = (f: string) => readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.doesNotMatch(src('src/features/store/StoreOrders.tsx'), /href=\{`\/d\//, 'the order page never opens /d/<token>');
  assert.match(src('src/features/store/StoreOrders.tsx'), /\/finance\/documents\?open=\$\{x\.id\}/);
  assert.match(src('src/features/finance/DocumentCenter.tsx'), /params\.get\('open'\)/);
  assert.match(src('../storefront/src/lib/dashboard.ts'), /\/api\/doc\/\$\{docToken\}\/pdf\?via=storefront/);
  for (const f of ['src/features/finance/Receivables.tsx', 'src/features/finance/Reminders.tsx']) assert.match(src(f), /awaitingIds\(/, `${f}: asks the database before a reminder`);
});
