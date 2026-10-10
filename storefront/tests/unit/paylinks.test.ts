/**
 * Payment links on the storefront's server (migration 4300, docs/FINANCE_ADDITIONS_HE.md T2): the page of the provider, the
 * provider's answer, the notice (signed, once — THE SAME WEBHOOK TWICE PAYS ONCE), and "בדיקת חיבור". The database and the
 * provider are stand-ins that keep what they were asked; the real SQL is checked in dream-promotion/tests/sql.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { checkTerminal, confirmPaylink, fromDashboard, paylinkNotice, paylinkPage, returnUrlOk, type PaylinkDeps } from '../../src/lib/paylinks';
import { ProviderError, type PageRequest, type Provider, type Verified } from '../../src/lib/pay/types';
import type { PaylinkView } from '../../src/lib/types';

const ID = '11111111-2222-4333-8444-555555555555';
const BIZ = '99999999-2222-4333-8444-555555555555';
const KEYS = { api_key: 'api-1', secret_key: 'secret-1' };

function linkOf(over: Partial<PaylinkView> = {}): PaylinkView {
  return {
    id: ID, business: BIZ, status: 'sent', amount: 300, currency: 'ILS', test: true, provider: 'payplus',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(), expired: false, pages: [], label: 'חשבונית מס מס׳ 7',
    customer: { name: 'נועה', email: 'n@x.test', phone: '0501111111' }, business_name: 'לייזר א',
    account: { provider: 'payplus', mode: 'test', sealed: 'v1.sealed', page_uid: 'page-uid' }, ...over,
  };
}

/** a stand-in world: the link in the "database", a provider that answers as told, and the log of every call */
function world(link: PaylinkView | null, answer: Partial<Verified> | Error = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const log = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  let state = link ? structuredClone(link) : null;
  const events = new Set<string>();
  const provider: Provider = {
    id: 'payplus',
    async createPage(k, uid, t, r: PageRequest) { log('createPage', k, uid, t, r); return { url: 'https://pay.test/new', page: 'pp-new' }; },
    async verify(k, t, page) {
      log('verify', k, t, page);
      if (answer instanceof Error) throw answer;
      return { status: 'approved', txn: 'txn-1', amount: 300, currency: 'ILS', orderId: ID, detail: '000', ...answer };
    },
    readNotice(k, body, h) {
      const j = JSON.parse(body);
      const sig = h.get('hash');
      return { signature: sig ? sig === createHmac('sha256', k.secret_key).update(body).digest('base64') : null,
               page: String(j.transaction?.payment_page_request_uid ?? ''), orderId: String(j.transaction?.more_info ?? '') };
    },
  };
  const deps: PaylinkDeps = {
    provider: (id) => { if (id !== 'payplus') throw new ProviderError('no'); return provider; },
    open: (s) => (s === 'v1.sealed' ? KEYS : null),
    paid: (id) => log('notify', id),
    data: {
      paylink: async () => (state ? structuredClone(state) : null),
      paylinkPage: async (_r, page, url) => {
        log('paylinkPage', page, url);
        state!.pages.push({ page, url, at: new Date().toISOString(), state: 'pending' }); state!.status = 'sent';
        return 'ok';
      },
      paylinkEvent: async (_r, _p, key, kind, sig) => { log('event', key, kind, sig); const fresh = !events.has(key); events.add(key); return fresh; },
      paylinkPaid: async (_r, page, _p, txn, amount) => {
        log('paid', page, txn, amount);
        if (state!.status === 'paid') return { result: state!.status === 'paid' && txn === 'txn-1' ? 'already' : 'double', status: 'paid', test: state!.test };
        state!.status = 'paid'; state!.pages = state!.pages.map((p) => (p.page === page ? { ...p, state: 'approved' } : p));
        return { result: 'ok', status: 'paid', test: state!.test };
      },
      paylinkFailed: async (_r, page, reason) => {
        log('failed', page, reason);
        state!.pages = state!.pages.map((p) => (p.page === page ? { ...p, state: 'declined' } : p)); state!.status = 'failed';
        return { result: 'ok', status: 'failed' };
      },
      paylinkAccount: async () => (state?.account ? { ...state.account, business_name: 'לייזר א' } : null),
      paylinkVerified: async (b, sealed) => { log('verified', b, sealed); return sealed === 'v1.sealed'; },
      rateHit: async () => true,
    },
  };
  return { deps, calls, get: () => state, count: (fn: string) => calls.filter((c) => c.fn === fn).length };
}
const pending = (page: string, minutesAgo = 1) => ({ page, url: `https://pay.test/${page}`, at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), state: 'pending' as const });

test('the dashboard alone asks: the shared secret, compared in constant time', () => {
  const req = (v?: string) => new Request('https://sf.test/api/paylink', { method: 'POST', headers: v ? { 'x-commerce-secret': v } : {} });
  const S = 'commerce-secret-0123456789';
  assert.equal(fromDashboard(req(S), S), true);
  assert.equal(fromDashboard(req(`${S}x`), S), false);
  assert.equal(fromDashboard(req(), S), false);
  assert.equal(fromDashboard(req('short'), 'short'), false, 'a secret of less than 16 characters opens nothing');
  assert.equal(returnUrlOk('https://app.test/pay/abc'), true);
  assert.equal(returnUrlOk('javascript:alert(1)'), false);
  assert.equal(returnUrlOk('https://u:p@app.test/pay'), false);
  assert.equal(returnUrlOk(`https://app.test/${'x'.repeat(500)}`), false);
});

test('a page of the provider: the link\'s exact amount, its id, back to the dashboard\'s page, the notice to this server', async () => {
  const w = world(linkOf());
  const r = await paylinkPage(ID, 'https://app.test/pay/ref', 'https://sf.test', w.deps);
  assert.deepEqual(r, { ok: true, url: 'https://pay.test/new' });
  const [keys, uid, isTest, req] = w.calls.find((c) => c.fn === 'createPage')!.args as [unknown, string, boolean, PageRequest];
  assert.deepEqual(keys, KEYS); assert.equal(uid, 'page-uid'); assert.equal(isTest, true, 'a test link on the test environment');
  assert.equal(req.orderId, ID); assert.equal(req.amount, 300); assert.equal(req.currency, 'ILS');
  assert.equal(req.successUrl, 'https://app.test/pay/ref?r=back');
  assert.equal(req.failureUrl, 'https://app.test/pay/ref?r=failed');
  assert.equal(req.callbackUrl, 'https://sf.test/api/paylink/payplus/webhook');
  assert.equal(req.itemName, 'חשבונית מס מס׳ 7 — לייזר א');
  assert.deepEqual(w.calls.find((c) => c.fn === 'paylinkPage')!.args, ['pp-new', 'https://pay.test/new'], 'the page is kept on the link');
});

test('an open page of the last minutes is given again — after the provider was asked about it', async () => {
  const w = world(linkOf({ pages: [pending('pp-1', 2)] }), { status: 'pending', txn: '' });
  assert.deepEqual(await paylinkPage(ID, 'https://app.test/pay/ref', 'https://sf.test', w.deps), { ok: true, url: 'https://pay.test/pp-1' });
  assert.equal(w.count('verify'), 1);
  assert.equal(w.count('createPage'), 0);
  const old = world(linkOf({ pages: [pending('pp-1', 30)] }), { status: 'pending', txn: '' });
  assert.deepEqual(await paylinkPage(ID, 'https://app.test/pay/ref', 'https://sf.test', old.deps), { ok: true, url: 'https://pay.test/new' }, 'an old page: a new one');
});

test('paid in another tab meanwhile: no new page — the link is paid', async () => {
  const w = world(linkOf({ pages: [pending('pp-1', 2)] }));
  assert.deepEqual(await paylinkPage(ID, 'https://app.test/pay/ref', 'https://sf.test', w.deps), { ok: false, error: 'paid' });
  assert.equal(w.count('createPage'), 0);
  assert.equal(w.get()!.status, 'paid');
});

test('no page for a closed link, a changed terminal, too many tries, or when the provider fails', async () => {
  const base = 'https://app.test/pay/ref';
  assert.deepEqual(await paylinkPage(ID, base, 'https://sf.test', world(null).deps), { ok: false, error: 'not_found' });
  assert.deepEqual(await paylinkPage(ID, base, 'https://sf.test', world(linkOf({ status: 'cancelled' })).deps), { ok: false, error: 'closed' });
  assert.deepEqual(await paylinkPage(ID, base, 'https://sf.test', world(linkOf({ expired: true })).deps), { ok: false, error: 'closed' });
  assert.deepEqual(await paylinkPage(ID, base, 'https://sf.test', world(linkOf({ status: 'paid' })).deps), { ok: false, error: 'paid' });
  const live = linkOf({ account: { provider: 'payplus', mode: 'live', sealed: 'v1.sealed', page_uid: 'u' } });
  assert.deepEqual(await paylinkPage(ID, base, 'https://sf.test', world(live).deps), { ok: false, error: 'terminal_changed' },
    'a test link is never paid on a live terminal');
  assert.deepEqual(await paylinkPage(ID, base, 'https://sf.test', world(linkOf({ account: null })).deps), { ok: false, error: 'no_terminal' });
  assert.deepEqual(await paylinkPage(ID, base, 'https://sf.test', world(linkOf({ account: { provider: 'payplus', mode: 'test', sealed: 'v1.other', page_uid: 'u' } })).deps),
    { ok: false, error: 'payment' }, 'keys that do not open');
  const declined = ['a', 'b', 'c', 'd', 'e'].map((p) => ({ ...pending(p, 60), state: 'declined' as const }));
  assert.deepEqual(await paylinkPage(ID, base, 'https://sf.test', world(linkOf({ status: 'failed', pages: declined })).deps), { ok: false, error: 'too_many' });
  const broken = world(linkOf());
  broken.deps.provider = () => ({ ...world(null).deps.provider('payplus'), createPage: async () => { throw new ProviderError('payplus: no payment page'); } });
  assert.deepEqual(await paylinkPage(ID, base, 'https://sf.test', broken.deps), { ok: false, error: 'provider' });
});

test('the provider\'s answer: approved → paid with ITS amount and transaction; the dashboard is told once', async () => {
  const t = world(linkOf({ pages: [pending('pp-1')] }));
  assert.equal(await confirmPaylink(t.get()!, 'verify', t.deps), 'paid');
  assert.deepEqual(t.calls.find((c) => c.fn === 'paid')!.args, ['pp-1', 'txn-1', 300]);
  assert.equal(t.count('notify'), 1, 'a test payment too: the owner\'s alert (the dashboard issues no receipt for it)');
  assert.equal(await confirmPaylink(t.get()!, 'verify', t.deps), 'paid', 'asked again: nothing open, nothing new');
  assert.equal(t.count('notify'), 1, 'told once');
  const real = world(linkOf({ test: false, pages: [pending('pp-1')], account: { provider: 'payplus', mode: 'live', sealed: 'v1.sealed', page_uid: 'u' } }));
  assert.equal(await confirmPaylink(real.get()!, 'callback', real.deps), 'paid');
  assert.equal(real.count('notify'), 1, 'the receipt, now');
  const live = real.calls.find((c) => c.fn === 'verify')!.args;
  assert.equal(live[1], false, 'a real link is asked about on the live environment');
});

test('declined → failed (never shown as paid); a page of something else, or a provider that cannot be asked, changes nothing', async () => {
  const d = world(linkOf({ pages: [pending('pp-1')] }), { status: 'declined', txn: '', detail: '003 declined' });
  assert.equal(await confirmPaylink(d.get()!, 'verify', d.deps), 'failed');
  assert.deepEqual(d.calls.find((c) => c.fn === 'failed')!.args, ['pp-1', '003 declined']);
  assert.equal(d.count('paid'), 0);
  const other = world(linkOf({ pages: [pending('pp-1')] }), { orderId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(await confirmPaylink(other.get()!, 'verify', other.deps), 'sent');
  assert.equal(other.count('paid'), 0, 'another link\'s payment never pays this one');
  const down = world(linkOf({ pages: [pending('pp-1')] }), new ProviderError('payplus /PaymentPages/ipn: 502'));
  assert.equal(await confirmPaylink(down.get()!, 'poll', down.deps), 'unknown');
  assert.equal(down.count('paid') + down.count('failed'), 0);
  const none = world(linkOf());
  assert.equal(await confirmPaylink(none.get()!, 'poll', none.deps), 'sent', 'no open page: nothing to ask');
  assert.equal(none.count('verify'), 0);
});

test('THE SAME WEBHOOK TWICE: one question, one payment — the second changes nothing', async () => {
  const w = world(linkOf({ pages: [pending('pp-1')] }));
  const body = JSON.stringify({ transaction: { payment_page_request_uid: 'pp-1', more_info: ID, status_code: '000' } });
  const h = new Headers({ hash: createHmac('sha256', KEYS.secret_key).update(body).digest('base64'), 'user-agent': 'PayPlus' });
  assert.equal(await paylinkNotice('payplus', body, h, '1.2.3.4', w.deps), 200);
  assert.equal(await paylinkNotice('payplus', body, h, '1.2.3.4', w.deps), 200);
  assert.equal(w.count('verify'), 1, 'the repeated notice asks nothing');
  assert.equal(w.count('paid'), 1, 'one payment');
  assert.equal(w.get()!.status, 'paid');
});

test('a notice: forged → refused and logged; not ours, another page or another provider → nothing asked', async () => {
  const body = JSON.stringify({ transaction: { payment_page_request_uid: 'pp-1', more_info: ID } });
  const forged = world(linkOf({ pages: [pending('pp-1')] }));
  assert.equal(await paylinkNotice('payplus', body, new Headers({ hash: 'AAAA', 'user-agent': 'PayPlus' }), 'ip', forged.deps), 401);
  assert.equal(forged.count('event'), 1, 'logged');
  assert.equal(forged.count('verify'), 0);
  const notOurs = world(linkOf({ pages: [pending('pp-1')] }));
  assert.equal(await paylinkNotice('payplus', JSON.stringify({ transaction: { more_info: `check-${BIZ}` } }), new Headers(), 'ip', notOurs.deps), 200);
  assert.equal(notOurs.count('verify') + notOurs.count('event'), 0);
  const otherPage = world(linkOf({ pages: [pending('pp-1')] }));
  const b2 = JSON.stringify({ transaction: { payment_page_request_uid: 'pp-9', more_info: ID } });
  assert.equal(await paylinkNotice('payplus', b2, new Headers(), 'ip', otherPage.deps), 200);
  assert.equal(otherPage.count('verify'), 0, 'a page that is not the link\'s');
  assert.equal(await paylinkNotice('cardcom', body, new Headers(), 'ip', otherPage.deps), 404);
  assert.equal(await paylinkNotice('payplus', '', new Headers(), 'ip', otherPage.deps), 400);
  const unsigned = world(linkOf({ pages: [pending('pp-1')] }), { status: 'pending', txn: '' });
  assert.equal(await paylinkNotice('payplus', body, new Headers(), 'ip', unsigned.deps), 200);
  assert.equal(unsigned.count('verify'), 1, 'no signature: the direct question decides');
  assert.equal(unsigned.get()!.status, 'sent');
});

test('"בדיקת חיבור": a page of ₪1 with the terminal\'s keys → verified; a refusal of the provider → not', async () => {
  const w = world(linkOf());
  assert.deepEqual(await checkTerminal(BIZ, 'https://sf.test', w.deps), { ok: true });
  const [, , isTest, req] = w.calls.find((c) => c.fn === 'createPage')!.args as [unknown, string, boolean, PageRequest];
  assert.equal(isTest, true); assert.equal(req.amount, 1); assert.equal(req.itemName, 'בדיקת חיבור');
  assert.ok(!/^[0-9a-f-]{36}$/.test(req.orderId), 'never a link\'s id: its notice pays nothing');
  assert.deepEqual(w.calls.find((c) => c.fn === 'verified')!.args, [BIZ, 'v1.sealed'], 'these very keys');
  const no = world(linkOf());
  no.deps.provider = () => ({ ...world(null).deps.provider('payplus'), createPage: async () => { throw new ProviderError('payplus: 401'); } });
  assert.deepEqual(await checkTerminal(BIZ, 'https://sf.test', no.deps), { ok: false, error: 'provider' });
  assert.equal(no.count('verified'), 0);
  assert.deepEqual(await checkTerminal(BIZ, 'https://sf.test', world(linkOf({ account: null })).deps), { ok: false, error: 'no_terminal' });
});
