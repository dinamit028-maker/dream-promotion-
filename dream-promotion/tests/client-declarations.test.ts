/**
 * Health declarations (docs/CLIENT FILE ENGINEERING HE.md §5): the rules of fields and answers (nothing pre-selected,
 * follow-ups only after "yes", every confirmation ticked), the finger signature (a line, not a dot), the PDF, the
 * business's route (templates, approval by the owner only, sending a link whose token is kept only as a hash) and the
 * customer's public link (/api/h/<token>): what it shows, what it keeps, and that a second signature is refused.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { fakeDb } from './fakedb';
import { resetRateLimits } from '../src/lib/server/rate-limit';
import { buildDeclarationPdf, checkSignature, hashToken, newToken } from '../src/lib/server/declarations';
import {
  answerLines, asked, checkAnswers, cleanFields, declarationMessage, progress, requestState, validOn, type Field,
} from '../src/features/client-file/declarations';

const OWN = 'user-own', PRAC = 'user-prac', CASH = 'user-cash', OTHER = 'user-other';
const B1 = '00000000-0000-4000-8000-00000000d001', B2 = '00000000-0000-4000-8000-00000000d002';
const NOA = '00000000-0000-4000-8000-0000000000a1', MICHAL = '00000000-0000-4000-8000-0000000000b1';
const LASER = '00000000-0000-4000-8000-0000000000c1';
const FIELDS: Field[] = [
  { key: 'chronic', type: 'yesno', label: 'האם חלית במחלה כרונית?', required: true, showFollowUpsWhen: 'yes',
    followUps: [{ key: 'which', type: 'text', label: 'איזו מחלה?', required: true }, { key: 'care', type: 'longtext', label: 'איזה טיפול את/ה מקבל/ת?', required: true }] },
  { key: 'skin', type: 'multi', label: 'סוג עור', required: false, options: ['יבש', 'שמן', 'רגיש'] },
  { key: 'photos', type: 'marketing', label: 'אני מסכים/ה לשימוש בתמונות לפרסום', required: false },
  { key: 'intro', type: 'info', label: 'יש לקרוא בעיון.', required: false },
];
const ACKS = ['ידוע לי שתוצאות הלייזר אינן מובטחות ב-100%'];

// ---- the in-memory world ---------------------------------------------------------------------------------------------
const tables: Record<string, any[]> = {};
const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
const current: Record<string, string> = { [OWN]: B1, [PRAC]: B1, [CASH]: B1, [OTHER]: B2 };
const allowed = new Set([`${OWN}:${B1}`, `${PRAC}:${B1}`, `${OTHER}:${B2}`]);
const owners = new Set([`${OWN}:${B1}`, `${OTHER}:${B2}`]);
const events: string[] = [];
function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  files.clear(); events.length = 0; resetRateLimits();
  Object.assign(tables, {
    profiles: [OWN, PRAC, CASH, OTHER].map((id) => ({ id, is_super_admin: false })),
    businesses: [{ id: B1, name: 'B1', status: 'active', paid_until: null, grace_days: 0 }, { id: B2, name: 'B2', status: 'active', paid_until: null, grace_days: 0 }],
    business_members: [
      { business_id: B1, user_id: OWN, role: 'owner', access: 'full' }, { business_id: B1, user_id: PRAC, role: 'editor', access: 'full' },
      { business_id: B1, user_id: CASH, role: 'editor', access: 'register' }, { business_id: B2, user_id: OTHER, role: 'owner', access: 'full' }],
    brands: [{ business_id: B1, name: 'קליניקת נועם' }],
    leads: [{ id: NOA, business_id: B1, name: 'נועה כהן', phone: '050-1234567' }, { id: MICHAL, business_id: B2, name: 'מיכל', phone: '' }],
    treatment_types: [{ id: LASER, business_id: B1, name: 'לייזר', active: true, sort: 0 }],
    client_treatments: [{ id: 't1', business_id: B1, lead_id: NOA, treatment_type_id: LASER, status: 'active' }],
    declaration_templates: [], declaration_requests: [], declarations: [], lead_activities: [],
  });
}
const storage = {
  from: () => ({
    upload: async (path: string, bytes: Uint8Array, o: { contentType: string; upsert?: boolean }) => {
      if (!o.upsert && files.has(path)) return { data: null, error: { message: 'exists' } };
      files.set(path, { bytes: new Uint8Array(bytes), contentType: o.contentType }); return { data: { path }, error: null };
    },
    remove: async (paths: string[]) => { for (const p of paths) files.delete(p); return { data: [], error: null }; },
    createSignedUrl: async (path: string, s: number) => { events.push(`sign:${path}`); return { data: { signedUrl: `https://sb.test/${path}?ttl=${s}` }, error: null }; },
  }),
};
before(() => {
  // the database's unique key: one signature per template per link
  const rules = { onInsert: (t: string, row: any, all: any[]) => (t === 'declarations' && all.some((x) => x.request_id === row.request_id && x.template_id === row.template_id)
    ? { code: '23505', message: 'duplicate key' } : null) };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    from: (t: string) => fakeDb(tables, rules).from(t),
    auth: { getUser: async (t: string) => ({ data: { user: Object.keys(current).includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string, a: any) => {
      if (fn === 'business_for_user') return { data: current[a.uid] ?? null, error: null };
      if (fn === 'client_files_allowed_for') return { data: allowed.has(`${a.p_user}:${a.p_business}`), error: null };
      if (fn === 'client_file_owner_for') return { data: owners.has(`${a.p_user}:${a.p_business}`), error: null };
      if (fn === 'client_file_log_view') { events.push(`log:${a.p_id}`); return { data: NOA, error: null }; }
      return { data: null, error: null };
    },
    storage,
  };
});
beforeEach(reset);

const staff = async (user: string | null, body: unknown) => {
  const { POST } = await import('../src/app/api/client-file/declarations/route');
  const r = await POST(new Request('http://x/api/client-file/declarations', { method: 'POST', headers: user ? { authorization: `Bearer ${user}` } : {}, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const pub = async (token: string, body?: unknown) => {
  const m = await import('../src/app/api/h/[token]/route');
  const req = new Request(`http://x/api/h/${token}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'user-agent': 'TestPhone/1', 'x-forwarded-for': '10.1.2.3' } });
  const r = await (body === undefined ? m.GET : m.POST)(req, { params: Promise.resolve({ token }) });
  return { status: r.status, body: await r.json(), headers: r.headers };
};
/** a finger signature: a dark stroke across a transparent canvas (or a single dot) */
const signature = async (dot = false) => {
  const svg = dot ? '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><circle cx="450" cy="150" r="3" fill="#111"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><path d="M50 200 C 200 50, 350 250, 600 120 S 800 180, 850 100" stroke="#111" stroke-width="6" fill="none"/></svg>';
  return `data:image/png;base64,${(await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64')}`;
};
const full = { chronic: 'yes', which: 'סוכרת', care: 'אינסולין', skin: ['רגיש'], photos: 'no' };

test('the template: fields as the clinic wrote them, keys unique, choices with options', () => {
  const ok = cleanFields(FIELDS);
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.fields[0].followUps?.length, 2);
  assert.equal(ok.ok && ok.fields[2].required, false, 'marketing is never required');
  assert.deepEqual(cleanFields([{ key: 'a', type: 'yesno', label: '  שאלה  ' }]), { ok: true, fields: [{ key: 'a', type: 'yesno', label: 'שאלה', required: true, showFollowUpsWhen: 'yes' }] });
  for (const [bad, why] of [
    [[{ key: 'a', type: 'script', label: 'x' }], 'unknown type'], [[{ key: 'a', type: 'text', label: '' }], 'no wording'],
    [[{ key: 'a', type: 'text', label: 'x' }, { key: 'a', type: 'text', label: 'y' }], 'a key twice'],
    [[{ key: 'a', type: 'yesno', label: 'x', followUps: [{ key: 'a', type: 'text', label: 'y' }] }], 'a follow-up with a used key'],
    [[{ key: 'a', type: 'choice', label: 'x', options: ['רק אחת'] }], 'one option'], [[{ key: 'A b', type: 'text', label: 'x' }], 'a bad key'], ['x', 'not a list'],
  ] as [unknown, string][]) assert.equal(cleanFields(bad).ok, false, why);
});

test('the answers: nothing pre-selected, "if yes, tell" required, the other way dropped, every confirmation ticked', () => {
  const none = checkAnswers(FIELDS, ACKS, {}, [true]);
  assert.deepEqual(none.ok ? null : none.missing, 'chronic', 'no answer is a missing answer — never "no" by default');
  const noDetail = checkAnswers(FIELDS, ACKS, { chronic: 'yes', which: 'סוכרת' }, [true]);
  assert.deepEqual(noDetail.ok ? null : [noDetail.missing, noDetail.message], ['care', 'חסר פירוט: איזה טיפול את/ה מקבל/ת?']);
  const noAck = checkAnswers(FIELDS, ACKS, full, [false]);
  assert.equal(noAck.ok ? null : noAck.missing, 'ack_0');
  const said = checkAnswers(FIELDS, ACKS, { chronic: 'no', which: 'נשאר מקודם', skin: ['רגיש', 'לא קיים'], photos: 'yes', intro: 'x', extra: 'y' }, [true]);
  assert.ok(said.ok);
  assert.deepEqual(said.ok && said.answers, { chronic: 'no', skin: ['רגיש'], photos: 'yes' }, 'follow-ups of a "no" are not sent; unknown keys and options dropped');
  assert.equal(said.ok && said.marketingOk, true);
  const yes = checkAnswers(FIELDS, ACKS, full, [true]);
  assert.deepEqual(yes.ok && [yes.answers, yes.marketingOk], [full, false]);
  assert.equal(checkAnswers(FIELDS, ACKS, { ...full, chronic: true }, [true]).ok, false, 'yes/no is "yes" or "no" only');
  assert.equal(checkAnswers([{ key: 'd', type: 'date', label: 'ת', required: true }], [], { d: '2026-13-40' }, []).ok, false);

  assert.deepEqual(progress(FIELDS, {}), { done: 0, total: 1 });
  assert.deepEqual(progress(FIELDS, { chronic: 'yes', which: 'x' }), { done: 2, total: 3 }, 'the follow-ups count once they open');
  assert.deepEqual(asked(FIELDS, { chronic: 'no' }).map((q) => q.key), ['chronic', 'skin', 'photos']);
  assert.deepEqual(answerLines(FIELDS, ACKS, full).map((l) => [l.text, l.answer ?? null, Boolean(l.indent)]), [
    ['האם חלית במחלה כרונית?', 'כן', false], ['איזו מחלה?', 'סוכרת', true], ['איזה טיפול את/ה מקבל/ת?', 'אינסולין', true],
    ['סוג עור', 'רגיש', false], ['אני מסכים/ה לשימוש בתמונות לפרסום', 'לא', false], ['יש לקרוא בעיון.', null, false], [ACKS[0], 'סומן ✓', false]]);
  assert.equal(requestState({ status: 'sent', expires_at: '2020-01-01T00:00:00Z' }), 'expired');
  assert.equal(requestState({ status: 'signed', expires_at: '2020-01-01T00:00:00Z' }), 'signed');
  assert.ok(validOn(null, '2030-01-01') && validOn('2026-10-09', '2026-10-09') && !validOn('2026-10-08', '2026-10-09'));
  assert.match(declarationMessage('קליניקת נועם', 'נועה', 'https://x/h/abc', 2), /^היי נועה, .*2 הצהרות בריאות.*\nhttps:\/\/x\/h\/abc\n/s);
});

test('the signature: a line, not a dot; a PNG only', async () => {
  assert.ok((await checkSignature(await signature())).ok);
  const dot = await checkSignature(await signature(true));
  assert.equal(dot.ok ? '' : dot.message, 'החתימה קצרה מדי — חתמו בקו, לא בנקודה.');
  assert.equal((await checkSignature('data:image/svg+xml;base64,PHN2Zz4=')).ok, false);
  assert.equal((await checkSignature('data:image/png;base64,AAAA')).ok, false);
  assert.equal((await checkSignature(undefined)).ok, false);
});

test('the PDF: every answer, the signature, the server time — a real PDF', async () => {
  const png = Buffer.from((await signature()).split(',')[1], 'base64');
  const doc = await buildDeclarationPdf({
    business: 'קליניקת נועם', templateTitle: 'הצהרת לייזר', templateVersion: 2, number: 'decl-1', requestId: 'req-1',
    fields: FIELDS, acks: ACKS, answers: full, marketingOk: false, signerName: 'נועה כהן', signaturePng: png,
    signedAt: '2026-10-09T08:30:00Z', ip: '10.1.2.3', userAgent: 'TestPhone/1', software: 'Dream Promotion test',
  });
  const bytes = await doc.save();
  const back = await PDFDocument.load(bytes);
  assert.ok(back.getPageCount() >= 1);
  assert.equal(back.getTitle(), 'הצהרת לייזר — נועה כהן');
  assert.equal(back.getCreationDate()?.toISOString(), '2026-10-09T08:30:00.000Z', 'the time of the signature, from the server');
});

test('templates: a practitioner writes drafts; only the owner approves, after confirming the wording', async () => {
  assert.equal((await staff(CASH, { action: 'templates' })).body.code, 'no_access', 'a cashier sees no declarations');
  const saved = await staff(PRAC, { action: 'template-save', title: 'הצהרת לייזר', treatmentTypeIds: [LASER], validDays: 365, fields: FIELDS, acks: ACKS });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const t = saved.body.template;
  assert.deepEqual([t.status, t.version, t.family_id === t.id], ['draft', 1, true]);
  assert.equal((await staff(PRAC, { action: 'template-save', title: 'x', treatmentTypeIds: ['00000000-0000-4000-8000-000000000999'], fields: [], acks: [] })).status, 400, 'an unknown treatment type');
  assert.equal((await staff(PRAC, { action: 'template-approve', id: t.id, confirmed: true })).body.code, 'owner_only');
  assert.equal((await staff(OWN, { action: 'template-approve', id: t.id })).status, 400, 'not without "הנוסח נבדק ומאושר לשימוש"');
  assert.equal((await staff(OTHER, { action: 'template-approve', id: t.id, confirmed: true })).status, 404, 'another business: no such template');
  const ok = await staff(OWN, { action: 'template-approve', id: t.id, confirmed: true });
  assert.deepEqual([ok.status, ok.body.template.status, ok.body.template.approved_by], [200, 'approved', OWN]);
  assert.equal((await staff(PRAC, { action: 'template-save', id: t.id, title: 'שונה', fields: FIELDS, acks: ACKS })).body.code, 'not_draft', 'approved wording is not edited');
  const v2 = await staff(PRAC, { action: 'template-save', familyOf: t.id, title: 'הצהרת לייזר', treatmentTypeIds: [LASER], validDays: 180, fields: FIELDS, acks: [...ACKS, 'אישור נוסף'] });
  assert.deepEqual([v2.body.template.status, v2.body.template.version, v2.body.template.family_id], ['draft', 2, t.id]);
  assert.equal((await staff(PRAC, { action: 'template-save', familyOf: t.id, title: 'עוד', fields: FIELDS, acks: [] })).body.code, 'draft_exists');
  assert.equal((await staff(OWN, { action: 'template-delete', id: t.id })).body.code, 'not_draft', 'an approved template is archived, not deleted');
});

/** an approved template, sent to Noa: the token as the WhatsApp message would carry it */
async function sentLink() {
  const t = (await staff(OWN, { action: 'template-save', title: 'הצהרת לייזר', treatmentTypeIds: [LASER], validDays: 365, fields: FIELDS, acks: ACKS })).body.template;
  const draft = (await staff(OWN, { action: 'template-save', title: 'טיוטה', fields: FIELDS, acks: ACKS })).body.template;
  await staff(OWN, { action: 'template-approve', id: t.id, confirmed: true });
  return { t, draft, sent: await staff(PRAC, { action: 'send', leadId: NOA, templateIds: [t.id] }) };
}

test('sending: approved only, the token once — the database keeps only its hash', async () => {
  const { t, draft, sent } = await sentLink();
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.match(sent.body.token, /^[0-9a-f]{64}$/, '32 random bytes');
  const row = tables.declaration_requests[0];
  assert.equal(row.token_hash, createHash('sha256').update(sent.body.token).digest('hex'));
  assert.ok(!JSON.stringify(tables).includes(sent.body.token), 'the token itself is nowhere in the database');
  assert.equal(sent.body.request.token_hash, undefined, 'nor sent back as a hash');
  assert.deepEqual([sent.body.firstName, sent.body.business], ['נועה', 'קליניקת נועם']);
  assert.equal((await staff(PRAC, { action: 'send', leadId: NOA, templateIds: [draft.id] })).body.code, 'not_approved', 'a draft is never sent');
  assert.equal((await staff(OTHER, { action: 'send', leadId: NOA, templateIds: [t.id] })).status, 404, 'another business');
  const lead = await staff(PRAC, { action: 'lead', leadId: NOA });
  assert.deepEqual([lead.body.requests.length, lead.body.openTypes], [1, [LASER]], 'the open treatment’s type is pre-selected');
  assert.ok(!JSON.stringify(lead.body).includes('token'), 'the card never sees a token or its hash');

  const again = await staff(PRAC, { action: 'resend', requestId: row.id });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.notEqual(again.body.token, sent.body.token);
  assert.deepEqual(tables.declaration_requests.map((r) => r.status), ['cancelled', 'sent'], '"שלח שוב": the old link cancelled, a new one');
  assert.equal((await pub(sent.body.token)).body.code, 'cancelled', 'the old link says so');
  const n = newToken();
  assert.equal(n.hash, hashToken(n.token));
});

test('the customer’s link: only what the page shows; opened; expired and unknown links refused', async () => {
  const { sent } = await sentLink();
  assert.equal((await pub('f'.repeat(64))).status, 404);
  assert.equal((await pub('not-a-token')).status, 404);
  const g = await pub(sent.body.token);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.deepEqual(Object.keys(g.body).sort(), ['business', 'declarations', 'expiresAt', 'firstName']);
  assert.deepEqual([g.body.business, g.body.firstName, g.body.declarations[0].title], ['קליניקת נועם', 'נועה', 'הצהרת לייזר']);
  assert.ok(!JSON.stringify(g.body).includes(NOA) && !JSON.stringify(g.body).includes(B1) && !JSON.stringify(g.body).includes('כהן'),
    'no ids, and the first name only');
  assert.equal(tables.declaration_requests[0].status, 'opened');
  tables.declaration_requests[0].expires_at = new Date(Date.now() - 60_000).toISOString();
  const late = await pub(sent.body.token);
  assert.deepEqual([late.status, late.body.code, late.body.message], [410, 'expired', 'הקישור פג. בקשו מהקליניקה לשלוח קישור חדש.']);
});

test('signing: checked again on the server; a PDF with its hash; signed once; on the timeline', async () => {
  const { sent } = await sentLink();
  const token = sent.body.token;
  const good = { answers: full, acks: [true], signerName: '  נועה   כהן ', signature: await signature(), confirm: true };
  const refuse = async (d: Record<string, unknown>, missing: string) => {
    const r = await pub(token, { declarations: [{ ...good, ...d }] });
    assert.deepEqual([r.status, r.body.missing], [400, missing], missing);
  };
  await refuse({ answers: { ...full, chronic: undefined } }, 'chronic');
  await refuse({ answers: { ...full, care: '' } }, 'care');
  await refuse({ acks: [] }, 'ack_0');
  await refuse({ signerName: 'נ' }, 'signer_name');
  await refuse({ confirm: false }, 'confirm');
  await refuse({ signature: await signature(true) }, 'signature');
  assert.equal(tables.declarations.length + files.size, 0, 'nothing written for a refused signature');

  const ok = await pub(token, { declarations: [good] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const d = tables.declarations[0];
  assert.deepEqual([d.business_id, d.lead_id, d.signer_name, d.template_version, d.ip, d.user_agent, d.marketing_ok],
    [B1, NOA, 'נועה כהן', 1, '10.1.2.3', 'TestPhone/1', false]);
  assert.deepEqual(d.answers, full);
  const pdf = files.get(d.pdf_path)!;
  assert.equal(pdf.contentType, 'application/pdf');
  assert.equal(d.pdf_sha256, createHash('sha256').update(pdf.bytes).digest('hex'), 'the kept hash is the stored file’s');
  assert.ok(d.pdf_path.startsWith(`${B1}/${NOA}/`) && d.signature_path.startsWith(`${B1}/${NOA}/`) && files.has(d.signature_path));
  assert.equal(Buffer.from(ok.body.pdfs[0].pdf, 'base64').equals(Buffer.from(pdf.bytes)), true, 'the customer’s copy is the same file');
  assert.equal(tables.declaration_requests[0].status, 'signed');
  assert.deepEqual(tables.lead_activities.map((a) => [a.lead_id, a.kind, a.body, a.user_id]), [[NOA, 'note', '📝 הצהרת בריאות נחתמה: הצהרת לייזר', PRAC]]);

  const twice = await pub(token, { declarations: [good] });
  assert.deepEqual([twice.status, twice.body.code], [410, 'signed'], 'the same link again: refused');
  assert.equal(tables.declarations.length, 1);

  // the card: the declaration, and its PDF only after the view is logged
  const card = await staff(OWN, { action: 'lead', leadId: NOA });
  const open = await staff(OWN, { action: 'open', declarationId: d.id });
  assert.match(open.body.url, /ttl=300$/);
  assert.deepEqual(events, [`log:${d.id}`, `sign:${d.pdf_path}`], 'the log line before the link');
  assert.equal((await staff(CASH, { action: 'open', declarationId: d.id })).body.code, 'no_access');
  assert.equal((await staff(OTHER, { action: 'open', declarationId: d.id })).status, 404);
});

test('two phones sign the same link at the same moment: one declaration, the other told it is signed', async () => {
  const { sent } = await sentLink();
  const good = { answers: full, acks: [true], signerName: 'נועה כהן', signature: await signature(), confirm: true };
  const [a, b] = await Promise.all([pub(sent.body.token, { declarations: [good] }), pub(sent.body.token, { declarations: [good] })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 410]);
  assert.equal(tables.declarations.length, 1);
  assert.equal(files.size, 2, 'the loser’s files are removed: one signature, one PDF');
});

test('a clinic’s real form: ID number, phone, headings, and contraindications marked for the owner', async () => {
  const { israeliId, israeliPhone, flagged: marked } = await import('../src/features/client-file/declarations');
  assert.equal(israeliId('123456782'), '123456782');
  assert.equal(israeliId('39337423'), '039337423', 'fewer than 9 digits: padded with zeros');
  assert.equal(israeliId('123456789'), null, 'a wrong check digit');
  assert.equal(israeliId('12-34'), null);
  assert.equal(israeliPhone('050-356-6969'), '0503566969');
  assert.equal(israeliPhone('+972 50 3566969'), '0503566969');
  assert.equal(israeliPhone('12345'), null);

  const fields = cleanFields([
    { key: 'h1', type: 'heading', label: 'פרטים אישיים', required: true },
    { key: 'tz', type: 'id_number', label: 'תעודת זהות' },
    { key: 'tel', type: 'phone', label: 'טלפון נייד' },
    { key: 'preg', type: 'yesno', label: 'הריון או במהלך תקופת הנקה (התווית נגד אבסולוטית)', flag: true },
    { key: 'meds', type: 'yesno', label: 'האם הנך נוטלת תרופות?', flag: 'yes' },
  ]);
  assert.ok(fields.ok);
  const fs = fields.ok ? fields.fields : [];
  assert.deepEqual(fs.map((f) => [f.type, f.required, f.flag ?? false]),
    [['heading', false, false], ['id_number', true, false], ['phone', true, false], ['yesno', true, true], ['yesno', true, false]],
    'a heading is never asked; only a real true marks a question');
  const bad = checkAnswers(fs, [], { tz: '123456789', tel: '0501234567', preg: 'no', meds: 'no' }, []);
  assert.equal(bad.ok ? '' : bad.message, 'מספר תעודת הזהות לא תקין: תעודת זהות');
  const ok = checkAnswers(fs, [], { h1: 'x', tz: '39337423', tel: '+972-50-123-4567', preg: 'yes', meds: 'yes' }, []);
  assert.deepEqual(ok.ok && ok.answers, { tz: '039337423', tel: '0501234567', preg: 'yes', meds: 'yes' });
  assert.deepEqual(marked(fs, ok.ok ? ok.answers : {}), ['הריון או במהלך תקופת הנקה (התווית נגד אבסולוטית)'], 'only the marked question');
  assert.deepEqual(progress(fs, {}), { done: 0, total: 4 }, 'the heading is not counted');
  const lines = answerLines(fs, [], ok.ok ? ok.answers : {});
  assert.deepEqual(lines.map((l) => [l.heading ?? false, l.flagged ?? false]), [[true, false], [false, false], [false, false], [false, true], [false, false]]);

  // the PDF draws the heading and the mark
  const png = Buffer.from((await signature()).split(',')[1], 'base64');
  const pdf = await buildDeclarationPdf({ business: 'ס', templateTitle: 'קרבון', templateVersion: 1, number: 'n', requestId: 'r', fields: fs, acks: [],
    answers: ok.ok ? ok.answers : {}, marketingOk: null, signerName: 'נועה כהן', signaturePng: png, signedAt: '2026-10-09T08:30:00Z', ip: '', userAgent: '', software: 't' });
  assert.ok((await pdf.save()).byteLength > 1000);
});

test('the card is told which contraindications were answered "כן" — never the answers themselves', async () => {
  const fields = [...FIELDS, { key: 'preg', type: 'yesno', label: 'הריון (התווית נגד אבסולוטית)', required: true, flag: true }];
  const t = (await staff(OWN, { action: 'template-save', title: 'קרבון', treatmentTypeIds: [LASER], fields, acks: ACKS })).body.template;
  await staff(OWN, { action: 'template-approve', id: t.id, confirmed: true });
  const sent = await staff(OWN, { action: 'send', leadId: NOA, templateIds: [t.id] });
  const r = await pub(sent.body.token, { declarations: [{ answers: { ...full, preg: 'yes' }, acks: [true], signerName: 'נועה כהן', signature: await signature(), confirm: true }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(tables.lead_activities[0].body, /⚠️ לתשומת לב \(התווית נגד\): הריון \(התווית נגד אבסולוטית\)$/);
  const card = await staff(OWN, { action: 'lead', leadId: NOA });
  assert.deepEqual(card.body.declarations[0].flags, ['הריון (התווית נגד אבסולוטית)']);
  assert.equal(card.body.declarations[0].answers, undefined, 'the answers stay on the server');
  assert.equal(card.body.templates[0].fields, undefined);
});
