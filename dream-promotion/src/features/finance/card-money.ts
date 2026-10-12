import { DOC_LABEL } from '@/features/documents/documents';
import { lineLabel, type Line } from './plans';
import type { QuoteStatus } from './quotes';
import type { Receivable } from './receivables';
import { ag } from './vat';

/**
 * The customer's money on their card ("💰 כספים", docs/FINANCE_ADDITIONS_HE.md T7; 2.97) — the pure rules the card shows by:
 * what a payment link may be sent for, the open payments of their plans, and how their payments read. The card reads the same
 * rows as the money screens (receivables, receivable_lines, payments — row-level security decides), never numbers of its own.
 */

// ---- "💳 שליחת לינק לתשלום": what it may be for --------------------------------------------------------------------------------
/** an open invoice (what is left of it) or an accepted quote (its total) — the server checks the amount again, under a lock */
export interface LinkTarget {
  kind: 'document' | 'quote'; id: string; label: string; owed: number;
  customer: { name: string; phone: string; email: string };
}
export interface CardQuote { id: string; number: number; status: QuoteStatus; total: number; customerName?: string; customerPhone?: string; customerEmail?: string }
/** the customer's open invoices (not cancelled, something left), oldest date first, then the accepted quotes */
export function linkTargets(recv: Receivable[], quotes: CardQuote[]): LinkTarget[] {
  const docs = recv.filter((r) => !r.cancelled && ag(r.balance) > 0)
    .sort((a, b) => (a.dueDate ?? a.docDate).localeCompare(b.dueDate ?? b.docDate) || a.docNumber - b.docNumber)
    .map((r): LinkTarget => ({ kind: 'document', id: r.id, label: `${DOC_LABEL[r.docType] ?? 'מסמך'} ${r.docNumber}`, owed: r.balance,
      customer: { name: r.customerName, phone: r.customerPhone, email: r.customerEmail } }));
  const qs = quotes.filter((q) => q.status === 'accepted' && ag(q.total) > 0)
    .map((q): LinkTarget => ({ kind: 'quote', id: q.id, label: `הצעת מחיר ${q.number}`, owed: q.total,
      customer: { name: q.customerName ?? '', phone: q.customerPhone ?? '', email: q.customerEmail ?? '' } }));
  return [...docs, ...qs];
}

// ---- "📅 פריסה לתשלומים": the open payments of the customer's plans ----------------------------------------------------------------
export interface PlanRow { key: string; documentId: string; label: string; dueDate: string | null; open: number; late: boolean }
/** a plan's payments still open (a line of an invoice without a plan is not one), by date — "חשבונית מס 12 · תשלום 2 מתוך 3" */
export function planRows(lines: Line[], today: string): PlanRow[] {
  return lines.filter((l) => l.planId && ag(l.open) > 0)
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.docNumber - b.docNumber || (a.n ?? 99) - (b.n ?? 99))
    .map((l) => ({
      key: `${l.documentId}:${l.itemId ?? 'x'}`, documentId: l.documentId,
      label: `${DOC_LABEL[l.docType] ?? 'מסמך'} ${l.docNumber}${lineLabel(l) ? ` · ${lineLabel(l)}` : ''}`,
      dueDate: l.dueDate, open: l.open, late: Boolean(l.dueDate && l.dueDate < today),
    }));
}
