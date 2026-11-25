/**
 * 2.117 — the unified file against the official text of spec 1.31 (horaot-131.pdf, checked 22.11.2026):
 *   tax withheld at source (clarification 4, p. 21; fields 1219–1224, p. 12), 1258 kind of transaction (p. 13),
 *   the character set (§2.4ח, p. 6), 1233 operator (p. 12), 1010 software vendor (p. 10).
 * Only the file changes: a document that was issued is not changed and does not look different.
 * Demo data only (fictitious numbers).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  A000, C100, D110, X, buildOpenFormat, docCodesMap, docTypeReport, fileTotal, filePayments, isoText, operatorOf, toIso88598, txKind, withheldOf, type Doc,
} from '../src/features/documents/openformat';
import { creditForRefund, docFromSale, toDoc } from '../src/features/documents/documents';
import { composeCredit, computeLines } from '../src/features/finance/compose';
import { docFromBase, type BaseDoc } from '../src/features/finance/goods';
import { loadDocCodes } from '../src/features/documents/doc-codes';

// read when DocumentsTab is first imported (below, dynamically): a fictitious vendor, never the real one
process.env.NEXT_PUBLIC_SOFTWARE_VENDOR_NAME = '  יצרן דמו בע״מ  ';
process.env.NEXT_PUBLIC_SOFTWARE_VENDOR_VAT = '000000109';

const biz = { dealerNumber: '000000109', name: 'עסק דמו', street: 'הדמו', houseNo: '1', city: 'עיר דמו', zip: '' };
const sw = { regNumber: '00000000', name: 'Dream Promotion', version: '2.117.0', vendorVat: '000000109', vendorName: 'Dream Promotion' };
const col = (s: string, from: number, to: number) => s.slice(from - 1, to); // spec columns are 1-based, inclusive
const at = { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-22T08:00:00Z', id: '123456789012345' };
const bytesOk = (b: Uint8Array) => [...b].every((c) => c === 0x0d || c === 0x0a || (c >= 0x20 && c <= 0x7e) || (c >= 0xe0 && c <= 0xfa));

// ---------- 1. tax withheld at source — clarification 4: paid 1250, withheld 250 → 1219 / 1221 / 1223 = 1000, 1224 = 250 ----------
const receipt: Doc = {
  docType: 400, docNumber: 12, linkNo: 77, issuedAt: '2026-11-10T09:00:00Z', docDate: '2026-11-10', customerName: 'לקוח דמו בע"מ',
  beforeDiscount: 1250, discount: 0, afterDiscount: 1250, vatAmount: 0, total: 1250, issuedBy: '',
  lines: [{ name: 'תשלום עבור חשבונית מס מס׳ 5', qty: 1, unitPriceExVat: 1250, discountExVat: 0, totalExVat: 1250, vatRate: 0, kind: 1 }],
  payments: [{ method: 4, amount: 1000, date: '2026-11-10', m: 'transfer' }, { method: 9, amount: 250, date: '2026-11-10', m: 'withholding', pct: 20 }],
};

test('clarification 4 (p. 21): a receipt with tax withheld — 1219, 1221, 1223 = 1000; 1220, 1222 = 0; 1224 = 250 (positive)', () => {
  const c = C100(2, biz, receipt);
  assert.equal(c.length, 444);
  assert.equal(col(c, 288, 302), '+00000000100000', '1219 before discount, without the withholding');
  assert.equal(col(c, 303, 317), '+00000000000000', '1220 discount 0');
  assert.equal(col(c, 318, 332), '+00000000100000', '1221 after discount, without the withholding');
  assert.equal(col(c, 333, 347), '+00000000000000', '1222 VAT 0');
  assert.equal(col(c, 348, 362), '+00000000100000', '1223 "בקבלה, סכום ללא הניכוי במקור"');
  assert.equal(col(c, 363, 374), '+00000025000', '1224 the withholding, X9(9)v99, positive (§2.4יב)');
  assert.equal(withheldOf(receipt), 250);
});

test('clarification 4: no D120 line for the withholding — the D120 lines add up to 1223; the document itself is not changed', () => {
  const before = structuredClone(receipt);
  const f = buildOpenFormat(biz, sw, [receipt], at);
  assert.deepEqual(receipt, before, 'the document (and its payments) as it was');
  assert.equal((f.counts as Record<string, number>).D120, 1);
  const recs = f.bkmv.trimEnd().split('\r\n');
  const c = recs.find((l) => l.startsWith('C100'))!;
  const d120 = recs.filter((l) => l.startsWith('D120'));
  assert.equal(d120.length, 1);
  assert.equal(col(d120[0], 50, 50), '4', 'the transfer');
  assert.equal(col(d120[0], 46, 49), '0001', 'line numbers run from 1');
  const sum = d120.reduce((a, l) => a + Number(col(l, 105, 118)), 0);
  assert.equal(sum, Number(col(c, 349, 362)), 'Σ 1312 = 1223');
  assert.equal(recs.length, f.totalRecords);
  recs.forEach((l, i) => assert.equal(Number(col(l, 5, 13)), i + 1, 'record numbers run 1..n'));
  assert.ok(f.ini.includes('D120' + '1'.padStart(15, '0')), 'INI: one D120');
});

test('clarification 4: only the withholding goes — Bit / link (code 9 too) stay payment lines; a receipt without it is as before', () => {
  const bit: Doc = { ...receipt, payments: [{ method: 9, amount: 1000, date: '2026-11-10', m: 'bit' }, { method: 9, amount: 250, date: '2026-11-10', m: 'withholding', pct: 20 }] };
  assert.deepEqual(filePayments(bit).map((p) => p.m), ['bit']);
  const plain: Doc = { ...receipt, payments: [{ method: 1, amount: 1250, date: '2026-11-10', m: 'cash' }] };
  const c = C100(2, biz, plain);
  assert.equal(col(c, 348, 362), '+00000000125000'); assert.equal(col(c, 363, 374), '+00000000000');
  assert.equal((buildOpenFormat(biz, sw, [plain], at).counts as Record<string, number>).D120, 1);
});

test('clarification 4: a tax invoice-receipt (320) with tax withheld is written as before (open question to the accountant)', () => {
  const d: Doc = { ...receipt, docType: 320, beforeDiscount: 1059.32, afterDiscount: 1059.32, vatAmount: 190.68, total: 1250,
    lines: [{ name: 'שירות', qty: 1, unitPriceExVat: 1059.32, discountExVat: 0, totalExVat: 1059.32, vatRate: 18, kind: 1 }] };
  const c = C100(2, biz, d);
  assert.equal(col(c, 348, 362), '+00000000125000'); assert.equal(col(c, 363, 374), '+00000000000');
  assert.equal((buildOpenFormat(biz, sw, [d], at).counts as Record<string, number>).D120, 2);
});

test('§2.6ב (p. 9): the printout by type = the sum of 1223 in the file, per type — a receipt with tax withheld too', () => {
  const docs: Doc[] = [receipt, { ...receipt, docNumber: 13, payments: [{ method: 1, amount: 1250, date: '2026-11-10', m: 'cash' }] },
    { ...receipt, docType: 320, docNumber: 4, beforeDiscount: 1059.32, afterDiscount: 1059.32, vatAmount: 190.68, total: 1250,
      lines: [{ name: 'שירות', qty: 1, unitPriceExVat: 1059.32, discountExVat: 0, totalExVat: 1059.32, vatRate: 18, kind: 1 }] },
    { ...receipt, docType: 305, docNumber: 2, total: 99.99, beforeDiscount: 84.74, afterDiscount: 84.74, vatAmount: 15.25, payments: [] },
    { ...receipt, docNumber: 14, docDate: '2026-12-01' }];
  const f = buildOpenFormat(biz, sw, docs, at);
  const inFile = new Map<number, number>();
  for (const l of f.bkmv.split('\r\n').filter((x) => x.startsWith('C100'))) {
    const t = Number(col(l, 23, 25)); inFile.set(t, (inFile.get(t) ?? 0) + Number(col(l, 349, 362)) * (col(l, 348, 348) === '-' ? -1 : 1));
  }
  const rep = docTypeReport(docs, at.from, at.to);
  for (const r of rep) assert.equal(Math.round(r.total * 100), inFile.get(r.code) ?? 0, `${r.code}`);
  assert.equal(rep.find((r) => r.code === 400)!.total, 2250, '1000 (withheld 250) + 1250; the December one is outside the period');
  assert.equal(rep.find((r) => r.code === 400)!.count, 2);
  assert.equal(fileTotal(receipt), 1000);
});

// ---------- 2. 1258 kind of transaction: 1 service, 2 sale ----------
test('1258 (p. 13): a product of the price list is a sale (2); a service, a package, a hand-typed line — a service (1)', () => {
  assert.equal(txKind({ kind: 'product' }), 2);
  for (const k of ['service', 'package', 'other', undefined, null, 'x']) assert.equal(txKind({ kind: k as any }), 1, String(k));
  const sale = {
    items: [{ name: 'קרם', price: 118, qty: 1, itemId: 'i1', kind: 'product' as const }, { name: 'טיפול', price: 236, qty: 1, itemId: 'i2', kind: 'service' as const },
      { name: 'חבילה', price: 118, qty: 1, itemId: 'i3', kind: 'package' as const }, { name: 'שורה חופשית', price: 118, qty: 1 }],
    discount: 0, total: 590, vatAmount: 90, vatRate: 18, method: 'cash' as const, customerName: 'לקוח דמו', customerPhone: '',
  };
  const d = docFromSale(sale, { licensed: true, docDate: '2026-11-10' });
  assert.deepEqual(d.lines.map((l) => l.kind), [2, 1, 1, 1]);
  const { lines } = computeLines([{ name: 'קרם', qty: 2, unitPrice: 100, itemId: 'i1', kind: 'product' }, { name: 'ייעוץ', qty: 1, unitPrice: 100 }], { pricesIncludeVat: true, rate: 18 });
  assert.deepEqual(lines.map((l) => l.kind), [2, 1]);
});

test('1258: what is made from a document keeps its lines\' kind (credit by lines, refund credit, invoice from a delivery note)', () => {
  const base: Doc = { docType: 320, docNumber: 3, linkNo: 3, issuedAt: '2026-11-10T09:00:00Z', docDate: '2026-11-10', customerName: 'לקוח דמו',
    beforeDiscount: 200, discount: 0, afterDiscount: 200, vatAmount: 36, total: 236, issuedBy: '', payments: [{ method: 1, amount: 236, date: '2026-11-10' }],
    lines: [{ name: 'קרם', qty: 1, unitPriceExVat: 100, discountExVat: 0, totalExVat: 100, vatRate: 18, kind: 2, itemId: 'i1' },
      { name: 'טיפול', qty: 1, unitPriceExVat: 100, discountExVat: 0, totalExVat: 100, vatRate: 18, kind: 1, itemId: 'i2' }] };
  const cr = composeCredit(base, { kind: 'lines', qty: [1, 1], restock: false }, 0, '2026-11-11', { today: '2026-11-11' });
  assert.ok(cr.ok); assert.deepEqual(cr.doc.lines.map((l) => l.kind), [2, 1]);
  const old = { ...base, lines: base.lines.map((l) => ({ ...l, kind: 1 as const })) };
  const cro = composeCredit(old, { kind: 'lines', qty: [1, 0], restock: false }, 0, '2026-11-11', { today: '2026-11-11' });
  assert.ok(cro.ok); assert.deepEqual(cro.doc.lines.map((l) => l.kind), [1], 'an old document (all 1) — its credit too, never a guess');
  const rf = creditForRefund(base, { amount: 118, vatAmount: 18, items: [{ name: 'קרם', price: 118, qty: 1, itemId: 'i1', kind: 'product' }] }, { subtotal: 236, total: 236 }, '2026-11-11');
  assert.deepEqual(rf.lines.map((l) => l.kind), [2]);
  const dn: BaseDoc = { docType: 200, docNumber: 4, customerName: 'לקוח דמו', customerPhone: '', customerDealer: '', lines: base.lines,
    beforeDiscount: 200, discount: 0, afterDiscount: 200, vatAmount: 36, total: 236 };
  const inv = docFromBase(dn, [1, 1], { entity: 'company', vatRate: 18, docDate: '2026-11-11', today: '2026-11-11', docType: 305 });
  assert.ok(inv.ok); assert.deepEqual(inv.doc.lines.map((l) => l.kind), [2, 1]);
});

test('1258 in D110 (column 73): what the document has — an old document with 1 stays 1; an unknown value is written 1', () => {
  const d: Doc = { ...receipt, docType: 320 };
  const line = { name: 'קרם', qty: 1, unitPriceExVat: 100, discountExVat: 0, totalExVat: 100, vatRate: 18 };
  assert.equal(col(D110(3, biz, d, { ...line, kind: 2 }, 1), 73, 73), '2');
  assert.equal(col(D110(3, biz, d, { ...line, kind: 1 }, 1), 73, 73), '1');
  assert.equal(col(D110(3, biz, d, { ...line, kind: 7 as any }, 1), 73, 73), '1');
  assert.equal(D110(3, biz, d, { ...line, kind: 2 }, 1).length, 339);
});

test('the printed document does not change: the same row draws the same page, whatever its lines\' kind or who issued it', async () => {
  const { docBody } = await import('../src/features/documents/DocumentsTab');
  // a document as it was issued before 2.117 (kind 1 on a product line, no code), and the same row as a new one would be
  const row = { id: 'D1', doc_type: 320, doc_number: 9, link_no: 9, issued_at: '2026-11-22T22:30:00Z', doc_date: '2026-11-23', customer_name: 'לקוח דמו בע״מ',
    customer_phone: '', customer_dealer: '', customer_street: '', customer_city: '', before_discount: 100, discount: 0, after_discount: 100, vat_amount: 18, total: 118,
    base_doc_type: null, base_doc_number: null, issued_by: '', print_count: 1, sale_id: null, user_id: null,
    lines: [{ name: 'קרם — 50 מ״ל', qty: 1, unitPriceExVat: 100, discountExVat: 0, totalExVat: 100, vatRate: 18, kind: 1, itemId: 'i1' }],
    payments: [{ method: 9, amount: 18, date: '2026-11-23', m: 'withholding', pct: 15.25 }, { method: 1, amount: 100, date: '2026-11-23', m: 'cash' }] };
  const newer = { ...row, user_id: 'u-demo', lines: row.lines.map((l) => ({ ...l, kind: 2 })) };
  for (const mark of ['מקור', 'העתק נאמן למקור']) assert.equal(docBody(toDoc(newer), biz, mark), docBody(toDoc(row), biz, mark), mark);
  const page = docBody(toDoc(row), biz, 'מקור');
  assert.ok(page.includes('ניכוי במקור (15.25%)') && page.includes('18.00'), 'the withholding is still printed as a payment of the receipt');
  assert.ok(page.includes('קרם — 50 מ״ל'), 'the line name as it was written (the file-only marks are not applied)');
});

// ---------- 3. the character set (§2.4ח) ----------
test('§2.4ח: ׳ ״ dashes ₪ direction marks and odd spaces are written in ISO-8859-8 — never "?" — and the field keeps its length', () => {
  assert.equal(isoText('מס׳ 5 — בע״מ – ₪100'), `מס' 5 - בע"מ - ש"ח100`);
  assert.equal(isoText('‏דנה כהן‎‫א‬⁦ב⁩'), 'דנה כהןאב');
  assert.equal(isoText('“ציטוט” ‘א’ ־ … \t'), `"ציטוט" 'א' - ...  `);
  assert.equal(isoText('שָׁלוֹם'), 'שלום', 'points (niqqud) are not written');
  assert.equal(X('₪', 5), 'ש"ח  ');
  assert.equal(X('₪₪', 4), 'ש"חש', 'cut after the mapping — the field is X(4) exactly');
  assert.equal(X('a\r\nb', 4), 'a b ', 'a line break is one space, as before');
  for (const s of ['מס׳', 'בע״מ', 'זיכוי — 5', '₪', '‏א ב', '‏']) {
    const b = toIso88598(X(s, 12));
    assert.equal(b.length, 12); assert.ok(bytesOk(b), s); assert.ok(!b.includes(0x3f), `${s}: no "?"`);
  }
  // toIso88598 alone (a string that skipped X): one byte per character, the one-character forms, never a length change
  assert.deepEqual([...toIso88598('א׳״— ‏₪')], [0xe0, 0x27, 0x22, 0x2d, 0x20, 0x20, 0x3f]);
  assert.deepEqual([...toIso88598('Aא ת\r\n')], [0x41, 0xe0, 0x20, 0xfa, 0x0d, 0x0a]);
});

test('§2.4ח: a whole export with these marks — every record its fixed length, every byte valid', () => {
  const d: Doc = { ...receipt, customerName: '‏סלון ״דנה״ בע״מ‎', customerCity: 'תל־אביב', issuedBy: '',
    lines: [{ name: 'זיכוי — מס׳ 5 (₪100)', qty: 1, unitPriceExVat: 1250, discountExVat: 0, totalExVat: 1250, vatRate: 0, kind: 1 }] };
  const f = buildOpenFormat({ ...biz, name: 'דמו בע״מ — סניף' }, { ...sw, vendorName: 'יצרן דמו בע״מ' }, [d], at);
  const LEN: Record<string, number> = { A100: 95, B110: 376, C100: 444, D110: 339, D120: 222, Z900: 110, A000: 466 };
  for (const text of [f.bkmv, f.ini]) {
    const b = toIso88598(text);
    assert.ok(bytesOk(b)); assert.ok(!b.includes(0x3f), 'no "?"');
    text.split('\r\n').filter(Boolean).forEach((l, i) =>
      assert.equal(l.length, text === f.ini && i > 0 ? 19 : LEN[l.slice(0, 4)], l.slice(0, 13)));   // INI: A000, then the summary lines (19)
  }
  const c = f.bkmv.split('\r\n').find((l) => l.startsWith('C100'))!;
  assert.equal(col(c, 58, 107).trimEnd(), 'סלון "דנה" בע"מ', '1207 the customer name');
});

// ---------- 4. 1233 operator: the person's code ----------
test('1233 (p. 12): the code of who issued it (member_doc_codes); the site\'s documents keep "אתר"; no code — empty, as before', () => {
  const codes = docCodesMap([{ user_id: 'u1', code: 'U01' }, { user_id: 'u2', code: 'U100' }, { user_id: 'u3', code: 'דנה כהן' }, { user_id: 'u4', code: 'U1234567890' }, null, { code: 'U09' }]);
  assert.deepEqual([...codes], [['u1', 'U01'], ['u2', 'U100']], 'only a code that fits X(9), letters and digits — never a name');
  assert.equal(operatorOf({ issuedBy: '', userId: 'u1' }, codes), 'U01');
  assert.equal(operatorOf({ issuedBy: 'אתר', userId: 'u1' }, codes), 'אתר', 'the site\'s document, as before');
  assert.equal(operatorOf({ issuedBy: '', userId: 'u9' }, codes), '');
  assert.equal(operatorOf({ issuedBy: '', userId: null }, codes), '');
  assert.equal(operatorOf({ issuedBy: '', userId: 'u1' }), '', 'no table yet → as before');
  const docs: Doc[] = [{ ...receipt, userId: 'u1' }, { ...receipt, docNumber: 13, userId: 'u2' }, { ...receipt, docNumber: 14, issuedBy: 'אתר', userId: 'u1' }, { ...receipt, docNumber: 15, userId: null }];
  const ops = (codesMap?: Map<string, string>) => buildOpenFormat(biz, sw, docs, { ...at, codes: codesMap }).bkmv.split('\r\n').filter((l) => l.startsWith('C100')).map((l) => col(l, 416, 424));
  assert.deepEqual(ops(codes), ['U01      ', 'U100     ', 'אתר      ', '         ']);
  assert.deepEqual(ops(), ['         ', '         ', 'אתר      ', '         '], 'without the codes the file is as before');
  assert.equal(toDoc({ user_id: 'u1', lines: [], payments: [] }).userId, 'u1');
});

test('1233: the codes are read without breaking the export — the table missing (migration not run) or any failure → none', async () => {
  const fake = (res: any) => () => ({ from: () => ({ select: () => ({ range: async () => res }) }) }) as any;
  assert.deepEqual([...(await loadDocCodes(fake({ data: [{ user_id: 'u1', code: 'U01' }], error: null })))], [['u1', 'U01']]);
  assert.equal((await loadDocCodes(fake({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.member_doc_codes' in the schema cache" } }))).size, 0);
  assert.equal((await loadDocCodes(fake({ data: null, error: { code: '42P01', message: 'relation "member_doc_codes" does not exist' } }))).size, 0);
  assert.equal((await loadDocCodes(() => { throw new Error('supabase_not_configured'); })).size, 0);
});

// ---------- 5. 1010 the software vendor ----------
test('1009 / 1010 (p. 10): the vendor\'s number and name from the environment — ״ written as ", the field X(20) exactly', async () => {
  const { SOFTWARE } = await import('../src/features/documents/DocumentsTab');
  assert.equal(SOFTWARE.vendorName, 'יצרן דמו בע״מ');
  const a = A000(biz, SOFTWARE, { id: at.id, totalRecords: 3, path: 'x', from: at.from, to: at.to, startedAt: at.startedAt });
  assert.equal(a.length, 466);
  assert.equal(col(a, 105, 113), '000000109', '1009');
  assert.equal(col(a, 114, 133), 'יצרן דמו בע"מ'.padEnd(20, ' '), '1010');
  const b = toIso88598(col(a, 114, 133));
  assert.ok(bytesOk(b) && b.includes(0x22) && !b.includes(0x3f));
  assert.equal(col(A000(biz, { ...SOFTWARE, vendorName: 'א'.repeat(25) }, { id: at.id, totalRecords: 3, path: 'x', from: at.from, to: at.to, startedAt: at.startedAt }), 114, 133), 'א'.repeat(20), 'cut to 20');
});
