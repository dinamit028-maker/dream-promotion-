'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import { financeError } from './rows';
import {
  pdfBody, reportFileName, toCustomerLedger, toIncomeByCustomer, toSalesByItem, toSupplierLedger, toSupplierReport, toWithholding, type CustomerLedger,
  type IncomeByCustomer, type ReportTable, type SalesByItem, type SupplierLedger, type SupplierReport, type WithholdingReport,
} from './statements';

/**
 * The reports' way to the database (2.94, migration 20261011004900): report_* run as the signed-in user — the business's policies
 * decide what they read (the location picked at the top too), and a cashier gets nothing. Until the migration is in the
 * database the new reports, tax withheld at source on a receipt, the advances' percent and a service's treatment type are not
 * offered (reportsReady is false) and every screen behaves as before.
 */
let ready: Promise<boolean> | null = null;
/** is migration 4900 in this database? (asked once a page: one of its columns answers) */
export function reportsReady(): Promise<boolean> {
  ready ??= Promise.resolve(supabase().from('catalog_items').select('treatment_type_id').limit(1)).then(({ error }) => !error, () => false);
  return ready;
}
export function useReportsReady(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => { let alive = true; void reportsReady().then((v) => { if (alive) setOk(v); }); return () => { alive = false; }; }, []);
  return ok;
}

export type Res<T> = { ok: true; data: T } | { ok: false; error: string };
type Period = { from: string; to: string };
async function call<T>(fn: string, args: Record<string, unknown>, parse: (j: any) => T): Promise<Res<T>> {
  try {
    const { data, error } = await supabase().rpc(fn, args);
    if (error || data == null) return { ok: false, error: financeError(error) };
    return { ok: true, data: parse(data) };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}
const range = (p: Period) => ({ p_from: p.from, p_to: p.to });
export const loadIncomeByCustomer = (p: Period): Promise<Res<IncomeByCustomer>> => call('report_income_by_customer', range(p), toIncomeByCustomer);
export const loadSalesByItem = (p: Period): Promise<Res<SalesByItem>> => call('report_sales_by_item', range(p), toSalesByItem);
export const loadCustomerLedger = (key: string, p: Period): Promise<Res<CustomerLedger>> => call('report_customer_ledger', { p_key: key, ...range(p) }, toCustomerLedger);
export const loadSuppliers = (p: Period): Promise<Res<SupplierReport>> => call('report_suppliers', range(p), toSupplierReport);
export const loadSupplierLedger = (key: string, p: Period): Promise<Res<SupplierLedger>> => call('report_supplier_ledger', { p_key: key, ...range(p) }, toSupplierLedger);
export const loadWithholding = (p: Period): Promise<Res<WithholdingReport>> => call('report_withholding', range(p), toWithholding);

/** the customers to pick a card of: the CRM's cards (by name) — a customer by dealer number or by name comes from the income report */
export async function loadLeadsForLedger(): Promise<{ key: string; name: string; phone: string }[]> {
  const { data, error } = await supabase().from('leads').select('id, name, phone').order('name').limit(2000);
  return error ? [] : ((data ?? []) as any[]).map((l) => ({ key: `l:${l.id}`, name: String(l.name ?? ''), phone: String(l.phone ?? '') }));
}

/** a report as a PDF: the server draws the table (the business's name and number from the database), the browser saves it */
export async function downloadReportPdf(t: ReportTable, subtitle: string, p: Period): Promise<string | null> {
  try {
    const r = await fetch('/api/finance/report-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(pdfBody(t, subtitle)) });
    if (!r.ok) { const j = await r.json().catch(() => null); return j?.message ?? 'ה-PDF לא נוצר. נסו שוב.'; }
    const blob = await r.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = reportFileName(t.title, p, 'pdf'); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return null;
  } catch { return 'אין חיבור כרגע — ה-PDF לא נוצר.'; }
}
