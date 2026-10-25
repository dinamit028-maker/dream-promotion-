/**
 * טופס 101 on the server (2.108): the employer sends a link (its token kept only as a hash) → the employee's link shows the form
 * prefilled from the card → an attachment (its type read from its bytes, into the link's own folder) → the form signed (checked
 * again: the fields, a real signature, the confirmation) → the PDF kept, the version, the link closed (a second signature refused)
 * → the employer reads it, marks it reviewed (once), adds the hand-signed paper (once). Who may: the admin; payroll reads and
 * reviews; an approver, a viewer, a cashier and another business — nothing. (The rules of the tables: tests/sql/form101.check.sql.)
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { fakeDb } from './fakedb';
import { resetRateLimits } from '../src/lib/server/rate-limit';
import { hashToken } from '../src/lib/server/declarations';

const OWN = 'user-own', APPR = 'user-appr', PAY = 'user-pay', VIEW = 'user-view', OTHER = 'user-other';
const B1 = '00000000-0000-4000-8000-00000000f001', B2 = '00000000-0000-4000-8000-00000000f002';
const DANA = '00000000-0000-4000-8000-0000000000e1', ZAR = '00000000-0000-4000-8000-0000000000e2';
const tables: Record<string, any[]> = {};
const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
const current: Record<string, string> = { [OWN]: B1, [APPR]: B1, [PAY]: B1, [VIEW]: B1, [OTHER]: B2 };

function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  files.clear(); resetRateLimits();
  Object.assign(tables, {
    profiles: [OWN, APPR, PAY, VIEW, OTHER].map((id) => ({ id, is_super_admin: false, full_name: id === PAY ? 'רואה החשבון' : 'רונית' })),
    businesses: [{ id: B1, name: 'מסעדת הים', status: 'active', paid_until: null, grace_days: 0, modules: ['dream', 'attendance'] },
      { id: B2, name: 'אחר', status: 'active', paid_until: null, grace_days: 0, modules: ['dream', 'attendance'] }],
    business_members: [
      { business_id: B1, user_id: OWN, role: 'owner', access: 'full', attendance_role: null },
      { business_id: B1, user_id: APPR, role: 'editor', access: 'full', attendance_role: 'approver' },
      { business_id: B1, user_id: PAY, role: 'viewer', access: 'full', attendance_role: 'payroll' },
      { business_id: B1, user_id: VIEW, role: 'viewer', access: 'full', attendance_role: null },
      { business_id: B2, user_id: OTHER, role: 'owner', access: 'full', attendance_role: null }],
    brands: [{ business_id: B1, name: 'מסעדת הים' }],
    register_settings: [{ business_id: B1, legal_name: 'הים בע"מ', street: 'הנמל', house_no: '1', city: 'חיפה' }],
    timeclock_settings: [{ business_id: B1, user_id: OWN, employer_deductions_file: '912345678', employer_phone: '04-1234567' }],
    employees: [{ id: DANA, business_id: B1, name: 'דנה כהן', phone: '050-1234567', start_date: '2026-02-01', active: true },
      { id: ZAR, business_id: B2, name: 'זר', phone: '', start_date: null, active: true }],
    employee_private: [{ employee_id: DANA, business_id: B1, id_number: '123456782' }],
    form101_requests: [], form101_submissions: [], push_subscriptions: [],
  });
}
const storage = {
  from: () => ({
    upload: async (path: string, bytes: Uint8Array, o: { contentType: string; upsert?: boolean }) => {
      if (!o.upsert && files.has(path)) return { data: null, error: { message: 'exists' } };
      files.set(path, { bytes: new Uint8Array(bytes), contentType: o.contentType }); return { data: { path }, error: null };
    },
    remove: async (paths: string[]) => { paths.forEach((p) => files.delete(p)); return { data: [], error: null }; },
    list: async (folder: string) => ({ data: [...files.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/'))
      .map((p) => ({ name: p.slice(folder.length + 1), id: 'f' })), error: null }),
    createSignedUrl: async (path: string, s: number) => ({ data: { signedUrl: `https://sb.test/${path}?ttl=${s}` }, error: null }),
  }),
};
before(() => {
  // the database's triggers of 5900, in short: a submission only on an open link, its version, the link closed
  const rules = {
    onInsert: (t: string, row: any) => {
      if (t === 'form101_requests') { row.status ??= 'sent'; row.kind ??= 'year'; return null; }
      if (t !== 'form101_submissions') return null;
      const r = tables.form101_requests.find((x) => x.id === row.request_id);
      if (!r || !['sent', 'opened'].includes(r.status)) return { code: '23514', message: 'form101: the link is no longer valid' };
      row.version = 1 + Math.max(0, ...tables.form101_submissions.filter((s) => s.employee_id === row.employee_id && s.tax_year === row.tax_year).map((s) => s.version));
      row.submitted_at = new Date().toISOString();
      r.status = 'submitted';
      return null;
    },
  };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    from: (t: string) => fakeDb(tables, rules).from(t),
    auth: { getUser: async (t: string) => ({ data: { user: Object.keys(current).includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string, a: any) => (fn === 'business_for_user' ? { data: current[a.uid] ?? null, error: null } : { data: null, error: null }),
    storage,
  };
});
beforeEach(reset);

const boss = async (user: string, query: string, body?: unknown) => {
  const m = await import('../src/app/api/attendance/form101/route');
  const headers = { authorization: `Bearer ${user}` };
  const r = body === undefined ? await m.GET(new Request(`http://x/api/attendance/form101${query}`, { headers }))
    : await m.POST(new Request('http://x/api/attendance/form101', body instanceof FormData ? { method: 'POST', headers, body } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const link = async (token: string, body?: unknown) => {
  const m = await import('../src/app/api/f101/[token]/route');
  const req = new Request(`http://x/api/f101/${token}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'user-agent': 'TestPhone/1', 'x-forwarded-for': '10.1.2.3' } });
  const r = await (body === undefined ? m.GET : m.POST)(req, { params: Promise.resolve({ token }) });
  return { status: r.status, body: await r.json() };
};
const upload = async (token: string, kind: string, bytes: Uint8Array, name = 'id.jpg') => {
  const m = await import('../src/app/api/f101/[token]/file/route');
  const fd = new FormData(); fd.append('kind', kind); fd.append('file', new File([bytes as BlobPart], name));
  const r = await m.POST(new Request(`http://x/api/f101/${token}/file`, { method: 'POST', body: fd }), { params: Promise.resolve({ token }) });
  return { status: r.status, body: await r.json() };
};
const signature = async () => `data:image/png;base64,${(await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><path d="M50 200 C 200 50, 350 250, 600 120" stroke="#111" stroke-width="6" fill="none"/></svg>')).png().toBuffer()).toString('base64')}`;
const jpeg = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } }).jpeg().toBuffer();

async function send(user = OWN, kind: 'year' | 'update' = 'year') {
  const s = await boss(user, '', { action: 'send', employeeId: DANA, kind, year: 2026 });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return String(s.body.path).split('/f/')[1];
}
function fill(data: any) {
  Object.assign(data.employee, { birthDate: '1990-05-01', street: 'הרצל', houseNumber: '5', city: 'חיפה', gender: 'female', marital: 'single', resident: true, kibbutz: 'no', hmo: true, hmoName: 'כללית' });
  data.income.kinds = ['monthly']; data.other.has = false; data.credits.resident = true;
  return data;
}

test('form 101 API: send → the link prefilled → an attachment → signed → the PDF, version 1, the link closed', async () => {
  const token = await send();
  assert.match(token, /^[0-9a-f]{64}$/);
  const req = tables.form101_requests[0];
  assert.equal(req.token_hash, hashToken(token), 'only the hash is kept'); assert.ok(!JSON.stringify(req).includes(token));
  assert.equal(req.sent_by, OWN);

  const got = await link(token);
  assert.equal(got.status, 200);
  assert.deepEqual([got.body.employer, got.body.taxYear, got.body.update], ['הים בע"מ', 2026, false]);
  assert.deepEqual([got.body.data.employee.firstName, got.body.data.employee.lastName, got.body.data.employee.idNumber, got.body.data.income.startDate], ['דנה', 'כהן', '123456782', '2026-02-01']);
  assert.ok(!JSON.stringify(got.body).includes(DANA) && !JSON.stringify(got.body).includes(B1), 'no id of the employee or the business');
  assert.equal(tables.form101_requests[0].status, 'opened');

  // an attachment: its type from its bytes; a script named .jpg is refused
  assert.equal((await upload(token, 'id', new TextEncoder().encode('<script>'), 'x.jpg')).status, 415);
  const f = await upload(token, 'id', await jpeg());
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.ok(f.body.path.startsWith(`${B1}/${DANA}/${req.id}/`) && f.body.type === 'image/jpeg');

  // checked again: a missing field, no signature, no confirmation
  const data = got.body.data;
  const missing = await link(token, { data, signerName: 'דנה כהן', signature: await signature(), confirm: true, attachments: [f.body] });
  assert.equal(missing.status, 400); assert.equal(missing.body.step, 'personal');
  fill(data);
  assert.equal((await link(token, { data, signerName: 'דנה כהן', signature: await signature(), confirm: false })).body.field, 'confirm');
  assert.equal((await link(token, { data, signerName: 'דנה כהן', signature: '', confirm: true })).body.field, 'signature');
  // a path of another folder is not taken as an attachment
  const signed = await link(token, { data, signerName: 'דנה כהן', signature: await signature(), confirm: true,
    attachments: [f.body, { kind: 'immigrant', path: `${B2}/x/y.pdf`, name: 'x' }] });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.version, 1);
  const back = await PDFDocument.load(Buffer.from(signed.body.pdf, 'base64'));
  assert.equal(back.getTitle(), 'טופס 101 — דנה כהן — 2026');
  const s = tables.form101_submissions[0];
  assert.deepEqual([s.tax_year, s.version, s.form_code, s.user_agent], [2026, 1, '0101/130 · 11.2025', 'TestPhone/1']);
  assert.equal(s.ip, '10.1.2.3', 'where it was signed from');
  assert.deepEqual(s.attachments.map((a: any) => a.kind), ['id']);
  assert.ok(files.has(s.pdf_path) && files.has(s.signature_path));
  assert.equal(tables.form101_requests[0].status, 'submitted');
  // the link is used: a second signature, a second look — refused
  assert.equal((await link(token)).status, 410);
  assert.equal((await link(token, { data, signerName: 'דנה כהן', signature: await signature(), confirm: true })).status, 410);
});

test('form 101 API: an update during the year — version 2, the first kept; a new link cancels the open one', async () => {
  const t1 = await send();
  const d1 = fill((await link(t1)).body.data);
  await link(t1, { data: d1, signerName: 'דנה כהן', signature: await signature(), confirm: true });
  const open = await send(OWN, 'update');
  const again = await send(OWN, 'update');
  assert.equal(tables.form101_requests.find((r) => r.token_hash === hashToken(open))!.status, 'cancelled', 'one open link per employee and year');
  const g = await link(again);
  assert.equal(g.body.update, true); assert.equal(g.body.data.employee.city, 'חיפה', 'last form prefilled');
  g.body.data.employee.city = 'תל אביב'; g.body.data.changeNote = 'עברתי דירה';
  const s2 = await link(again, { data: g.body.data, signerName: 'דנה כהן', signature: await signature(), confirm: true });
  assert.equal(s2.body.version, 2);
  const forms = (await boss(OWN, `?employeeId=${DANA}`)).body;
  assert.deepEqual(forms.forms.map((f: any) => f.version).sort(), [1, 2]);
  assert.equal(forms.forms.find((f: any) => f.version === 2).changeNote, 'עברתי דירה');
  assert.deepEqual(forms.forms.find((f: any) => f.version === 1).missing, ['id'], 'the ID was not attached — said, never refused');
});

test('form 101 API: the employer — review once (payroll too), the hand-signed paper once, the files through short links', async () => {
  const t = await send();
  await link(t, { data: fill((await link(t)).body.data), signerName: 'דנה כהן', signature: await signature(), confirm: true });
  const id = tables.form101_submissions[0].id;
  assert.equal((await boss(PAY, '', { action: 'review', submissionId: id, note: 'הוזן לשכר' })).status, 200, 'the accountant marks it');
  assert.equal((await boss(OWN, '', { action: 'review', submissionId: id, note: 'שוב' })).status, 409, 'once');
  assert.equal(tables.form101_submissions[0].reviewed_by, PAY);
  const fd = new FormData(); fd.append('action', 'paper'); fd.append('submissionId', id); fd.append('file', new File([await jpeg()], 'p.jpg', { type: 'image/jpeg' }));
  assert.equal((await boss(OWN, '', fd)).status, 200);
  const fd2 = new FormData(); fd2.append('action', 'paper'); fd2.append('submissionId', id); fd2.append('file', new File([await jpeg()], 'p.jpg', { type: 'image/jpeg' }));
  assert.equal((await boss(OWN, '', fd2)).status, 409, 'the paper once');
  const url = await boss(PAY, `?file=${id}&part=pdf`);
  assert.match(url.body.url, /^https:\/\/sb\.test\/.+\.pdf\?ttl=60$/);
  assert.equal((await boss(OWN, `?file=${id}&part=attachment&n=5`)).status, 404);
  const year = (await boss(OWN, '?year=2026')).body;
  assert.deepEqual(year.submitted.map((s: any) => s.employee_id), [DANA]);
});

test('form 101 API: who may — the admin sends; payroll reads, not sends; an approver, a viewer, another business — nothing', async () => {
  assert.equal((await boss(PAY, '', { action: 'send', employeeId: DANA })).status, 403);
  for (const u of [APPR, VIEW]) {
    assert.equal((await boss(u, `?employeeId=${DANA}`)).status, 403, u);
    assert.equal((await boss(u, '', { action: 'send', employeeId: DANA })).status, 403, u);
  }
  await send();
  assert.equal((await boss(PAY, `?employeeId=${DANA}`)).status, 200);
  assert.equal((await boss(OTHER, '', { action: 'send', employeeId: DANA })).status, 404, 'an employee of another business is not found');
  assert.deepEqual((await boss(OTHER, `?employeeId=${DANA}`)).body.links, [], 'nothing of another business');
  assert.equal((await link('0'.repeat(64))).status, 404);
  assert.equal((await link('not-a-token')).status, 404);
});

test('form 101 API: an expired or cancelled link takes nothing; the employer\'s deductions file — 9 digits from 9', async () => {
  const t = await send();
  tables.form101_requests[0].expires_at = '2020-01-01T00:00:00Z';
  assert.equal((await link(t)).status, 410);
  assert.equal(tables.form101_requests[0].status, 'expired');
  const t2 = await send();
  const r2 = tables.form101_requests.find((r) => r.token_hash === hashToken(t2))!;
  assert.equal((await boss(OWN, '', { action: 'cancel', requestId: r2.id })).status, 200);
  assert.equal((await link(t2)).body.code, 'cancelled');
  assert.equal((await boss(OWN, '', { action: 'employer', deductionsFile: '123', phone: '' })).status, 400);
  const ok = await boss(OWN, '', { action: 'employer', deductionsFile: '987654321', phone: '03-5555555' });
  assert.equal(ok.status, 200); assert.equal(ok.body.employer.deductionsFile, '987654321');
});
