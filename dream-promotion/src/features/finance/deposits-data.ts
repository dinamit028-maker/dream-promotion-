import { supabase } from '@/lib/supabase/client';
import { toDepositDocs, type DepositDoc } from './paylinks';

/**
 * What was really paid as a deposit for these appointments (never a test one), and the documents issued for it — for the
 * register's line ("יתרה אחרי מקדמה ₪100, חשבונית מס / קבלה 15"; the accountant, 11.10.2026). The register (a cashier too) and
 * the appointments screen. appointment_deposit_receipts (migration 20261011005200); before it appointment_deposits
 * (20261010004300) — the amount alone, as before; before both, nothing (an empty map).
 */
export interface Deposit { amount: number; docs: DepositDoc[] }
let withDocs: boolean | null = null;
export async function loadDeposits(ids: string[]): Promise<Map<string, Deposit>> {
  const out = new Map<string, Deposit>();
  if (!ids.length) return out;
  const sb = supabase();
  let rows: any[] | null = null;
  if (withDocs !== false) {
    const r = await sb.rpc('appointment_deposit_receipts', { p_ids: ids });
    withDocs = !r.error;
    rows = r.error ? null : ((r.data ?? []) as any[]);
  }
  if (!rows) {
    const r = await sb.rpc('appointment_deposits', { p_ids: ids });
    rows = r.error ? [] : ((r.data ?? []) as any[]);
  }
  for (const x of rows) out.set(String(x.appointment_id), { amount: Number(x.amount) || 0, docs: toDepositDocs(x.receipts) });
  return out;
}
