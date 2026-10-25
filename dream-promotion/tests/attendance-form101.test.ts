import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECLARATION, FORM, attachmentsAsked, cleanForm, emptyForm, form101Text, missingAttachments, prefill, problems, warnings, withoutForm,
  type Form101Data,
} from '../src/features/attendance/form101';

const filled = (): Form101Data => {
  const d = emptyForm();
  Object.assign(d.employee, {
    idNumber: '123456782', lastName: 'כהן', firstName: 'דנה', birthDate: '1990-05-01', street: 'הרצל', houseNumber: '5', city: 'חיפה',
    gender: 'female', marital: 'single', resident: true, kibbutz: 'no', hmo: true, hmoName: 'כללית',
  });
  d.income = { kinds: ['monthly'], startDate: '2026-02-01' };
  d.other.has = false;
  return d;
};

test('form 101: the official form of 2026 — its number, year and the declaration word for word', () => {
  assert.deepEqual([FORM.code, FORM.taxYear, FORM.updated], ['0101/130', 2026, '11.2025']);
  assert.ok(DECLARATION.startsWith('אני מצהיר/ה כי הפרטים שמסרתי בטופס זה הינם מלאים ונכונים.'));
  assert.ok(DECLARATION.endsWith('תוך שבוע ימים מתאריך השינוי.'));
});

test('form 101: what arrives is cleaned — unknown keys out, values clipped and typed, an empty child dropped', () => {
  const d = cleanForm({ employee: { idNumber: '12-345-678-2', gender: 'x', marital: 'married', resident: 'yes', evil: '<script>' }, children: [{}, { name: 'נועה', birthDate: '2020-01-01', inCustody: 1 }],
    income: { kinds: ['monthly', 'bogus'], startDate: '2026-13-01' }, other: { has: false } });
  assert.equal(d.employee.idNumber, '123456782');
  assert.equal(d.employee.gender, ''); assert.equal(d.employee.marital, 'married'); assert.equal(d.employee.resident, null, 'only true/false, never a string');
  assert.ok(!('evil' in d.employee));
  assert.equal(d.children.length, 1); assert.equal(d.children[0].inCustody, false, 'only true is true');
  assert.deepEqual(d.income.kinds, ['monthly']); assert.equal(d.income.startDate, '', 'an impossible date is no date');
  assert.equal(cleanForm(null).employee.firstName, '');
});

test('form 101: what must be filled — identity and the form\'s choices; never a credit the employee did not ask for', () => {
  assert.deepEqual(problems(filled()), []);
  const e = emptyForm();
  const fields = problems(e).map((p) => p.field);
  for (const f of ['idNumber', 'lastName', 'firstName', 'birthDate', 'address', 'gender', 'marital', 'resident', 'kibbutz', 'hmo', 'kinds', 'has']) assert.ok(fields.includes(f), f);
  const bad = filled(); bad.employee.idNumber = '123456789';
  assert.match(problems(bad)[0].message, /לא תקין/);
  const passport = filled(); passport.employee.idNumber = ''; passport.employee.passport = 'A1234567';
  assert.deepEqual(problems(passport), [], 'a passport instead of an ID');
  const wed = filled(); wed.employee.marital = 'married';
  assert.deepEqual(problems(wed).map((p) => p.step), ['spouse', 'spouse']);
  const other = filled(); other.other.has = true;
  assert.equal(problems(other)[0].field, 'kinds');
});

test('form 101: the form\'s own explanations when the answers call for them', () => {
  const d = filled(); d.other = { has: true, kinds: ['monthly'], creditsHere: false, creditsElsewhere: false, noStudyFund: false, noPension: false };
  const w = warnings(d);
  assert.ok(w.some((x) => x.startsWith('(7)')) && w.some((x) => x.startsWith('(9)')) && w.some((x) => x.startsWith('(10)')));
  d.other.creditsHere = true; d.other.noStudyFund = true; d.other.noPension = true;
  assert.deepEqual(warnings(d), []);
  d.credits.disabledAllowance = true;
  assert.ok(warnings(d).some((x) => x.startsWith('(14)')), '2ב without 2א');
  assert.deepEqual(warnings(filled()), [], 'nothing to say');
});

test('form 101: the attachments the form asks for, by what was marked — missing ones said, never a refusal', () => {
  const d = filled();
  assert.deepEqual(attachmentsAsked(d), ['id']);
  d.employee.marital = 'separated'; d.credits.immigrant = true; d.credits.discharged = true; d.coordination.hasOthers = true;
  assert.deepEqual(attachmentsAsked(d), ['id', 'separated', 'immigrant', 'discharge', 'payslips']);
  assert.deepEqual(missingAttachments(d, ['id', 'immigrant']), ['separated', 'discharge', 'payslips']);
  const p = filled(); p.employee.idNumber = ''; p.employee.passport = 'X1';
  assert.deepEqual(attachmentsAsked(p), ['passport']);
});

test('form 101: a new form every tax year — who has none for the year; last year\'s details prefilled, the year\'s parts fresh', () => {
  const emps = [{ id: 'a', active: true }, { id: 'b', active: true }, { id: 'c', active: false }];
  const subs = [{ employeeId: 'a', taxYear: 2026 }, { employeeId: 'b', taxYear: 2025 }];
  assert.deepEqual(withoutForm(emps, subs, 2026).map((e) => e.id), ['b'], 'b signed last year only; c left');
  const last = filled(); last.credits.resident = true; last.credits.immigrant = true; last.coordination.hasOthers = true;
  const next = prefill({ name: 'דנה כהן' }, last, 2027, 2026);
  assert.equal(next.employee.city, 'חיפה', 'the details carry on');
  assert.equal(next.credits.resident, true); assert.equal(next.credits.immigrant, false, 'a year\'s credit is asked again');
  assert.equal(next.coordination.hasOthers, false); assert.equal(next.income.startDate, '');
  const same = prefill({}, last, 2026, 2026);
  assert.equal(same.credits.immigrant, true, 'an update during the year keeps the year');
  const first = prefill({ name: 'אבי בן דוד', phone: '0501234567', idNumber: '123456782', startDate: '2026-03-01' }, null, 2026, null);
  assert.deepEqual([first.employee.firstName, first.employee.lastName, first.employee.idNumber, first.income.startDate], ['אבי', 'בן דוד', '123456782', '2026-03-01']);
});

test('form 101: the WhatsApp message — the link, nothing of Dream', () => {
  const t = form101Text('דנה כהן', 'מסעדת הים', 'https://x/f/abc', 2026, false);
  assert.match(t, /^שלום דנה, זה הקישור למילוי טופס 101 לשנת המס 2026 של מסעדת הים:\nhttps:\/\/x\/f\/abc\n/);
  assert.ok(!/dream/i.test(t));
  assert.match(form101Text('דנה', '', 'L', 2026, true), /עדכון פרטים/);
});

test('form 101: the PDF\'s content — the official sections in order, only what was marked, the attachments, the warnings', async () => {
  const { pdfSections } = await import('../src/features/attendance/form101');
  const d = filled();
  d.children = [{ name: 'נועה', idNumber: '', birthDate: '2020-03-04', inCustody: true, allowance: true }];
  d.credits.resident = true; d.credits.reserveCombat = true; d.credits.reserveDays = '30';
  d.other = { has: true, kinds: ['partial'], creditsHere: false, creditsElsewhere: false, noStudyFund: true, noPension: true };
  const s = pdfSections(d, { name: 'מסעדת הים', address: 'הנמל 1, חיפה', phone: '04-1234567', deductionsFile: '912345678' }, ['id']);
  assert.deepEqual(s.map((x) => x.title.slice(0, 2)), ['א.', 'ב.', 'ג.', 'ד.', 'ה.', 'ח.', 'ט.', 'נס'], 'not married: no ו; no change: no ז');
  assert.deepEqual(s[0].rows[3], ['מספר תיק ניכויים', '912345678']);
  assert.match(s[2].rows[0][1], /04\/03\/2020 · בחזקתי \(טור 1\) · מקבל\/ת בגינו קצבת ילדים \(טור 2\)/);
  const credits = s.find((x) => x.title.startsWith('ח.'))!;
  assert.deepEqual(credits.rows.map((r) => r[0]), ['1', '16'], 'only what was marked');
  assert.match(credits.rows[1][1], /סה"כ 30 ימי מילואים/);
  const att = s[s.length - 1];
  assert.deepEqual(att.rows, [['צילום תעודת זהות כולל ספח', 'צורף'], ['אישור מצה"ל על זכאות בעד שירות מילואים כלוחם', 'לא צורף']]);
  assert.ok(att.notes?.some((n) => n.startsWith('(7)')), 'the form\'s explanation (7)');
});

test('form 101: the signed form as a real PDF — Hebrew, the year in the title, the server\'s time', async () => {
  const sharp = (await import('sharp')).default;
  const { PDFDocument } = await import('pdf-lib');
  const { buildForm101Pdf } = await import('../src/lib/server/form101');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><path d="M50 200 C 200 50, 350 250, 600 120" stroke="#111" stroke-width="6" fill="none"/></svg>';
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const d = filled(); d.credits.resident = true;
  const doc = await buildForm101Pdf({ data: d, employer: { name: 'מסעדת הים', address: 'הנמל 1, חיפה', phone: '', deductionsFile: '912345678' }, attached: ['id'],
    taxYear: 2026, version: 1, number: 'f-1', requestId: 'r-1', signerName: 'דנה כהן', signaturePng: png, signedAt: '2026-10-25T08:00:00Z',
    ip: '10.0.0.1', userAgent: 'TestPhone/1', software: 'Dream Promotion test' });
  const back = await PDFDocument.load(await doc.save());
  assert.ok(back.getPageCount() >= 1);
  assert.equal(back.getTitle(), 'טופס 101 — דנה כהן — 2026');
  assert.equal(back.getCreationDate()?.toISOString(), '2026-10-25T08:00:00.000Z');
});
