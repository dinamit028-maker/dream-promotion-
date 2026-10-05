/**
 * 2.52.1 — the pilot fixes, in code: one key per payment / credit / quote (a double tap or a retry never issues twice),
 * a duplicate sale is recognised, OAuth finished only in the browser that started it, the customer's document escaped,
 * Hebrew errors (sign-in, saves that failed, the database's new checks), a viewer refused by the server, the audit log's
 * membership lines, the software registration line.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { followKey, quoteKey } from '../src/features/finance/keys';
import { isDuplicateId } from '../src/lib/db-errors';
import { financeError } from '../src/features/finance/api';
import { auditLine, toAuditRow } from '../src/features/finance/audit';
import { explainAuthError, isRecoveryLink, linkError } from '../src/features/auth/AuthForm';
import { reported, reportSaveError, saveErrorReason, saveErrorText } from '../src/lib/save-status';

before(() => { process.env.TOKEN_ENCRYPTION_KEY = 'test-key-for-oauth-state'; });

test('one key per follow-up document: the same invoice and count always give the same key', () => {
  assert.equal(followKey('receipt', 'doc-1', 0), 'receipt:doc-1:1');
  assert.equal(followKey('receipt', 'doc-1', 2), 'receipt:doc-1:3', 'the third receipt on an invoice');
  assert.equal(followKey('credit', 'doc-1', -5), 'credit:doc-1:1', 'never below the first');
  assert.equal(followKey('receipt', 'doc-1', 1), followKey('receipt', 'doc-1', 1), 'a double tap = one key = one document');
  assert.equal(quoteKey('q-7'), 'quote:q-7', 'one document per quote');
});

test('a duplicate primary key (the same sale sent twice) is recognised by its constraint', () => {
  assert.equal(isDuplicateId({ code: '23505', message: 'duplicate key value violates unique constraint "sales_pkey"' }, 'sales_pkey'), true);
  assert.equal(isDuplicateId({ message: 'duplicate key value violates unique constraint "sales_pkey"' }, 'sales_pkey'), true);
  assert.equal(isDuplicateId({ code: '23505', message: 'duplicate key value violates unique constraint "documents_idempotency_uq"' }, 'sales_pkey'), false,
    'another constraint is another problem');
  assert.equal(isDuplicateId(null, 'sales_pkey'), false);
});

test('the database\'s new refusals, in Hebrew', () => {
  assert.match(financeError({ message: 'receipt_exceeds_balance: 180.00 left to pay on this invoice' }), /גדול מהיתרה/);
  assert.match(financeError({ message: 'a VAT business pays a transaction invoice (300) with a tax invoice-receipt (320), not a receipt (400)' }), /חשבונית מס \/ קבלה/);
  assert.match(financeError({ message: 'refund_exceeds_paid: 18.00 left (part of the sale was already returned at the register)' }), /כבר הוחזר בקופה/);
  assert.match(financeError({ message: "payments: method and amount are numbers, dates are dates, a cheque's details are digits" }), /פרטי התשלום לא תקינים/);
  assert.match(financeError({ message: 'lines: names are text; quantities, prices, totals and rates are numbers' }), /שורות המסמך לא תקינות/);
  assert.match(financeError({ message: 'not allowed', code: '42501' }), /אין הרשאה/);
  assert.match(financeError({ message: 'payments: 100 paid but the document says 118' }), /סכום התשלומים/, 'the old message keeps its text');
});

test('the audit log names who joined or left the business', () => {
  const r = toAuditRow({ id: 9, actor_kind: 'super_admin', action: 'member.added', details: { email: 'noa@x.com', role: 'editor', access: 'register' }, at: '2026-10-05T10:00:00Z' });
  assert.equal(auditLine(r), 'אדם צורף לעסק · noa@x.com · קופה בלבד');
  const gone = toAuditRow({ id: 10, actor_kind: 'server', action: 'member.removed', details: { email: 'noa@x.com', role: 'viewer', access: 'full' }, at: '2026-10-05T10:00:00Z' });
  assert.equal(auditLine(gone), 'אדם הוסר מהעסק · noa@x.com · צפייה בלבד');
});

test('sign-in: a reset link asks for a new password; English answers become Hebrew', () => {
  assert.equal(isRecoveryLink('#access_token=a&expires_in=3600&refresh_token=b&token_type=bearer&type=recovery'), true);
  assert.equal(isRecoveryLink('#access_token=a&token_type=bearer&type=signup'), false, 'token_type is not type');
  assert.equal(linkError('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'), true);
  assert.equal(linkError('#access_token=a&type=recovery'), false);
  assert.match(explainAuthError('Invalid login credentials'), /שגויים/);
  assert.match(explainAuthError('Email not confirmed'), /לאשר את כתובת המייל/, 'not "the address is invalid"');
  assert.match(explainAuthError('New password should be different from the old password.'), /שונה מהקודמת/);
  assert.match(explainAuthError('For security purposes, you can only request this after 53 seconds.'), /המתינו/);
  assert.match(explainAuthError('TypeError: Failed to fetch'), /אין חיבור/);
  const unknown = explainAuthError('Something unexpected from the server');
  assert.equal(unknown, 'משהו השתבש. נסו שוב בעוד רגע.', 'never English on the screen');
});

test('a background save that fails is said, in Hebrew — never swallowed', async () => {
  assert.match(saveErrorReason({ code: '42501', message: 'new row violates row-level security policy' }), /אין הרשאה/);
  assert.match(saveErrorReason({ message: 'TypeError: Failed to fetch' }), /אין חיבור/);
  assert.match(saveErrorText('איש הקשר', { message: 'x' }), /^לא הצלחנו לשמור את איש הקשר .* לא נשמר/);
  // in the browser an event is sent to the banner; on the server (no window) nothing throws
  const seen: string[] = [];
  (globalThis as any).window = { dispatchEvent: (e: any) => { seen.push(e.detail.message); return true; } };
  (globalThis as any).CustomEvent ??= class { type: string; detail: unknown; constructor(t: string, o: any) { this.type = t; this.detail = o?.detail; } };
  const r = await reported('התוכן', Promise.resolve({ error: { message: 'boom' } }));
  assert.ok(r && r.error, 'the answer is returned to the caller');
  assert.equal(await reported('המדיה', Promise.reject(new Error('Failed to fetch'))), null, 'an exception is caught and reported');
  reportSaveError('x', null);
  assert.equal(seen.length, 2); assert.match(seen[0], /התוכן/); assert.match(seen[1], /אין חיבור/);
  delete (globalThis as any).window;
});

test('OAuth (TikTok, Meta): a callback without this browser\'s cookie connects nothing', async () => {
  const { signState, sameBrowser, oauthCookie, oauthOnce } = await import('../src/lib/server/secrets');
  const once = oauthOnce();
  assert.match(oauthCookie('dp_tiktok_oauth', '/api/tiktok/callback', once), /^dp_tiktok_oauth=[A-Za-z0-9_-]+; Path=\/api\/tiktok\/callback; Max-Age=900; HttpOnly; Secure; SameSite=Lax$/);
  assert.match(oauthCookie('dp_tiktok_oauth', '/api/tiktok/callback', ''), /Max-Age=0/, 'cleared');
  const withCookie = (v: string) => new Request('http://x', { headers: { cookie: `a=1; dp_tiktok_oauth=${v}` } });
  assert.equal(sameBrowser(withCookie(once), 'dp_tiktok_oauth', once), true);
  assert.equal(sameBrowser(withCookie(oauthOnce()), 'dp_tiktok_oauth', once), false, 'another browser');
  assert.equal(sameBrowser(new Request('http://x'), 'dp_tiktok_oauth', once), false, 'no cookie');
  assert.equal(sameBrowser(withCookie(once), 'dp_tiktok_oauth', undefined), false, 'a state without the value');

  (globalThis as any).__DP_TEST_ADMIN_DB__ = { ...fakeDb({}), auth: { getUser: async () => ({ data: { user: null } }) } };
  const tiktok = await import('../src/app/api/tiktok/callback/route');
  const state = signState({ u: 'user-a', b: 'biz-a', p: 'tiktok', c: once });
  const sent = await tiktok.GET(new Request(`http://app.test/api/tiktok/callback?code=abc&state=${encodeURIComponent(state)}`));
  assert.equal(sent.status, 307);
  assert.match(sent.headers.get('location') ?? '', /tiktok=error&reason=denied/, 'the link was opened in another browser');
  assert.match(sent.headers.get('set-cookie') ?? '', /dp_tiktok_oauth=; .*Max-Age=0/, 'the one-time cookie is cleared');
  const noBiz = signState({ u: 'user-a', p: 'tiktok', c: once });
  const old = await tiktok.GET(new Request(`http://app.test/api/tiktok/callback?code=abc&state=${encodeURIComponent(noBiz)}`, { headers: { cookie: `dp_tiktok_oauth=${once}` } }));
  assert.match(old.headers.get('location') ?? '', /reason=expired/, 'a state without its business (from before 2.52.1) is not used');

  const meta = await import('../src/app/api/meta/callback/route');
  const mstate = signState({ u: 'user-a', p: 'meta', m: 'full', c: once });
  const m = await meta.GET(new Request(`http://app.test/api/meta/callback?code=abc&state=${encodeURIComponent(mstate)}`));
  assert.match(m.headers.get('location') ?? '', /meta=error&reason=denied/);
  delete (globalThis as any).__DP_TEST_ADMIN_DB__;
});

test('the customer\'s document page: every value from the database is escaped', async () => {
  const { docBody } = await import('../src/features/documents/DocumentsTab');
  const evil = '<img src=x onerror=alert(1)>';
  const html = docBody({
    docType: 320, docNumber: 7, linkNo: 1, issuedAt: '2026-10-05T08:00:00Z', docDate: `2026-10-05${evil}`, customerName: evil, customerPhone: evil,
    beforeDiscount: 100, discount: 0, afterDiscount: 100, vatAmount: 18, total: 118, notes: evil,
    lines: [{ name: evil, qty: evil as any, unitPriceExVat: evil as any, discountExVat: 0, totalExVat: 100, vatRate: evil as any, kind: 1 }],
    payments: [{ method: 2, amount: 118, date: evil, cheque: { number: evil, bank: evil, branch: evil, dueDate: evil } }],
  } as any, { name: evil, dealerNumber: '515123456', street: '', houseNo: '', city: '', zip: '' } as any, 'מקור');
  assert.ok(!html.includes('<img'), 'no tag from the data');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'shown as text');
});

test('the software registration number: printed only when it is a real one', async () => {
  const { softwareRegistered } = await import('../src/features/documents/DocumentsTab');
  assert.equal(softwareRegistered(''), false);
  assert.equal(softwareRegistered('00000000'), false, 'the placeholder of the file is not a registration');
  assert.equal(softwareRegistered('1234'), false);
  assert.equal(softwareRegistered('12345678'), true);
});

test('the server refuses a viewer what changes or spends; reading stays open', async () => {
  const tables: Record<string, any[]> = {
    profiles: [{ id: 'v', is_super_admin: false }, { id: 'o', is_super_admin: false }],
    businesses: [{ id: 'b', status: 'active', paid_until: null, grace_days: 0 }],
    business_members: [{ business_id: 'b', user_id: 'v', role: 'viewer', access: 'full' }, { business_id: 'b', user_id: 'o', role: 'owner', access: 'full' }],
  };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    ...fakeDb(tables), rpc: async () => ({ data: 'b' }),
    auth: { getUser: async (t: string) => ({ data: { user: ['v', 'o'].includes(t) ? { id: t } : null } }) },
  };
  const { blockedFor, memberRole } = await import('../src/lib/server/business');
  const { financeCaller } = await import('../src/lib/server/finance');
  assert.equal(await memberRole('v', 'b'), 'viewer');
  assert.equal((await blockedFor('v'))?.code, 'view_only', 'no AI, publishing or rendering for a viewer');
  assert.equal(await blockedFor('o'), null, 'the owner is not blocked');
  const req = (u: string) => new Request('http://x', { headers: { authorization: `Bearer ${u}` } });
  assert.equal((await financeCaller(req('v'))).ok, true, 'a viewer reads the money screens');
  const w = await financeCaller(req('v'), { write: true });
  assert.ok(!w.ok && w.status === 403 && w.body.code === 'view_only', 'a viewer does not request an allocation, scan or connect');
  assert.equal((await financeCaller(req('o'), { write: true })).ok, true);
  delete (globalThis as any).__DP_TEST_ADMIN_DB__;
});
