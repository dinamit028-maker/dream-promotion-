'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { financeError } from './rows';
import { toChequeBook, toDeposits, toDesks, type ChequeBook, type Deposit, type Desks } from './desks';
import { toBankBook, toCandidates, type BankLine, type BankLineIn, type DepositCard, type PayCard, type Statement } from './bank';

/**
 * The desks', deposits' and bank's way to the database (2.95, migration 20261011005000). The reads run as the signed-in user (the
 * location picked at the top too; the bank only for a member who sees every location); every write is one function of the
 * database, which keeps the rules. Until the migration is in the database nothing of it is offered (cashReady is false): the
 * switches in the settings stay hidden, and every screen behaves as before.
 */
let ready: Promise<boolean> | null = null;
/** is migration 5000 in this database? (asked once a page: one of its columns answers) */
export function cashReady(): Promise<boolean> {
  ready ??= Promise.resolve(supabase().from('business_finance_profile').select('cash_drawers').limit(1)).then(({ error }) => !error, () => false);
  return ready;
}
export function useCashReady(): boolean { return useCashReadyState() === true; }
/** null while asking (a screen shows its spinner), then whether the migration is there */
export function useCashReadyState(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => { let alive = true; void cashReady().then((v) => { if (alive) setOk(v); }); return () => { alive = false; }; }, []);
  return ok;
}
export const CASH_MIGRATION = 'צריך להריץ את מיגרציה 20261011005000 (קופות, הפקדות, בנק, הזמנה ותעודת משלוח) ב-Supabase לפני שהמסך הזה עובד.';

export type Res<T> = { ok: true; data: T } | { ok: false; error: string };
async function call<T>(fn: string, args: Record<string, unknown>, parse: (j: any) => T): Promise<Res<T>> {
  try {
    const { data, error } = await supabase().rpc(fn, args);
    if (error || data == null) return { ok: false, error: financeError(error) };
    return { ok: true, data: parse(data) };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}
type Period = { from: string; to: string };
const range = (p: Period) => ({ p_from: p.from, p_to: p.to });

export const loadDesks = (p: Period): Promise<Res<Desks>> => call('cash_desks', range(p), toDesks);
export const loadChequeBook = (p: Period): Promise<Res<ChequeBook>> => call('cheque_book', range(p), toChequeBook);
export const loadDeposits = (p: Period): Promise<Res<Deposit[]>> => call('deposit_book', range(p), toDeposits);
/** a new deposit: the id is this form's (a second tap is the same deposit) */
export const createDeposit = (o: { id: string; date: string; location: string | null; cash: number; cheques: string[]; note: string }) =>
  call('bank_deposit_create', { p_id: o.id, p_date: o.date, p_location: o.location, p_cash: Math.round(o.cash * 100) / 100, p_cheques: o.cheques, p_note: o.note.trim().slice(0, 300) },
    (j) => ({ id: String(j.id), number: Number(j.number), created: Boolean(j.created) }));
export const cancelDeposit = (id: string, reason: string) => call('bank_deposit_cancel', { p_id: id, p_reason: reason.trim() }, (j) => String(j.result ?? ''));

export const loadBankBook = (p: Period): Promise<Res<{ lines: BankLine[]; statements: Statement[] }>> => call('bank_book', range(p), toBankBook);
export const loadCandidates = (p: Period): Promise<Res<{ payments: PayCard[]; deposits: DepositCard[] }>> => call('bank_candidates', range(p), toCandidates);
/** a file of the bank: its lines, kept once each (the id is this upload's: a second tap is the same import) */
export const importBank = (o: { id: string; account: string; file: string; lines: BankLineIn[] }) =>
  call('bank_import', { p_id: o.id, p_account: o.account.trim().slice(0, 60), p_file: o.file.slice(0, 200), p_lines: o.lines },
    (j) => ({ total: Number(j.total), added: Number(j.added), created: Boolean(j.created) }));
export const matchLine = (line: string, payments: string[], deposits: string[]) =>
  call('bank_match', { p_line: line, p_payments: payments, p_deposits: deposits }, (j) => Number(j.items ?? 0));
export const unmatchLine = (line: string, reason: string) => call('bank_unmatch', { p_line: line, p_reason: reason.trim() }, (j) => Number(j.undone ?? 0));
export const handleLine = (line: string, note: string) => call('bank_line_handle', { p_line: line, p_note: note.trim() }, (j) => String(j.status ?? ''));
export const reopenLine = (line: string) => call('bank_line_reopen', { p_line: line }, (j) => String(j.status ?? ''));
