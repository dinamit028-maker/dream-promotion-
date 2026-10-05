import { adminDb } from './admin';
import { businessOpen } from './business';
import { toDoc, type DocRow } from '@/features/documents/documents';
import { SEED_RULES, allocationNeed, allocationPrintLine, allocationState, toAllocationRow, toRule } from '@/features/finance/allocation';
import { entityOf } from '@/features/finance/rules';

/**
 * A document behind a customer's link (/d/<token> and its PDF): the document, the business as printed (its own issuer
 * snapshot from 2.51; the business's details of today for older documents), whether it was cancelled, and the
 * allocation-number line — a real number or "טרם התקבל" (a test number is never shown to the customer). Never internal ids.
 */
export type Shared = { ok: true; row: Record<string, unknown>; doc: DocRow & { cancelled: boolean }; business: { dealerNumber: string; name: string; street: string; houseNo: string; city: string; zip: string; entityType: string }; allocation: string | null }
  | { ok: false; status: 404 | 403 };
export async function sharedDocument(token: string): Promise<Shared> {
  if (!/^[a-f0-9]{64}$/.test(token)) return { ok: false, status: 404 };
  const db = adminDb();
  const { data: d } = await db.from('documents').select('*').eq('share_token', token).maybeSingle();
  if (!d) return { ok: false, status: 404 };
  const bid = (d as any).business_id;
  if (!(await businessOpen(bid))) return { ok: false, status: 403 };
  const [{ data: s }, { data: b }, cx, al, rl] = await Promise.all([
    db.from('register_settings').select('*').eq('business_id', bid).maybeSingle(),
    db.from('brands').select('name').eq('business_id', bid).maybeSingle(),
    db.from('document_cancellations').select('document_id').eq('document_id', (d as any).id).maybeSingle(),
    db.from('tax_allocations').select('*').eq('document_id', (d as any).id),
    db.from('tax_allocation_rules').select('*'),
  ]);
  const st = s as any;
  const business = { dealerNumber: st?.dealer_number ?? '', name: st?.legal_name || (b as any)?.name || '', street: st?.street ?? '', houseNo: st?.house_no ?? '', city: st?.city ?? '',
    zip: st?.zip ?? '', entityType: entityOf(st?.entity_type, st?.business_type) };
  const doc = toDoc(d);
  // before migration 20261004003100 these tables do not exist: no cancellation, no allocation line
  const rows = al.error ? [] : ((al.data ?? []) as any[]).map(toAllocationRow);
  const rules = rl.error || !rl.data?.length ? SEED_RULES : (rl.data as any[]).map(toRule);
  // the customer's copy shows a real allocation number or "not received yet" — a test number (mock gateway) never reaches it
  const state = allocationState(rows.filter((r) => !r.isTest), allocationNeed(doc, { entityType: doc.issuer?.entityType ?? business.entityType }, rules));
  return { ok: true, row: d as Record<string, unknown>, doc: { ...doc, cancelled: !cx.error && Boolean(cx.data) }, business, allocation: allocationPrintLine(state) };
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
