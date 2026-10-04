/**
 * The customer's document as a digitally signed PDF: Hebrew right to left, the business and customer details,
 * and a signature that a standard tool (OpenSSL) verifies — and that breaks when one byte of the file changes.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import { fakeDb } from './fakedb';
import { visual } from '../src/lib/server/doc-pdf';
import { certificateInfo, signingConfig } from '../src/lib/server/sign-pdf';

const TOKEN = 'c'.repeat(64);
const tables: Record<string, any[]> = {
  documents: [{ id: 'D1', user_id: 'biz', sale_id: 'S1', share_token: TOKEN, doc_type: 320, doc_number: 7, link_no: 1, issued_at: '2026-10-05T07:30:00Z', doc_date: '2026-10-05',
    customer_name: 'סלון דנה בע״מ', customer_phone: '0521234567', customer_dealer: '520013954', customer_street: 'הרצל 5', customer_city: 'חולון',
    lines: [{ name: 'קרם לחות (50 מ״ל)', qty: 2, unitPriceExVat: 84.75, discountExVat: 0, totalExVat: 169.49, vatRate: 18, kind: 1 },
      { name: 'הסרת שיער בלייזר — רגליים מלאות', qty: 1, unitPriceExVat: 211.86, discountExVat: 0, totalExVat: 211.87, vatRate: 18, kind: 1 }],
    payments: [{ method: 1, amount: 450, date: '2026-10-05' }], before_discount: 381.36, discount: 0, after_discount: 381.36, vat_amount: 68.64, total: 450, vat_rate: 18, print_count: 0 }],
  register_settings: [{ user_id: 'biz', dealer_number: '515123456', legal_name: 'SaGabot', street: 'דיזנגוף', house_no: '10', city: 'תל אביב', zip: '' }],
  brands: [{ user_id: 'biz', name: 'SaGabot' }],
};
const dir = mkdtempSync(path.join(tmpdir(), 'dp-pdf-'));
let p12b64 = '';
before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(tables);
  // a throw-away self-signed certificate, like the real one would be from a certification authority
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 864e5); cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
  const attrs = [{ name: 'commonName', value: 'Dream Promotion Test' }, { name: 'countryName', value: 'IL' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'secret', { algorithm: '3des' });
  p12b64 = forge.util.encode64(forge.asn1.toDer(p12).getBytes());
});

test('Hebrew is drawn in visual order: words reversed, numbers kept, brackets mirrored', () => {
  assert.equal(visual('שלום 123'), '123 םולש');
  assert.equal(visual('קרם (50 מ״ל)'), '(ל״מ 50) םרק');
  assert.equal(visual('Dream Promotion 2.50'), 'Dream Promotion 2.50', 'Latin stays as is');
  assert.equal(visual('סה״כ: 450.00 ₪'), '₪ 450.00 :כ״הס');
});

test('signing settings: not set → unsigned; a wrong password is reported, never thrown', () => {
  assert.equal(signingConfig({}), null);
  assert.deepEqual(certificateInfo({}), { configured: false });
  assert.equal(certificateInfo({ DOC_SIGN_P12_BASE64: p12b64, DOC_SIGN_P12_PASSWORD: 'wrong' }).error, 'הסיסמה של התעודה לא נכונה');
  const ok = certificateInfo({ DOC_SIGN_P12_BASE64: p12b64, DOC_SIGN_P12_PASSWORD: 'secret' });
  assert.equal(ok.configured, true); assert.equal(ok.subject, 'Dream Promotion Test');
});

test('the PDF without a certificate: a valid file, marked unsigned', async () => {
  delete process.env.DOC_SIGN_P12_BASE64;
  const route = await import('../src/app/api/doc/[token]/pdf/route');
  const r = await route.GET(new Request('http://x'), { params: { token: TOKEN } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('x-signed'), '0');
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await route.GET(new Request('http://x'), { params: { token: 'd'.repeat(64) } })).status, 404);
  assert.equal((await route.GET(new Request('http://x'), { params: { token: '../x' } })).status, 404);
});

test('the signed PDF: the details are in it, OpenSSL verifies the signature, one changed byte breaks it', async () => {
  process.env.DOC_SIGN_P12_BASE64 = p12b64; process.env.DOC_SIGN_P12_PASSWORD = 'secret';
  const route = await import('../src/app/api/doc/[token]/pdf/route');
  const r = await route.GET(new Request('http://x'), { params: { token: TOKEN } });
  assert.equal(r.headers.get('x-signed'), '1');
  const pdf = Buffer.from(await r.arrayBuffer());
  const file = path.join(dir, 'doc.pdf'); writeFileSync(file, pdf);

  const text = execFileSync('pdftotext', ['-layout', file, '-']).toString();
  for (const s of ['515123456', '520013954', '450.00', '381.36', '68.64', '169.49']) assert.ok(text.includes(s), `the PDF shows ${s}`);
  assert.match(text, /[א-ת]/, 'Hebrew text is in the file');

  // the signature: /ByteRange [a b c d] covers everything but the /Contents hex
  const latin = pdf.toString('latin1');
  const m = latin.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
  assert.ok(m, 'a signature dictionary with a byte range');
  const [a, b, c, d] = m!.slice(1).map(Number);
  assert.equal(a, 0); assert.equal(c + d, pdf.length, 'the signed ranges reach the end of the file');
  const hex = latin.slice(a + b + 1, c - 1).replace(/0+$/, '');
  const der = forge.asn1.toDer(forge.asn1.fromDer(forge.util.hexToBytes(hex.length % 2 ? `${hex}0` : hex), false)).getBytes();
  writeFileSync(path.join(dir, 'sig.der'), Buffer.from(der, 'binary'));
  const signedData = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  writeFileSync(path.join(dir, 'data.bin'), signedData);
  const verify = () => execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', path.join(dir, 'sig.der'), '-content', path.join(dir, 'data.bin'), '-noverify', '-out', '/dev/null'], { stdio: 'pipe' }).toString();
  assert.doesNotThrow(verify, 'OpenSSL: Verification successful');

  const tampered = Buffer.from(signedData); tampered[200] ^= 1;
  writeFileSync(path.join(dir, 'data.bin'), tampered);
  assert.throws(verify, 'a changed byte fails the check');
  delete process.env.DOC_SIGN_P12_BASE64; delete process.env.DOC_SIGN_P12_PASSWORD;
});
