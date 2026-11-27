'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { financeError } from './rows';
import { loadBooksMoreState } from './books-data';
import type { BooksState } from './books';
import {
  manualArgs, openingArgs, toBalanceSheet, toBookJournal, toChart, toLedger, toProfitLoss, toReconcile, toTrialBalance, type BalanceSheet, type BookJournal,
  type ChartAccount, type Ledger, type ManualDraft, type OpeningLine, type ProfitLoss, type Reconcile, type TrialBalance,
} from './ledger';

/**
 * 2.123 — "הנהלת חשבונות" from the browser (migration 20261129007200). The reports are the database's functions, called as the
 * signed-in person (security invoker — the RLS of the business and the locations; a cashier gets nothing). The writes are the
 * owner's functions (gl_owner_guard: journal_writer — the database refuses anyone else, books_not_allowed). Nothing is computed here.
 * Before 7200 none of it is offered (loadBooksMoreState = null): no menu item, and the route says what is missing.
 */
export type Res<T> = { ok: true; data: T } | { ok: false; error: string };
async function rpc<T>(fn: string, args: Record<string, unknown>, to: (j: any) => T): Promise<Res<T>> {
  try {
    const { data, error } = await supabase().rpc(fn, args);
    if (error || data == null) return { ok: false, error: financeError(error) };
    return { ok: true, data: to(data) };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}

export const loadTrialBalance = (from: string, to: string): Promise<Res<TrialBalance>> => rpc('report_trial_balance', { p_from: from, p_to: to }, toTrialBalance);
export const loadLedger = (account: string, from: string, to: string): Promise<Res<Ledger>> => rpc('report_ledger', { p_account: account, p_from: from, p_to: to }, toLedger);
export const loadBookJournal = (from: string, to: string): Promise<Res<BookJournal>> => rpc('report_journal', { p_from: from, p_to: to }, toBookJournal);
export const loadProfitLoss = (from: string, to: string): Promise<Res<ProfitLoss>> => rpc('report_profit_loss', { p_from: from, p_to: to }, toProfitLoss);
export const loadBalanceSheet = (asOf: string): Promise<Res<BalanceSheet>> => rpc('report_balance_sheet', { p_as_of: asOf }, toBalanceSheet);
export const loadReconcile = (from: string, to: string): Promise<Res<Reconcile>> => rpc('gl_reconcile', { p_from: from, p_to: to }, toReconcile);

/** the chart — every account, active or not (gl_accounts through the RLS: the whole business's money; a member limited to locations
 *  reads none — then the screens take the accounts of the trial balance) */
export async function loadChart(): Promise<Res<ChartAccount[]>> {
  try {
    const { data, error } = await supabase().from('gl_accounts').select('key, name, kind, tb_code, tb_name, parent_key, role, active').order('key').limit(10000);
    if (error) return { ok: false, error: financeError(error) };
    return { ok: true, data: toChart(data) };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}

/** the documents an entry refers to (type and number) → their ids, to open them (/finance/documents?open=<id>); {} on a failure (the
 *  reference then stays text) */
export async function loadDocIds(refs: { type: number; number: number }[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!refs.length) return out;
  try {
    const nums = [...new Set(refs.map((r) => r.number))];
    const types = [...new Set(refs.map((r) => r.type))];
    const batches = Array.from({ length: Math.ceil(nums.length / 100) }, (_, i) => nums.slice(i * 100, i * 100 + 100));
    const res = await Promise.all(batches.map((b) => supabase().from('documents').select('id, doc_type, doc_number').in('doc_type', types).in('doc_number', b).limit(1000)));
    for (const r of res) for (const d of (r.data ?? []) as { id: string; doc_type: number; doc_number: number }[]) out[`doc:${d.doc_type}:${Number(d.doc_number)}`] = String(d.id);
  } catch { /* a help only */ }
  return out;
}

type Wrote = { id: string; number: number; created: boolean };
const wrote = (j: any): Wrote => ({ id: String(j?.id ?? ''), number: Number(j?.number ?? 0), created: j?.created !== false });
/** a manual double entry (the owner) — the id is the form's: a second tap returns the same entry */
export const createManual = (id: string, d: ManualDraft, location: string | null) => rpc('gl_manual_create', manualArgs(id, d, location), wrote);
/** the reversing entry of a manual one (once) */
export const reverseManual = (id: string, entry: string, date: string, details: string) =>
  rpc('gl_manual_reverse', { p_id: id, p_entry: entry, p_date: date, p_details: details.trim() || null }, wrote);
export const addAccount = (d: { key: string; name: string; kind: string; tbCode: string; tbName: string; parentKey: string }) =>
  rpc('gl_account_add', { p_key: d.key.trim(), p_name: d.name.trim(), p_kind: d.kind, p_tb_code: d.tbCode.trim() || null, p_tb_name: d.tbName.trim() || null,
    p_parent_key: d.parentKey.trim() || null }, (j) => ({ key: String(j?.key ?? d.key) }));
export const updateAccount = (key: string, d: { name: string; tbCode: string; tbName: string; newKey: string }) =>
  rpc('gl_account_update', { p_key: key, p_name: d.name.trim() || null, p_tb_code: d.tbCode.trim() || null, p_tb_name: d.tbName.trim() || null,
    p_new_key: d.newKey.trim() || null }, (j) => ({ key: String(j?.key ?? key) }));
export const setAccountActive = (key: string, active: boolean) => rpc('gl_account_set_active', { p_key: key, p_active: active }, (j) => ({ active: j?.active === true }));
/** the opening balances, once (the owner) */
export const saveOpening = (lines: OpeningLine[], chart: ChartAccount[]) =>
  rpc('gl_opening_balances', { p_lines: openingArgs(lines, chart) }, (j) => ({ number: Number(j?.number ?? 0), opening: Number(j?.opening ?? 0) }));

/** the books' state for the area (7200 there, the person in the business): null while asking / before 7200 / not readable */
export function useBooksArea(): { asked: boolean; state: BooksState | null; reload: () => void } {
  const [s, setS] = useState<{ asked: boolean; state: BooksState | null }>({ asked: false, state: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    void loadBooksMoreState().then((st) => { if (alive) setS({ asked: true, state: st }); }, () => alive && setS({ asked: true, state: null }));
    return () => { alive = false; };
  }, [n]);
  return { ...s, reload: () => setN((x) => x + 1) };
}
