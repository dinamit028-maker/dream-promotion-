import { adminDb } from './admin';
import { businessOpen } from './business';
import { sendQueuedEmails } from './commerce';
import { notifyManagers } from './notify';
import { paylinkRef } from './order-link';
import { businessContact } from './paylink-mail';
import { composeDocument, composeReceipt, type ComposeResult } from '@/features/finance/compose';
import { documentRow } from '@/features/finance/rows';
import { quoteKey } from '@/features/finance/keys';
import { chargesVat, entityOf, invoiceDocType, type EntityType } from '@/features/finance/rules';
import { DOC_LABEL, toDoc } from '@/features/documents/documents';
import { documentFailure } from '@/features/store/commerce';
import { paylinkError, paylinkMessage, paylinkState, type PaylinkKind, type PaylinkStatus, type PaylinkVia } from '@/features/finance/paylinks';
import { ils } from '@/features/register/money';
import { israelParts } from '@/lib/il-time';

/**
 * Payment links on the dashboard's server (docs/FINANCE_ADDITIONS_HE.md T2; migration 20261010004300) — service role, so
 * every read and write names the link's own business; the caller's business is the server's (financeCaller), never the
 * browser's.
 *   send      paylink_create — the database checks the terminal (connected, checked, live only with the switch), what is
 *             left to ask for (under the invoice's lock) and the deposit — then the customer's address <origin>/pay/<ref>
 *             (ORDER_LINK_SECRET, "paylink:"), on WhatsApp (the owner's own tap), by email (the outbox) or copied
 *   the page  the customer's "לתשלום" → the storefront's server (STOREFRONT_URL + COMMERCE_SECRET), the only one that opens
 *             the terminal's keys, makes the provider's page; back on the page, it asks the provider (never the return alone)
 *   paid      the storefront tells /api/finance/paylinks/finalize (a real payment, and a test one for the owner's alert) →
 *             the receipt through the existing documents, with the link's own key paylink:<id> — the database keeps one
 *             document per key, so the same notice twice makes ONE receipt; then paylink_receipt_done
 *   the cron  links past their time expire; receipts that wait for the server are issued
 */
type Db = ReturnType<typeof adminDb>;
const today = () => israelParts(Date.now()).date;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** the dashboard's address for the customer's link: APP_URL when set, else the address the owner works on */
export function appOrigin(req: Request): string {
  const app = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^/?#\s]+$/.test(app)) return app;
  return new URL(req.url).origin;
}
export const linkUrl = (origin: string, id: string) => { const ref = paylinkRef(id); return ref ? `${origin.replace(/\/+$/, '')}/pay/${ref}` : null; };

/** the WhatsApp text of a link (the business as its customers know it) */
export async function linkText(businessId: string, r: { customer_name: string; label: string; amount: number | string; expires_at: string; is_test: boolean }, url: string) {
  const who = await businessContact(adminDb(), businessId);
  return paylinkMessage({ name: r.customer_name ?? '', business: who.name, label: r.label, amount: Number(r.amount), url, expiresAt: r.expires_at, test: Boolean(r.is_test) });
}

// ---- sending, sending again, cancelling -------------------------------------------------------------------------------------
export interface SendInput { kind: PaylinkKind; target: string; amount: number; days: number; via: PaylinkVia; packageId?: string | null }
export type SendResult = { ok: true; link: Record<string, any>; url: string; emailed: boolean } | { ok: false; status: number; message: string };

export async function sendPaylink(c: { businessId: string; userId: string | null }, x: SendInput, origin: string): Promise<SendResult> {
  if (!paylinkRef('00000000-0000-4000-8000-000000000000')) return { ok: false, status: 503, message: 'השרת עוד לא מוכן לשלוח לינקים (חסר ORDER_LINK_SECRET ב-Vercel).' };
  const db = adminDb();
  const { data, error } = await db.rpc('paylink_create', {
    p_business: c.businessId, p_user: c.userId, p_kind: x.kind, p_target: x.target, p_amount: x.amount, p_days: x.days, p_origin: origin,
    p_via: x.via, p_package: x.packageId ?? null,
  });
  if (error || !data) return { ok: false, status: /paylink_not_found|42501/.test(`${error?.message} ${error?.code}`) ? 404 : 400, message: paylinkError(error) };
  const link = data as Record<string, any>;
  const url = linkUrl(link.link_origin ?? origin, link.id)!;
  const emailed = x.via === 'email' ? await emailLink(db, link.id, '1') : false;
  return { ok: true, link, url, emailed };
}

/** the link's email, queued once per send and sent now when the email service is set up (else it waits in the outbox) */
async function emailLink(db: Db, id: string, ref: string): Promise<boolean> {
  const { data, error } = await db.rpc('paylink_email', { p_request: id, p_ref: ref });
  if (error || data !== true) return false;
  await sendQueuedEmails().catch((e) => console.error('[paylinks] email', e?.message ?? e));
  return true;
}

/** sent again (WhatsApp / email / copied): counted; the same link — never a second one */
export async function resendPaylink(c: { businessId: string }, id: string, via: PaylinkVia, origin: string)
  : Promise<{ ok: true; url: string; emailed: boolean; link: Record<string, any> } | { ok: false; status: number; message: string }> {
  const db = adminDb();
  const { data: r } = await db.from('payment_requests').select('id, sends, link_origin, status, expires_at, customer_name, label, amount, is_test')
    .eq('id', id).eq('business_id', c.businessId).maybeSingle();
  if (!r) return { ok: false, status: 404, message: 'הלינק לא נמצא.' };
  const { data: ok, error } = await db.rpc('paylink_sent', { p_business: c.businessId, p_request: id, p_via: via });
  if (error) return { ok: false, status: 400, message: paylinkError(error) };
  if (ok !== true) return { ok: false, status: 409, message: 'הלינק כבר לא פתוח (שולם, בוטל או שפג תוקפו). אפשר לשלוח לינק חדש.' };
  const emailed = via === 'email' ? await emailLink(db, id, String(Number((r as any).sends ?? 1) + 1)) : false;
  return { ok: true, url: linkUrl((r as any).link_origin ?? origin, id)!, emailed, link: r as Record<string, any> };
}

export async function cancelPaylink(c: { businessId: string; userId: string }, id: string, reason: string)
  : Promise<{ ok: true; result: string } | { ok: false; status: number; message: string }> {
  const { data, error } = await adminDb().rpc('paylink_cancel', { p_business: c.businessId, p_request: id, p_user: c.userId, p_reason: reason.slice(0, 300) });
  if (error) return { ok: false, status: 400, message: paylinkError(error) };
  const res = (data as { result?: string; status?: string } | null)?.result ?? 'not_found';
  if (res === 'not_found') return { ok: false, status: 404, message: 'הלינק לא נמצא.' };
  if (res === 'ignored') return { ok: false, status: 409, message: (data as any)?.status === 'paid' ? 'הלינק כבר שולם — אי אפשר לבטל אותו.' : 'הלינק כבר סגור.' };
  return { ok: true, result: res };
}

/** "הפקת הקבלה": the owner approves a receipt that waits (or one that was blocked, after fixing what blocked it) */
export async function approvePaylinkReceipt(c: { businessId: string; userId: string }, id: string): Promise<{ ok: true; receipt: ReceiptResult } | { ok: false; status: number; message: string }> {
  const { data, error } = await adminDb().rpc('paylink_receipt_approve', { p_business: c.businessId, p_request: id, p_user: c.userId });
  if (error) return { ok: false, status: 400, message: paylinkError(error) };
  const res = (data as { result?: string } | null)?.result;
  if (res === 'not_found') return { ok: false, status: 404, message: 'הלינק לא נמצא.' };
  if (res === 'ignored' && (data as any)?.receipt !== 'pending') return { ok: false, status: 409, message: 'אין קבלה שממתינה לאישור בלינק הזה.' };
  return { ok: true, receipt: await issuePaylinkReceipt(id) };
}

// ---- the receipt ----------------------------------------------------------------------------------------------------------------
export type ReceiptResult = { receipt: 'issued' | 'blocked' | 'waiting' | 'none'; document?: string; error?: string };

export async function settingsOf(db: Db, businessId: string): Promise<{ entity: EntityType; vatRate: number }> {
  const { data } = await db.from('register_settings').select('entity_type, business_type, vat_rate').eq('business_id', businessId).maybeSingle();
  return { entity: entityOf((data as any)?.entity_type, (data as any)?.business_type), vatRate: Number((data as any)?.vat_rate ?? 18) };
}
/** who issues the server's document: who sent the link (or made the plan), else the business's owner (as commerce_owner) */
export async function issuerUser(db: Db, r: { user_id: string | null; business_id: string }): Promise<string | null> {
  if (r.user_id) return r.user_id;
  const { data } = await db.from('business_members').select('user_id, role, access, created_at').eq('business_id', r.business_id).in('role', ['owner', 'editor']);
  const list = ((data ?? []) as any[]).filter((m) => (m.access ?? 'full') === 'full')
    .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner') || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  return list[0]?.user_id ?? null;
}
/** what an open invoice still owes: its total, less its credit invoices and the money recorded on it */
async function balanceOf(db: Db, inv: any): Promise<number> {
  const [{ data: credits }, { data: pays }] = await Promise.all([
    db.from('documents').select('total').eq('business_id', inv.business_id).eq('doc_type', 330).eq('base_doc_type', inv.doc_type).eq('base_doc_number', inv.doc_number),
    db.from('payments').select('direction, amount').eq('applies_to', inv.id),
  ]);
  const agorot = (n: unknown) => Math.round(Number(n ?? 0) * 100);
  const left = agorot(inv.total) - ((credits ?? []) as any[]).reduce((a, c) => a + agorot(c.total), 0)
    - ((pays ?? []) as any[]).reduce((a, p) => a + (p.direction === 'out' ? -agorot(p.amount) : agorot(p.amount)), 0);
  return left / 100;
}
const card = (amount: number) => [{ method: 'card' as const, amount, date: today() }];
const NOTE = 'שולם בכרטיס אשראי בלינק לתשלום';

/**
 * The receipt of a real payment, through the existing documents — never twice: the link's own key (paylink:<id>) is unique
 * in the business, and a second try finds the first document.
 *   an invoice (also a package's)  composeReceipt — a 305 gets a receipt (400); a 300 of a VAT business a 320, of an exempt one a 400
 *   an accepted quote, paid whole  its document at once: a tax invoice-receipt (320; exempt: a receipt 400) — the quote is converted
 *   an accepted quote, paid in part its invoice (the quote's own key: one invoice whoever converts it), then the receipt on it
 *   a deposit                       a 320 (exempt: 400) of the deposit; the register offsets it from the final payment
 * A refusal only the business can fix → "blocked" with the Hebrew reason, for the owner; anything else waits for the cron.
 */
export async function issuePaylinkReceipt(id: string): Promise<ReceiptResult> {
  const db = adminDb();
  const { data: row } = await db.from('payment_requests').select('*').eq('id', id).maybeSingle();
  const r = row as any;
  if (!r || r.status !== 'paid' || r.is_test) return { receipt: 'none' };
  if (r.receipt_status === 'issued') return { receipt: 'issued', document: r.receipt_document_id };
  if (r.receipt_status !== 'pending') return { receipt: 'none' };       // awaiting the owner, or blocked until approved again
  if (!(await businessOpen(r.business_id))) return { receipt: 'waiting', error: 'business_locked' };
  const key = `paylink:${r.id}`;
  const done = async (docId: string): Promise<ReceiptResult> => {
    const { error } = await db.rpc('paylink_receipt_done', { p_request: r.id, p_document: docId, p_error: '' });
    return error ? { receipt: 'waiting', error: error.message } : { receipt: 'issued', document: docId };
  };
  const block = async (reason: string): Promise<ReceiptResult> => {
    await db.rpc('paylink_receipt_done', { p_request: r.id, p_document: null, p_error: reason.slice(0, 300) });
    return { receipt: 'blocked', error: reason };
  };
  const had = await byKey(db, r.business_id, key);
  if (had) return done(had);
  const userId = await issuerUser(db, r);
  if (!userId) return block('לא נמצא בעל/ת העסק להפקת הקבלה.');
  const s = await settingsOf(db, r.business_id);
  const amount = Number(r.paid_amount ?? r.amount);
  const customer = { name: String(r.customer_name || 'לקוח'), phone: String(r.customer_phone ?? ''), email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.customer_email ?? '') ? r.customer_email : '' };
  const insert = async (res: ComposeResult, extra: { paidDocumentId?: string | null; quoteId?: string | null; idempotencyKey: string }): Promise<{ id: string } | { error: unknown }> => {
    if (!res.ok) return { error: { message: res.errors.join(' · '), code: 'compose' } };
    const doc = { ...res.doc, customerEmail: res.doc.customerEmail ?? customer.email };
    const ins = await db.from('documents').insert({
      ...documentRow(doc, { userId, idempotencyKey: extra.idempotencyKey, vatRate: res.totals.vatRate, leadId: r.lead_id, paidDocumentId: extra.paidDocumentId ?? null,
        quoteId: extra.quoteId ?? null }),
      business_id: r.business_id,
    }).select('id').single();
    if (!ins.error && ins.data) return { id: (ins.data as any).id };
    if (ins.error?.code === '23505' && /idempotency/.test(`${ins.error.message} ${ins.error.details ?? ''}`)) {
      const again = await byKey(db, r.business_id, extra.idempotencyKey);
      if (again) return { id: again };
    }
    return { error: ins.error };
  };
  const failed = (e: unknown): Promise<ReceiptResult> | ReceiptResult => {
    if ((e as any)?.code === 'compose') return block(`הקבלה לא הופקה: ${(e as any).message}`);
    const f = documentFailure(e);
    if (!f.blocked) { console.error('[paylinks] receipt', r.id, (e as any)?.message); return { receipt: 'waiting', error: f.reason }; }
    return block(f.reason);
  };
  /** the receipt for an open invoice */
  const onInvoice = async (inv: any): Promise<ReceiptResult> => {
    const { data: cancelled } = await db.from('document_cancellations').select('document_id').eq('document_id', inv.id).maybeSingle();
    if (cancelled) return block(`החשבונית בוטלה אחרי שנשלח הלינק — התשלום (${ils(amount)}) לא נרשם אוטומטית. רושמים אותו ידנית אחרי בדיקה, או מחזירים.`);
    const balance = await balanceOf(db, inv);
    const res = composeReceipt({ ...toDoc(inv), balance }, { entity: s.entity, vatRate: s.vatRate, payments: card(amount), docDate: today(), notes: NOTE });
    const out = await insert(res, { paidDocumentId: inv.id, idempotencyKey: key });
    return 'id' in out ? done(out.id) : failed(out.error);
  };

  if (r.kind === 'document') {
    const { data: inv } = await db.from('documents').select('*').eq('id', r.document_id).eq('business_id', r.business_id).maybeSingle();
    if (!inv) return block('החשבונית של הלינק לא נמצאה.');
    return onInvoice(inv);
  }
  if (r.kind === 'deposit') {
    const res = composeDocument({
      docType: chargesVat(s.entity) ? 320 : 400, entity: s.entity, vatRate: s.vatRate, pricesIncludeVat: true,
      lines: [{ name: String(r.label).replace(/^מקדמה לתור: /, 'מקדמה — ').slice(0, 120), qty: 1, unitPrice: amount }],
      customer, payments: card(amount), docDate: today(), notes: 'מקדמה ששולמה בלינק לתשלום — תקוזז מהתשלום על התור',
    });
    const out = await insert(res, { idempotencyKey: key });
    return 'id' in out ? done(out.id) : failed(out.error);
  }
  // an accepted quote
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: q } = await db.from('quotes').select('*').eq('id', r.quote_id).eq('business_id', r.business_id).maybeSingle();
    const quote = q as any;
    if (!quote) return block('הצעת המחיר של הלינק לא נמצאה.');
    if (quote.status === 'converted' && quote.converted_document_id) {
      const { data: doc } = await db.from('documents').select('*').eq('id', quote.converted_document_id).eq('business_id', r.business_id).maybeSingle();
      if (doc && [305, 300].includes((doc as any).doc_type)) return onInvoice(doc);
      return block(`ההצעה כבר הפכה ל${DOC_LABEL[(doc as any)?.doc_type] ?? 'מסמך'} — התשלום בלינק (${ils(amount)}) לא נרשם אוטומטית. רושמים אותו ידנית אחרי בדיקה.`);
    }
    if (quote.status !== 'accepted') return block('ההצעה כבר לא במצב "אושרה" (בוטלה?) — התשלום בלינק לא נרשם אוטומטית. רושמים אותו ידנית אחרי בדיקה.');
    const body = quote.body ?? {};
    const base = {
      entity: s.entity, vatRate: s.vatRate, pricesIncludeVat: body.pricesIncludeVat ?? true, lines: body.lines ?? [], discount: body.discount,
      customer: { ...(body.customer ?? {}), name: quote.customer_name || body.customer?.name || customer.name, phone: quote.customer_phone ?? '',
        email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(quote.customer_email ?? '') ? quote.customer_email : '' },
      docDate: today(), notes: `על פי הצעת מחיר מס׳ ${quote.quote_number}`,
    };
    // paid whole: one document that is also the receipt — when it adds up to exactly what was paid
    if (Math.round(amount * 100) === Math.round(Number(quote.total) * 100)) {
      const whole = composeDocument({ ...base, docType: chargesVat(s.entity) ? 320 : 400, payments: card(amount) });
      if (whole.ok) {
        const out = await insert(whole, { quoteId: quote.id, idempotencyKey: key });
        if ('id' in out) return done(out.id);
        if (/already used/.test(`${(out.error as any)?.message ?? ''}`)) continue;    // converted meanwhile: read it again
        return failed(out.error);
      }
    }
    // in part (or the sums moved): the quote's invoice, once — then the receipt on it
    const invRes = composeDocument({ ...base, docType: invoiceDocType(s.entity), dueDate: null });
    const inv = await insert(invRes, { quoteId: quote.id, idempotencyKey: quoteKey(quote.id) });
    if (!('id' in inv)) {
      if (/already used/.test(`${(inv.error as any)?.message ?? ''}`)) continue;
      return failed(inv.error);
    }
    const { data: invRow } = await db.from('documents').select('*').eq('id', inv.id).maybeSingle();
    if (!invRow) return { receipt: 'waiting', error: 'the invoice was not read back' };
    return onInvoice(invRow);
  }
  return { receipt: 'waiting', error: 'the quote changed twice' };
}
export async function byKey(db: Db, businessId: string, key: string): Promise<string | null> {
  const { data } = await db.from('documents').select('id').eq('business_id', businessId).eq('idempotency_key', key).maybeSingle();
  return (data as any)?.id ?? null;
}

// ---- the storefront told us: paid ---------------------------------------------------------------------------------------------
/** a link was paid (the storefront, once per payment): the owner's alert, and a real payment's receipt now (or awaiting) */
export async function finalizePaylink(id: string): Promise<{ request: string } & ReceiptResult> {
  const db = adminDb();
  const { data } = await db.from('payment_requests').select('id, business_id, status, is_test, amount, paid_amount, label, customer_name, paid_late, receipt_status')
    .eq('id', id).maybeSingle();
  const r = data as any;
  if (!r || r.status !== 'paid') return { request: id, receipt: 'none' };
  const receipt = r.is_test ? { receipt: 'none' as const } : await issuePaylinkReceipt(id);
  const who = r.customer_name ? ` · ${r.customer_name}` : '';
  await notifyManagers(r.business_id, {
    title: `💳 שולם בלינק${r.is_test ? ' (בדיקה)' : ''} · ${ils(Number(r.paid_amount ?? r.amount))}`,
    body: `${r.label}${who}${r.paid_late ? ' · שולם אחרי שהלינק נסגר — לבדוק' : ''}${!r.is_test && r.receipt_status === 'awaiting' ? ' · הקבלה ממתינה לאישורך' : ''}`.slice(0, 180),
    url: '/finance/income', tag: `paylink-${r.id}`,
  }).catch((e) => console.error('[paylinks] push', e?.message ?? e));
  return { request: id, ...receipt };
}

/** the cron (with the commerce cron): links past their time expire; the receipts waiting for the server are issued */
export async function paylinksCron(deadline: number): Promise<{ expired: number; receipts: ReceiptResult[] }> {
  const db = adminDb();
  const ex = await db.rpc('paylinks_expire');
  if (ex.error) return { expired: 0, receipts: [] };                     // before migration 4300: nothing to do
  const { data } = await db.rpc('paylinks_receipts_pending', { p_limit: 20 });
  const receipts: ReceiptResult[] = [];
  for (const id of (Array.isArray(data) ? data : []) as string[]) {
    if (Date.now() > deadline) break;
    receipts.push(await issuePaylinkReceipt(id));
  }
  return { expired: Number(ex.data ?? 0), receipts };
}

// ---- the storefront's server ---------------------------------------------------------------------------------------------------
/** POST <STOREFRONT_URL>/api/paylink with the shared secret (COMMERCE_SECRET): the only server that opens the terminal's keys */
export async function storefrontPaylink(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: Record<string, any> }> {
  const base = (process.env.STOREFRONT_URL ?? '').trim().replace(/\/+$/, '');
  const secret = process.env.COMMERCE_SECRET ?? '';
  if (!/^https?:\/\//.test(base) || secret.length < 16) return { ok: false, status: 503, json: { error: 'not_configured' } };
  try {
    const res = await fetch(`${base}/api/paylink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-commerce-secret': secret }, body: JSON.stringify(body),
      cache: 'no-store', signal: AbortSignal.timeout(25_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 502, json: { error: 'unreachable' } };
  }
}

/** "בדיקת חיבור": the storefront makes a page of ₪1 with the terminal's keys → verified */
export async function checkTerminalLink(businessId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await storefrontPaylink({ action: 'check', business: businessId });
  if (r.ok && r.json.ok === true) return { ok: true };
  const e = String(r.json.error ?? '');
  const message = e === 'not_configured' ? 'השרת עוד לא מוכן לבדיקה (חסרים STOREFRONT_URL או COMMERCE_SECRET ב-Vercel).'
    : e === 'unreachable' ? 'אתר החנות לא ענה — נסו שוב בעוד רגע.'
    : e === 'provider' ? 'ספק התשלום סירב למפתחות — בדקו את מפתח ה-API, המפתח הסודי ומזהה עמוד התשלום, וחברו מחדש.'
    : e === 'payment' ? 'המפתחות השמורים לא נפתחים בשרת החנות (PAYMENT_SEAL_KEY שונה בין הפרויקטים?).'
    : e === 'no_terminal' ? 'לא מחובר מסוף.'
    : e === 'terminal_changed' ? 'המפתחות השתנו בזמן הבדיקה — נסו שוב.'
    : 'הבדיקה לא הצליחה — נסו שוב.';
  return { ok: false, message };
}

// ---- the customer's page -------------------------------------------------------------------------------------------------------
export interface PublicLink {
  status: PaylinkStatus; label: string; amount: number; currency: string; business: string; phone: string; customer: string; expiresAt: string;
  test: boolean; paidAt: string | null; late: boolean;
}
/** what the customer's page shows — nothing internal (no ids, no phone or email of the customer, no terminal) */
export async function publicLink(id: string): Promise<{ link: PublicLink; businessId: string; origin: string } | null> {
  const db = adminDb();
  const { data } = await db.from('payment_requests').select('id, business_id, status, label, amount, currency, customer_name, expires_at, is_test, paid_at, paid_late, link_origin')
    .eq('id', id).maybeSingle();
  const r = data as any;
  if (!r) return null;
  const who = await businessContact(db, r.business_id);
  return {
    businessId: r.business_id, origin: r.link_origin,
    link: {
      status: paylinkState({ status: r.status, expiresAt: r.expires_at }), label: r.label, amount: Number(r.amount), currency: r.currency ?? 'ILS',
      business: who.name, phone: who.phone, customer: String(r.customer_name ?? '').trim().split(/\s+/)[0] ?? '', expiresAt: r.expires_at,
      test: Boolean(r.is_test), paidAt: r.paid_at ?? null, late: Boolean(r.paid_late),
    },
  };
}
