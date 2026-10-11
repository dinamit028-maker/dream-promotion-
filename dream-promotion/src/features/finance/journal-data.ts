'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { financeError } from './rows';
import { entryArgs, toEntries, type JournalDraft, type JournalEntry } from './journal';

/**
 * Manual journal entries' way to the database (2.96, migration 20261011005100). The list is read as the signed-in user (the
 * business, its money open to them, the location picked at the top — the table's own policies); the two writes are functions of
 * the database, which keep every rule (only the business's owners, closed books, the audit log). Until the migration is in the
 * database nothing of it is offered (journalReady is false): no menu item, the reports as they were.
 */
let ready: Promise<boolean> | null = null;
/** is migration 5100 in this database? (asked once a page: its table answers) */
export function journalReady(): Promise<boolean> {
  ready ??= Promise.resolve(supabase().from('journal_entries').select('id').limit(1)).then(({ error }) => !error, () => false);
  return ready;
}
/** null while asking, then whether the migration is there */
export function useJournalReadyState(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => { let alive = true; void journalReady().then((v) => { if (alive) setOk(v); }); return () => { alive = false; }; }, []);
  return ok;
}
export const JOURNAL_MIGRATION = 'צריך להריץ את מיגרציה 20261011005100 (פקודות יומן ידניות) ב-Supabase לפני שהמסך הזה עובד.';

export type Res<T> = { ok: true; data: T } | { ok: false; error: string };
const COLS = 'id, number, entry_date, kind, amount, vat, vat_side, category, explanation, location_id, party_kind, lead_id, party_name, party_dealer, reverses, created_at';

/** the entries of a period (newest first), with the numbers of the entries that undid them or that they undo outside it */
export async function loadEntries(p: { from: string; to: string }): Promise<Res<JournalEntry[]>> {
  try {
    const sb = supabase();
    const { data, error } = await sb.from('journal_entries').select(COLS).gte('entry_date', p.from).lte('entry_date', p.to).order('number', { ascending: false }).limit(2000);
    if (error) return { ok: false, error: financeError(error) };
    const rows = data ?? [];
    const here = new Set(rows.map((r: any) => String(r.id)));
    // a reversal is dated on or after the entry it undoes: the reversals of this period's entries are among the reversals from its
    // first day on (few — never every id of the period in one address)
    const later = sb.from('journal_entries').select('id, number, reverses').not('reverses', 'is', null).gte('entry_date', p.from).limit(5000);
    // the entries this period's reversals undo that are of an earlier period — by id, a hundred at a time
    const before = [...new Set(rows.filter((r: any) => r.reverses && !here.has(String(r.reverses))).map((r: any) => String(r.reverses)))];
    const batches = Array.from({ length: Math.ceil(before.length / 100) }, (_, i) => before.slice(i * 100, i * 100 + 100));
    const [a, ...b] = await Promise.all([later, ...batches.map((ids) => sb.from('journal_entries').select('id, number, reverses').in('id', ids))]);
    const failed = [a, ...b].find((x) => x.error);
    if (failed) return { ok: false, error: financeError(failed.error) };
    return { ok: true, data: toEntries(rows, [...(a.data ?? []), ...b.flatMap((x) => x.data ?? [])]) };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}
/** may the signed-in member record entries? (the business's owners — every location, full access) */
export async function loadWriter(): Promise<boolean> {
  try { const { data, error } = await supabase().rpc('journal_writer'); return !error && data === true; } catch { return false; }
}
async function call(fn: string, args: Record<string, unknown>): Promise<Res<{ id: string; number: number; created: boolean }>> {
  try {
    const { data, error } = await supabase().rpc(fn, args);
    if (error || data == null) return { ok: false, error: financeError(error) };
    return { ok: true, data: { id: String((data as any).id), number: Number((data as any).number), created: Boolean((data as any).created) } };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}
/** a new entry — the id is the form's (a second tap is the same entry) */
export const createEntry = (id: string, d: JournalDraft, vatOn: boolean) => call('journal_entry_create', entryArgs(id, d, vatOn));
/** undo an entry: the same entry with the opposite sign, once, with a reason */
export const reverseEntry = (id: string, entry: string, date: string, reason: string) =>
  call('journal_entry_reverse', { p_id: id, p_entry: entry, p_date: date, p_explanation: reason.trim() });
