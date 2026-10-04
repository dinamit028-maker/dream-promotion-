import { adminDb } from './admin';
import { businessOpen } from './business';
import { toDoc, type DocRow } from '@/features/documents/documents';
import { SEED_RULES, allocationNeed, allocationPrintLine, allocationState, toAllocationRow, toRule } from '@/features/finance/allocation';
import { entityOf } from '@/features/finance/rules';

/**
 * A document behind a customer's link (/d/<token> and its PDF): the document, the business as printed (its own issuer
 * snapshot from 2.51; the business's details of today for older documents), whether it was cancelled, and the
 * allocation-number line — a real number, "טרם התקבל", or a test number that says it is one. Never internal ids.
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
  const state = allocationState(rows, allocationNeed(doc, { entityType: doc.issuer?.entityType ?? business.entityType }, rules));
  return { ok: true, row: d as Record<string, unknown>, doc: { ...doc, cancelled: !cx.error && Boolean(cx.data) }, business, allocation: allocationPrintLine(state) };
}
/** the document row as the customer may see it: the content, never the ids that tie it to the business's records */
const PRIVATE = ['user_id', 'business_id', 'lead_id', 'sale_id', 'share_token', 'refund_id', 'paid_document_id', 'quote_id', 'draft_id', 'idempotency_key', 'source'];
export function publicDoc(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !PRIVATE.includes(k)));
}
