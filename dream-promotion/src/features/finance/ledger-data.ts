'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { financeError } from './rows';
import { pageAll } from './paging';
import { loadBooksMoreState } from './books-data';
import type { BooksState } from './books';
import {
  OPENING_SUPPLIER_NOT_YET, manualArgs, openingArgs, openingSupplierRefused, toBalanceSheet, toBookJournal, toChart, toLedger, toProfitLoss, toReconcile, toTrialBalance, type BalanceSheet, type BookJournal,
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

/** the chart — every account, active or not (gl_accounts through the RLS: the business's money; a member limited to locations reads
 *  the accounts of no location and of their own locations — gl_accounts_location_gate of 7100; another location's cash / cheques
 *  are not among them). An empty chart (not opened yet) — the ledger then takes the accounts of the trial balance */
export const CHART_MAX = 50_000;
export async function loadChart(): Promise<Res<{ accounts: ChartAccount[]; truncated: boolean }>> {
  try {
    // every account, in pages (max_rows): by key — unique in the business, so the pages never overlap
    const { data, error, truncated } = await pageAll((from, to) => supabase().from('gl_accounts').select('key, name, kind, tb_code, tb_name, parent_key, role, active, lead_id')
      .order('key').range(from, to), CHART_MAX);
    if (error) return { ok: false, error: financeError(error) };
    return { ok: true, data: { accounts: toChart(data), truncated } };
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
    // at most 3 requests at a time (a long period has many references)
    for (let i = 0; i < batches.length; i += 3) {
      const res = await Promise.all(batches.slice(i, i + 3).map((b) => pageAll((from, to) => supabase().from('documents').select('id, doc_type, doc_number')
        .in('doc_type', types).in('doc_number', b).order('id').range(from, to))));
      for (const r of res) for (const d of (r.data ?? []) as { id: string; doc_type: number; doc_number: number }[]) out[`doc:${d.doc_type}:${Number(d.doc_number)}`] = String(d.id);
    }
  } catch { /* a help only */ }
  return out;
}

/** the suppliers of the business's expenses (name, dealer number) for the opening balances' supplier picker — [] on a failure */
export const SUPPLIER_ROWS_MAX = 20_000;
export async function loadExpenseSuppliers(): Promise<{ rows: unknown[]; truncated: boolean }> {
  try {
    const { data, error, truncated } = await pageAll((from, to) => supabase().from('expenses').select('supplier_name, supplier_dealer')
      .order('created_at', { ascending: false }).order('id').range(from, to), SUPPLIER_ROWS_MAX);
    return error ? { rows: [], truncated: false } : { rows: data, truncated };
  } catch { return { rows: [], truncated: false }; }
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
export async function saveOpening(lines: OpeningLine[], chart: ChartAccount[]): Promise<Res<{ number: number; opening: number }>> {
  try {
    const { data, error } = await supabase().rpc('gl_opening_balances', { p_lines: openingArgs(lines, chart) });
    // a database before 7300 reads no "account" in a supplier's line — said as "not possible yet", never as a missing account
    if (error && openingSupplierRefused(`${error.message ?? ''} ${error.code ?? ''}`, lines)) return { ok: false, error: OPENING_SUPPLIER_NOT_YET };
    if (error || data == null) return { ok: false, error: financeError(error) };
    return { ok: true, data: { number: Number((data as any)?.number ?? 0), opening: Number((data as any)?.opening ?? 0) } };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}

/** the owner turns the books' screens on / off (migration 7300 — gl_books_screens_set; the database checks the owner) */
export async function setBooksScreens(on: boolean): Promise<Res<true>> {
  const r = await rpc('gl_books_screens_set', { p_on: on }, () => true as const);
  if (r.ok) booksAreaChanged();
  return r;
}
/** every open useBooksArea reads the state again (the menu, the search, the settings card) */
const AREA_EVENT = 'dp:books-area';
export const booksAreaChanged = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(AREA_EVENT)); };
/** the books' state for the area (7200 there, the person in the business): null while asking / before 7200 / not readable.
 *  `enabled` false — not asked at all (a cashier, a calendar member) */
export function useBooksArea(enabled = true): { asked: boolean; state: BooksState | null; reload: () => void } {
  const [s, setS] = useState<{ asked: boolean; state: BooksState | null }>({ asked: false, state: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((x) => x + 1);
    window.addEventListener(AREA_EVENT, on);
    return () => window.removeEventListener(AREA_EVENT, on);
  }, []);
  useEffect(() => {
    let alive = true;
    if (!enabled) { setS({ asked: true, state: null }); return () => { alive = false; }; }
    void loadBooksMoreState().then((st) => { if (alive) setS({ asked: true, state: st }); }, () => alive && setS({ asked: true, state: null }));
    return () => { alive = false; };
  }, [n, enabled]);
  return { ...s, reload: booksAreaChanged };
}
