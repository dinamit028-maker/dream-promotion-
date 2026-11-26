'use client';
import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import { AWAITING_REMINDER, AWAITING_STAFF, CHECK_FAILED, isAwaiting, isMissing, toDelivery, toDeliveryState, type Delivery, type DeliveryState } from '@/features/finance/delivery';
import { allocationPrintLine } from '@/features/finance/allocation';

/**
 * 2.119 — the business hands a document to the customer from the app (the accountant's answers 1 and 6, migration 20261126006900).
 * Every way goes through the database first:
 *   - print / a PDF for the customer: document_delivery_record(doc, 'print' | 'pdf') — refused while the document waits for its
 *     allocation number; it answers whether this is the original ("מקור") or a true copy ("העתק נאמן למקור"). The original's PDF is
 *     kept on the server (/api/doc/delivery).
 *   - a WhatsApp message with the customer's link: document_delivery_state first (a waiting document is not sent); the message itself
 *     is not a delivery — opening the link is (the server records it, channel 'link').
 * The window opens on the tap itself (a phone blocks a window opened after waiting for the database), and closes when refused.
 * A database before that migration (no such functions): as before it.
 */
export type RecordResult = { ok: true; delivery: Delivery } | { ok: false; reason: 'awaiting' | 'missing' | 'error'; message: string };
export async function recordDelivery(documentId: string, channel: 'print' | 'pdf' | 'email' | 'whatsapp'): Promise<RecordResult> {
  const { data, error } = await supabase().rpc('document_delivery_record', { p_document: documentId, p_channel: channel });
  if (error) {
    if (isMissing(error)) return { ok: false, reason: 'missing', message: '' };
    if (isAwaiting(error)) return { ok: false, reason: 'awaiting', message: AWAITING_STAFF };
    return { ok: false, reason: 'error', message: error.code === '42501' ? 'אין לך הרשאה למסור את המסמך הזה ללקוח.' : 'המסירה לא נרשמה. נסו שוב.' };
  }
  const delivery = toDelivery(data);
  return delivery ? { ok: true, delivery } : { ok: false, reason: 'error', message: 'המסירה לא נרשמה. נסו שוב.' };
}

export type StateResult = { ok: true; state: DeliveryState } | { ok: false; missing: boolean; message: string };
export async function deliveryState(documentId: string): Promise<StateResult> {
  const { data, error } = await supabase().rpc('document_delivery_state', { p_document: documentId });
  if (error) return { ok: false, missing: isMissing(error), message: 'לא הצלחנו לבדוק את המסמך. נסו שוב.' };
  const state = toDeliveryState(data);
  return state ? { ok: true, state } : { ok: false, missing: false, message: 'לא הצלחנו לבדוק את המסמך. נסו שוב.' };
}

/**
 * which of these documents wait for their allocation number (the view document_allocation_status — the database's rule; the caller's
 * RLS). Before migration 20261126006900 (no view) — none. Any other error: ok false — the caller keeps the action closed (fail closed).
 */
export type AwaitingResult = { ok: true; ids: Set<string> } | { ok: false };
export async function awaitingIds(ids: string[]): Promise<AwaitingResult> {
  const out = new Set<string>();
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await supabase().from('document_allocation_status').select('document_id').eq('awaiting', true).in('document_id', list.slice(i, i + 100));
    if (error) return isMissing(error) ? { ok: true, ids: new Set() } : { ok: false };
    for (const r of (data ?? []) as { document_id: string }[]) out.add(r.document_id);
  }
  return { ok: true, ids: out };
}
/** may a reminder of this document go: null — yes; otherwise the words why not (waiting for its number, or the check failed) */
export const reminderBlock = (a: AwaitingResult, documentId: string): string | null => (!a.ok ? CHECK_FAILED : a.ids.has(documentId) ? AWAITING_REMINDER : null);

/** the allocation-number line of a delivered document, from the database's state (a real number only — a test one never) */
export const stateAllocationLine = (s: DeliveryState | null) =>
  s?.allocation.number ? allocationPrintLine({ kind: 'real', number: s.allocation.number, manual: s.allocation.manual }) : null;

/** the original's PDF is kept on the server (a print: nothing comes back). Never in the person's way — a failure is only logged there. */
export function keepOriginal(d: Delivery) {
  if (!d.original) return;
  void (async () => {
    try {
      await fetch('/api/doc/delivery', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ deliveryId: d.deliveryId, want: 'keep' }), keepalive: true });
    } catch { /* the server logs what it could not keep */ }
  })();
}

const go = (w: Window | null, url: string) => {
  if (w && !w.closed) { try { w.opener = null; } catch { /* some browsers refuse; harmless */ } w.location.href = url; return; }
  window.open(url, '_blank', 'noopener');
};

/**
 * "📄 PDF" of a document, for the customer: recorded as a delivery ('pdf'), then the file with its mark. Returns an error to show,
 * or null. Before migration 20261126006900 — the customer's link's PDF, as before.
 */
export async function staffPdf(doc: { id: string; shareToken?: string | null }): Promise<string | null> {
  const w = window.open('', '_blank');
  const r = await recordDelivery(doc.id, 'pdf');
  if (!r.ok && r.reason === 'missing') {
    if (!doc.shareToken) { w?.close(); return 'אין קובץ למסמך הזה.'; }
    go(w, `/api/doc/${doc.shareToken}/pdf`);
    return null;
  }
  if (!r.ok) { w?.close(); return r.message; }
  try {
    const res = await fetch('/api/doc/delivery', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ deliveryId: r.delivery.deliveryId, want: 'pdf' }) });
    if (!res.ok) { w?.close(); return 'ה-PDF לא נוצר. נסו שוב (הניסיון הבא יסומן "העתק נאמן למקור").'; }
    const url = URL.createObjectURL(await res.blob());
    go(w, url);
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    return null;
  } catch {
    w?.close();
    return 'אין חיבור כרגע. נסו שוב.';
  }
}

/**
 * A message with the customer's link (WhatsApp): not sent while the document waits for its allocation number. Returns an error to
 * show, or null. `link` is the full wa.me address (with the text).
 */
export async function sendDocLink(documentId: string, link: string): Promise<string | null> {
  const w = window.open('', '_blank');
  const s = await deliveryState(documentId);
  if (s.ok && s.state.allocation.awaiting) { w?.close(); return AWAITING_STAFF; }
  if (!s.ok && !s.missing) { w?.close(); return s.message; }
  go(w, link);
  return null;
}
/** the same check, without a window (the link is copied instead): an error to show, or null */
export async function linkMayGo(documentId: string): Promise<string | null> {
  const s = await deliveryState(documentId);
  if (s.ok && s.state.allocation.awaiting) return AWAITING_STAFF;
  return !s.ok && !s.missing ? s.message : null;
}
