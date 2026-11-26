import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';
import { adminDb } from './admin';
import { businessOpen } from './business';
import { buildDocPdf } from './doc-pdf';
import { certificateInfo, signedPdfBytes } from './sign-pdf';
import { toDoc, type DocRow } from '@/features/documents/documents';
import { SEED_RULES, allocationNeed, allocationPrintLine, allocationState, toAllocationRow, toRule } from '@/features/finance/allocation';
import { entityOf } from '@/features/finance/rules';
import { AWAITING_CUSTOMER, isMissing, toDelivery, type Delivery } from '@/features/finance/delivery';

/**
 * A document behind a customer's link (/d/<token>, its PDF, the storefront's copy): the document, the business as printed (its own
 * issuer snapshot from 2.51; the business's details of today for older documents), whether it was cancelled, and the
 * allocation-number line — a real number or "טרם התקבל" (a test number is never shown to the customer). Never internal ids.
 *
 * 2.119 (migration 20261126006900 — the accountant's answers 1, 2, 3א, 6 and 6 נוסף of 25.11.2026): the ONE way in is
 * document_share_open(token, channel) — the database records the delivery and answers whether it is the original ("מקור") or a
 * true copy ("העתק נאמן למקור"), or refuses (not_found / unavailable / awaiting_allocation — a document that needs an allocation
 * number and has none is never shown). The document is then read by the id it returned, and printed with its mark. The first
 * delivery's PDF is kept as it was delivered (keepDelivered). A database before that migration (no such function): as before it —
 * read by the token, the mark "מסמך ממוחשב", nothing recorded.
 */
export type SharedBusiness = { dealerNumber: string; name: string; street: string; houseNo: string; city: string; zip: string; entityType: string };
export type SharedDoc = { row: Record<string, unknown>; doc: DocRow & { cancelled: boolean }; business: SharedBusiness; allocation: string | null };
export type Shared = ({ ok: true; mark: string; delivery: Delivery | null } & SharedDoc)
  | { ok: false; status: 404 | 403 | 409 | 503; code: 'not_found' | 'unavailable' | 'awaiting_allocation' | 'error' };
/** the mark of a document before 2.119 (no record of deliveries) — as the customer's copy always said */
export const LEGACY_MARK = 'מסמך ממוחשב';
export type ShareChannel = 'link' | 'pdf' | 'storefront';

export async function sharedDocument(token: string, channel: ShareChannel = 'link'): Promise<Shared> {
  if (!/^[a-f0-9]{64}$/.test(token)) return { ok: false, status: 404, code: 'not_found' };
  const db = adminDb();
  const { data: open, error } = await db.rpc('document_share_open', { p_token: token, p_channel: channel });
  if (error) {
    if (isMissing(error)) return legacyShared(db, token);
    console.error('[doc-share] document_share_open failed', error.code ?? '');
    return { ok: false, status: 503, code: 'error' };
  }
  if (!open || open.ok !== true) {
    const code = open?.code;
    return code === 'unavailable' ? { ok: false, status: 403, code } : code === 'awaiting_allocation' ? { ok: false, status: 409, code } : { ok: false, status: 404, code: 'not_found' };
  }
  const delivery = toDelivery(open);
  if (!delivery) { console.error('[doc-share] document_share_open: an answer without a delivery'); return { ok: false, status: 503, code: 'error' }; }
  const { data: d } = await db.from('documents').select('*').eq('id', delivery.documentId).maybeSingle();
  if (!d) return { ok: false, status: 404, code: 'not_found' };
  return { ok: true, mark: delivery.mark, delivery, ...(await presentDocument(db, d as Record<string, unknown>)) };
}

/** the answer of a refused link (403 — the business is locked — answers UNAVAILABLE, as before) */
export const shareRefusal = (code: string) => (code === 'awaiting_allocation' ? { code, message: AWAITING_CUSTOMER }
  : code === 'error' ? { code, message: 'לא הצלחנו לפתוח את המסמך כרגע. נסו שוב בעוד רגע.' } : { code: 'not_found' });
/** work after the answer went out (Next's after()); outside a request (the unit tests) — now, without waiting for it */
export function later(fn: () => Promise<unknown>) {
  const run = () => fn().catch((e) => console.error('[doc-share] after the answer', e?.name ?? 'error'));
  try { after(run); } catch { void run(); }
}

/** before migration 20261126006900: as 2.118 did it — by the token, an open business, nothing recorded */
async function legacyShared(db: SupabaseClient, token: string): Promise<Shared> {
  const { data: d } = await db.from('documents').select('*').eq('share_token', token).maybeSingle();
  if (!d) return { ok: false, status: 404, code: 'not_found' };
  if (!(await businessOpen((d as any).business_id))) return { ok: false, status: 403, code: 'unavailable' };
  return { ok: true, mark: LEGACY_MARK, delivery: null, ...(await presentDocument(db, d as Record<string, unknown>)) };
}

/** what a printed document shows, from the document row (the service role — the caller was checked before) */
export async function presentDocument(db: SupabaseClient, d: Record<string, unknown>): Promise<SharedDoc> {
  const bid = d.business_id as string, id = d.id as string;
  const [{ data: s }, { data: b }, cx, al, st, rl] = await Promise.all([
    db.from('register_settings').select('*').eq('business_id', bid).maybeSingle(),
    db.from('brands').select('name').eq('business_id', bid).maybeSingle(),
    db.from('document_cancellations').select('document_id').eq('document_id', id).maybeSingle(),
    db.from('tax_allocations').select('*').eq('document_id', id),
    // 2.119: whether it needs a number — the database's rule (the view); before migration 20261126006900 — the rule rows, read here
    db.from('document_allocation_status').select('required').eq('document_id', id).maybeSingle(),
    db.from('tax_allocation_rules').select('*'),
  ]);
  const sx = s as any;
  const business = { dealerNumber: sx?.dealer_number ?? '', name: sx?.legal_name || (b as any)?.name || '', street: sx?.street ?? '', houseNo: sx?.house_no ?? '', city: sx?.city ?? '',
    zip: sx?.zip ?? '', entityType: entityOf(sx?.entity_type, sx?.business_type) };
  const doc = toDoc(d);
  // before migration 20261004003100 these tables do not exist: no cancellation, no allocation line
  const rows = al.error ? [] : ((al.data ?? []) as any[]).map(toAllocationRow);
  const rules = rl.error || !rl.data?.length ? SEED_RULES : (rl.data as any[]).map(toRule);
  const legacy = allocationNeed(doc, { entityType: doc.issuer?.entityType ?? business.entityType }, rules);
  const need = !st.error && st.data ? { ...legacy, required: (st.data as any).required === true } : legacy;
  // the customer's copy shows a real allocation number or "not received yet" — a test number (mock gateway) never reaches it
  const state = allocationState(rows.filter((r) => !r.isTest), need);
  return { row: d, doc: { ...doc, cancelled: !cx.error && Boolean(cx.data) }, business, allocation: allocationPrintLine(state) };
}

/** the mark printed on the PDF: the delivery's ("מקור" / "העתק נאמן למקור", or before 2.119 "מסמך ממוחשב"), and "בוטל" */
export const pdfMark = (mark: string, cancelled: boolean) => (cancelled ? `${mark} · בוטל` : mark);
/** the software line of the PDF: the registration number only when there is a real one (as on the screen) — never "00000000" */
export function softwareLine(env: Record<string, string | undefined> = process.env) {
  const reg = env.NEXT_PUBLIC_SOFTWARE_REG_NUMBER ?? '';
  return `Dream Promotion ${env.NEXT_PUBLIC_APP_VERSION ?? ''}`.trim() + (/^\d{8}$/.test(reg) && reg !== '00000000' ? ` · תוכנה רשומה מס׳ ${reg}` : '');
}
/** the PDF of a document with its mark — signed digitally when the certificate is configured */
export async function documentPdf(s: SharedDoc, mark: string): Promise<{ bytes: Uint8Array; signed: boolean }> {
  const doc = s.doc;
  const willSign = certificateInfo().configured;
  const pdf = await buildDocPdf(doc, s.business, { mark: pdfMark(mark, doc.cancelled), software: softwareLine(), signed: willSign, allocation: s.allocation });
  return signedPdfBytes(pdf, { name: 'Dream Promotion', reason: `Document ${doc.docType}-${doc.docNumber} (${doc.issuer?.dealerNumber || s.business.dealerNumber})` });
}
export const pdfHeaders = (doc: { docType: number; docNumber: number }, signed: boolean) => ({
  'Content-Type': 'application/pdf',
  'Content-Disposition': `inline; filename="doc-${doc.docType}-${doc.docNumber}.pdf"`,
  'Cache-Control': 'no-store',
  'X-Signed': signed ? '1' : '0',
});

export const DELIVERED_BUCKET = 'delivered-documents';
const FILE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/;
/**
 * The accountant's answer 6 נוסף: the original's PDF is kept as it was delivered — the same bytes — in the private bucket
 * delivered-documents at the path the database gave (<business>/<document>/<delivery>.pdf; never replaced: upsert false), then
 * document_delivery_file_add records it with its sha256. Only the original (a copy is the same document marked "העתק נאמן למקור").
 * Never throws, never in the customer's way: a failure is logged (its code only — no number, name or amount) and answered.
 */
export async function keepDelivered(db: SupabaseClient, delivery: Delivery, bytes: Uint8Array): Promise<{ kept: boolean; error?: string }> {
  if (!delivery.original) return { kept: false };
  if (!FILE_PATH.test(delivery.filePath) || !bytes.byteLength) return { kept: false, error: 'bad_path' };
  try {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const up = await db.storage.from(DELIVERED_BUCKET).upload(delivery.filePath, bytes, { contentType: 'application/pdf', upsert: false });
    // already there (a retry after a lost answer): the database compares the sha256 — the same file is fine, another one is refused
    if (up.error && !/exists|duplicate|409/i.test(`${(up.error as any).statusCode ?? ''} ${up.error.message ?? ''}`)) {
      console.error('[doc-share] keep delivered file: upload', (up.error as any).statusCode ?? 'error');
      return { kept: false, error: 'upload' };
    }
    const { error } = await db.rpc('document_delivery_file_add', { p_delivery: delivery.deliveryId, p_sha256: sha256, p_bytes: bytes.byteLength });
    if (error) { console.error('[doc-share] keep delivered file: record', error.code ?? 'error'); return { kept: false, error: 'record' }; }
    return { kept: true };
  } catch (e: any) {
    console.error('[doc-share] keep delivered file', e?.name ?? 'error');
    return { kept: false, error: 'exception' };
  }
}

/**
 * A delivery from the app (document_delivery_record, by the signed-in person — its user_id), recent (15 minutes), of a channel of
 * the app: print / pdf / email / whatsapp. The mark is the database's (is_original). For /api/doc/delivery only.
 */
export async function appDelivery(db: SupabaseClient, userId: string, deliveryId: unknown, now = Date.now()):
  Promise<{ ok: true; delivery: Delivery } | { ok: false; status: 400 | 404; code: string; message: string }> {
  if (typeof deliveryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(deliveryId)) return { ok: false, status: 400, code: 'bad_request', message: 'מסירה לא תקינה.' };
  const { data: v, error } = await db.from('document_deliveries').select('*').eq('id', deliveryId).maybeSingle();
  const r = v as any;
  if (error || !r || r.user_id !== userId || !['print', 'pdf', 'email', 'whatsapp'].includes(r.channel)
      || !(now - Date.parse(r.created_at) <= 15 * 60_000 && now - Date.parse(r.created_at) >= -60_000)) {
    return { ok: false, status: 404, code: 'not_found', message: 'המסירה לא נמצאה. נסו שוב מהמסמך.' };
  }
  const delivery = toDelivery({ ok: true, delivery_id: r.id, document_id: r.document_id, business_id: r.business_id, channel: r.channel, original: r.is_original === true,
    at: r.created_at, print_count: 0, file_path: `${r.business_id}/${r.document_id}/${r.id}.pdf` });
  return delivery ? { ok: true, delivery } : { ok: false, status: 404, code: 'not_found', message: 'המסירה לא נמצאה. נסו שוב מהמסמך.' };
}

/**
 * The document row as the customer may see it: only what the printed document shows (an allow-list — a column added later
 * stays private until it is added here). Never ids, counters, keys, who in the business issued it, or a product's id.
 */
const PUBLIC = ['doc_type', 'doc_number', 'issued_at', 'doc_date', 'due_date', 'customer_name', 'customer_phone', 'customer_dealer', 'customer_street',
  'customer_city', 'before_discount', 'discount', 'after_discount', 'vat_amount', 'total', 'vat_rate', 'base_doc_type', 'base_doc_number', 'notes', 'issuer'];
const LINE = ['name', 'qty', 'unitPriceExVat', 'discountExVat', 'totalExVat', 'vatRate', 'kind'];
const CHEQUE = ['bank', 'branch', 'number', 'dueDate'];
const pick = (o: unknown, keys: string[]) => Object.fromEntries(keys.filter((k) => o && typeof o === 'object' && k in o).map((k) => [k, (o as Record<string, unknown>)[k]]));
export function publicDoc(row: Record<string, unknown>) {
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    ...pick(row, PUBLIC),
    lines: list(row.lines).map((l) => pick(l, LINE)),
    payments: list(row.payments).map((p) => ({ ...pick(p, ['method', 'amount', 'date']), ...(p?.cheque ? { cheque: pick(p.cheque, CHEQUE) } : {}) })),
  };
}
