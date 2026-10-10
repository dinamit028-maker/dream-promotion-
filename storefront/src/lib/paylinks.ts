import { createHash, timingSafeEqual } from 'node:crypto';
import { after } from 'next/server';
import { data } from './data';
import { notifyPaylinkPaid } from './dashboard';
import { providerOf } from './pay';
import { ProviderError, type Provider, type Verified } from './pay/types';
import { openKeys, type PaymentKeys } from './seal';
import type { PaylinkStatus, PaylinkView } from './types';

/**
 * Payment links (docs/FINANCE_ADDITIONS_HE.md, T2; migration 20261010004300). The customer pays a business's open invoice,
 * accepted quote or an appointment's deposit on the provider's own page. Only this server opens the terminal's keys, so the
 * dashboard's server asks it (POST /api/paylink, COMMERCE_SECRET) for a page, for a check of the pages, and for "בדיקת
 * חיבור". As with an order, only the provider's own answer, asked directly, makes a link paid (sf_paylink_paid: this link,
 * one of its pages, the exact amount, once); a notice (/api/paylink/<provider>/webhook), a return to the page or the cron
 * only start that question. A payment is then told to the dashboard: the owner's alert, and a real one's receipt.
 */
export type PaylinkError = 'not_found' | 'paid' | 'closed' | 'too_many' | 'no_terminal' | 'terminal_changed' | 'payment' | 'provider' | 'bad';
export type PageResult = { ok: true; url: string } | { ok: false; error: PaylinkError };

export interface PaylinkDeps {
  data: Pick<typeof data, 'paylink' | 'paylinkPage' | 'paylinkEvent' | 'paylinkPaid' | 'paylinkFailed' | 'paylinkAccount' | 'paylinkVerified' | 'rateHit'>;
  provider: (id: string) => Provider;
  open: (sealed: string) => PaymentKeys | null;
  /** a link was paid: the dashboard alerts the owner and issues a real payment's receipt (after the answer went out) */
  paid: (requestId: string) => void;
}
const LIVE: PaylinkDeps = {
  data, provider: providerOf, open: (s) => openKeys(s), paid: (id) => afterResponse(() => notifyPaylinkPaid(id)),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** an open page of the provider younger than this is given again instead of a new one */
const REUSE_MS = 15 * 60_000;
const NO_KEYS: PaymentKeys = { api_key: '', secret_key: '' };

/** the shared secret of the two servers (COMMERCE_SECRET, at least 16 characters, the same value in both projects) */
export function fromDashboard(req: Request, secret = process.env.COMMERCE_SECRET ?? ''): boolean {
  const got = req.headers.get('x-commerce-secret') ?? '';
  return secret.length >= 16 && got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
}

/** the dashboard's page of the link, where the provider sends the customer back (an http(s) address, nothing else) */
export function returnUrlOk(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 500) return false;
  try {
    const x = new URL(u);
    return (x.protocol === 'https:' || x.protocol === 'http:') && !x.username && !x.password;
  } catch {
    return false;
  }
}
const withParam = (u: string, k: string, v: string) => { const x = new URL(u); x.searchParams.set(k, v); return x.toString(); };

// ---- a page of the provider for the link ---------------------------------------------------------------------------------
/**
 * "לתשלום" on the dashboard's page of the link: a page of the provider. An open page of the last 15 minutes is given again;
 * pages still open are asked about first (the customer may have paid in another tab) — a paid link opens nothing.
 */
export async function paylinkPage(requestId: string, returnUrl: string, origin: string, deps: PaylinkDeps = LIVE): Promise<PageResult> {
  let link = await deps.data.paylink(requestId);
  if (!link) return { ok: false, error: 'not_found' };
  if (link.pages.some((p) => p.state === 'pending')) {
    const s = await confirmPaylink(link, 'verify', deps);
    if (s === 'paid') return { ok: false, error: 'paid' };
    link = (await deps.data.paylink(requestId)) ?? link;
  }
  if (link.status === 'paid') return { ok: false, error: 'paid' };
  if (link.expired || (link.status !== 'sent' && link.status !== 'failed')) return { ok: false, error: 'closed' };
  const open = link.pages.filter((p) => p.state === 'pending' && Date.now() - Date.parse(p.at) < REUSE_MS).pop();
  if (open && /^https?:\/\//.test(open.url)) return { ok: true, url: open.url };
  if (link.pages.length >= 5) return { ok: false, error: 'too_many' };
  const account = link.account;
  if (!account) return { ok: false, error: 'no_terminal' };
  // a link is paid on the terminal it was sent on: test on test, live on live
  if (account.provider !== link.provider || (account.mode === 'test') !== link.test) return { ok: false, error: 'terminal_changed' };
  const keys = deps.open(account.sealed);
  if (!keys) return { ok: false, error: 'payment' };
  let provider: Provider;
  try { provider = deps.provider(link.provider); } catch { return { ok: false, error: 'payment' }; }
  let page: { url: string; page: string };
  try {
    page = await provider.createPage(keys, account.page_uid, link.test, {
      orderId: link.id, number: 0, amount: link.amount, currency: link.currency, customer: link.customer,
      successUrl: withParam(returnUrl, 'r', 'back'), failureUrl: withParam(returnUrl, 'r', 'failed'),
      callbackUrl: `${origin}/api/paylink/${provider.id}/webhook`, storeName: link.business_name,
      itemName: `${link.label} — ${link.business_name}`,
    });
  } catch (e) {
    if (!(e instanceof ProviderError)) console.error('[paylink] page', e);
    return { ok: false, error: 'provider' };
  }
  const r = await deps.data.paylinkPage(link.id, page.page, page.url);
  if (r === 'ok') return { ok: true, url: page.url };
  return { ok: false, error: r === 'too_many' ? 'too_many' : r === 'not_found' ? 'not_found' : r === 'bad' ? 'provider' : 'closed' };
}

// ---- the provider's answer -------------------------------------------------------------------------------------------------
export type Confirmed = PaylinkStatus | 'unknown';

/**
 * Asks the provider about every page of the link still open, and records each answer: approved for THIS link →
 * sf_paylink_paid (which checks the page, the amount and the currency itself, and ignores a repeat); declined →
 * sf_paylink_failed; anything else changes nothing. 'unknown': the provider could not be asked and nothing changed.
 */
export async function confirmPaylink(link: PaylinkView, why: 'verify' | 'callback' | 'poll', deps: PaylinkDeps = LIVE): Promise<Confirmed> {
  const pending = link.pages.filter((p) => p.state === 'pending');
  if (!pending.length) return link.status;
  const account = link.account;
  if (!account || account.provider !== link.provider) return link.status;
  const keys = deps.open(account.sealed);
  if (!keys) return link.status;
  let provider: Provider;
  try { provider = deps.provider(link.provider); } catch { return link.status; }
  let status: PaylinkStatus = link.status;
  let unknown = false;
  for (const p of pending) {
    let v: Verified;
    try {
      v = await provider.verify(keys, link.test, p.page);
    } catch {
      unknown = true;
      continue;
    }
    await deps.data.paylinkEvent(link.id, link.provider, `${link.provider}:link-verify:${p.page}:${v.status}:${v.txn || '-'}`.slice(0, 200),
      why === 'poll' ? 'poll' : 'verify', null,
      { page: p.page.slice(0, 80), status: v.status, txn: v.txn, amount: v.amount, currency: v.currency, detail: v.detail.slice(0, 80) });
    if (v.orderId && v.orderId !== link.id) continue;                  // a page of something else: never this link
    if (v.status === 'approved' && v.amount != null) {
      const r = await deps.data.paylinkPaid(link.id, p.page, link.provider, v.txn, v.amount, v.currency || 'ILS');
      if (r?.result === 'ok') deps.paid(link.id);                     // the owner's alert, and a real payment's receipt — now
      if (r?.status) status = r.status;
      if (status === 'paid') break;
    } else if (v.status === 'declined') {
      const r = await deps.data.paylinkFailed(link.id, p.page, v.detail || 'declined');
      if (r?.status) status = r.status;
    }
  }
  return unknown && status === link.status ? 'unknown' : status;
}

// ---- the provider's notice ---------------------------------------------------------------------------------------------------
/**
 * The provider's notice about a link's page (refURL_callback) — on any host of the storefront. It never marks anything
 * paid by itself: the link is ours and of this provider; the signature is checked with the link's terminal (a wrong one is
 * logged and refused); the notice is logged once; then the provider is asked directly. The answer is the HTTP status:
 * 200 for anything the provider should not send again.
 */
export async function paylinkNotice(pid: string, body: string, headers: Headers, ip: string, deps: PaylinkDeps = LIVE): Promise<number> {
  if (!body || body.length > 64_000) return 400;
  if (!(await deps.data.rateHit(`paylink-webhook:${ip}`, 60, 300).catch(() => true))) return 429;
  let provider: Provider;
  try { provider = deps.provider(pid); } catch { return 404; }
  // which link it is about (the signature is checked below, with that link's own terminal)
  const about = provider.readNotice(NO_KEYS, body, headers).orderId;
  if (!UUID.test(about)) return 200;                                   // not a link of ours ("בדיקת חיבור", another system)
  const link = await deps.data.paylink(about.toLowerCase());
  if (!link || link.provider !== pid || !link.account || link.account.provider !== pid) return 200;
  const keys = deps.open(link.account.sealed);
  if (!keys) return 503;
  const notice = provider.readNotice(keys, body, headers);
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 40);
  const fresh = await deps.data.paylinkEvent(link.id, pid, `${pid}:link-callback:${digest}`, 'callback', notice.signature,
    { page: notice.page.slice(0, 80), signature: notice.signature });
  if (notice.signature === false) return 401;                          // forged or broken: logged, nothing asked
  if (!fresh) return 200;                                              // the same notice again: nothing new
  if (!link.pages.some((p) => p.page === notice.page)) return 200;     // not a page of this link
  await confirmPaylink(link, 'callback', deps);
  return 200;
}

// ---- "בדיקת חיבור" -------------------------------------------------------------------------------------------------------------
/**
 * The owner's check of the terminal: a page of ₪1 is created with these very keys (never shown, never paid). The provider
 * accepted them → the terminal is verified (sf_paylink_verified — only while the keys are still the ones checked).
 */
export async function checkTerminal(business: string, origin: string, deps: PaylinkDeps = LIVE): Promise<{ ok: true } | { ok: false; error: PaylinkError }> {
  const account = await deps.data.paylinkAccount(business);
  if (!account) return { ok: false, error: 'no_terminal' };
  const keys = deps.open(account.sealed);
  if (!keys) return { ok: false, error: 'payment' };
  let provider: Provider;
  try { provider = deps.provider(account.provider); } catch { return { ok: false, error: 'payment' }; }
  try {
    await provider.createPage(keys, account.page_uid, account.mode === 'test', {
      orderId: `check-${business}`.slice(0, 60), number: 0, amount: 1, currency: 'ILS',
      customer: { name: account.business_name.slice(0, 80), email: '', phone: '' },
      successUrl: origin, failureUrl: origin, callbackUrl: `${origin}/api/paylink/${provider.id}/webhook`,
      storeName: account.business_name, itemName: 'בדיקת חיבור',
    });
  } catch (e) {
    if (!(e instanceof ProviderError)) console.error('[paylink] check', e);
    return { ok: false, error: 'provider' };
  }
  return (await deps.data.paylinkVerified(business, account.sealed)) ? { ok: true } : { ok: false, error: 'terminal_changed' };
}

/** after the answer went out (the customer does not wait); outside a request (tests, scripts) it simply runs */
function afterResponse(job: () => Promise<unknown>) {
  try { after(job); } catch { void job().catch(() => undefined); }
}
