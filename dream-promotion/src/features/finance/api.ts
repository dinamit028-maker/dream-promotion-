'use client';
import { supabase } from '@/lib/supabase/client';
import { toDoc, type DocRow } from '@/features/documents/documents';

/**
 * The money screens' way to the database. Everything goes through row-level security (the signed-in user's own
 * rights): the business worked in now, its money open to the caller, never a cashier — the database decides,
 * the screens only follow. Errors come back in Hebrew.
 */
export { FINANCE_MIGRATION, financeError, documentRow, type IssueExtra } from './rows';
import { financeError } from './rows';

/**
 * Issue a document once. A retry with the same key (a double tap, a lost answer, two devices issuing "the next" receipt
 * or credit of the same invoice) returns the document that was already issued instead of a second one (`again`).
 * Never without the key: migration 20261004003100 is on the live database (2.52.1 removed the fallback without it).
 */
export async function issueDocumentRow(row: Record<string, unknown>): Promise<{ ok: true; doc: DocRow; again: boolean } | { ok: false; error: string; raw?: unknown }> {
  const sb = supabase();
  const first = await sb.from('documents').insert(row).select('*').single();
  if (!first.error && first.data) return { ok: true, doc: toDoc(first.data), again: false };
  const m = String(first.error?.message ?? '');
  if (first.error && (first.error.code === '23505' || /duplicate key/.test(m)) && /idempotency/.test(m + String(first.error.details ?? ''))) {
    const { data } = await sb.from('documents').select('*').eq('idempotency_key', String(row.idempotency_key)).maybeSingle();
    if (data) return { ok: true, doc: toDoc(data), again: true };
  }
  return { ok: false, error: financeError(first.error), raw: first.error };
}

/** where the caller stands: member or super admin, is the business's money open to them, closed books */
export interface AccessState { business: string | null; superAdmin: boolean; access: 'full' | 'register'; member: boolean; open: boolean; grantUntil: string | null; lockedUntil: string | null }
export async function accessState(): Promise<{ ok: true; state: AccessState } | { ok: false; error: string }> {
  const { data, error } = await supabase().rpc('finance_access_state');
  if (error || !data) return { ok: false, error: financeError(error) };
  return { ok: true, state: data as AccessState };
}
export async function logEvent(action: string, entity = '', entityId = '', details: Record<string, unknown> = {}) {
  try { await supabase().rpc('log_finance_event', { p_action: action, p_entity: entity, p_entity_id: entityId, p_details: details }); } catch { /* the log never blocks the user */ }
}
export const newKey = (kind: string) => `${kind}:${crypto.randomUUID()}`;
