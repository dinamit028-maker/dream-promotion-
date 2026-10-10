import { supabase } from '@/lib/supabase/client';
import { LINE_COLUMNS, planErrorHe, toLine, toPlan, type Line, type Plan, type PlanItem } from './plans';
import { REMINDER_COLUMNS, reminderErrorHe, toReminder, toSettings, type Channel, type Reminder, type ReminderSettings } from './reminders';

/**
 * The screens' reads and calls of payment plans and debt reminders (migration 20261010004400). Everything is checked again by
 * the database: the plans and the reminders' functions (finance_guard + can_write; turning reminders on — the owner's),
 * and row-level security on every read (never a cashier, never another business).
 * Until the migration is in the database these screens behave as before it (plansReady / remindersReady are false).
 */
let plansCache: boolean | null = null;
export async function plansReady(): Promise<boolean> {
  if (plansCache !== null) return plansCache;
  const { error } = await supabase().from('payment_plans').select('id').limit(1);
  plansCache = !error;
  return plansCache;
}
export const remindersReady = plansReady; // one migration: both or neither

export type Res<T> = { ok: true; data: T } | { ok: false; error: string };

/** the plan in force on an invoice (null: none) */
export async function loadPlan(documentId: string): Promise<Plan | null> {
  const sb = supabase();
  const { data, error } = await sb.from('payment_plans').select('*').eq('document_id', documentId).eq('status', 'active').maybeSingle();
  if (error || !data) return null;
  const { data: items } = await sb.from('payment_plan_items').select('plan_id, n, due_date, amount').eq('plan_id', (data as any).id).order('n');
  return toPlan(data, (items ?? []) as any[]);
}
/** what is owed, by date: one invoice, one customer, or all of them (the receivables screen) */
export async function loadLines(f: { documentId?: string; leadId?: string; documentIds?: string[]; openOnly?: boolean } = {}): Promise<Line[] | null> {
  let q = supabase().from('receivable_lines').select(LINE_COLUMNS).limit(2000);
  if (f.openOnly) q = q.gt('open_amount', 0);
  if (f.documentId) q = q.eq('document_id', f.documentId);
  if (f.leadId) q = q.eq('lead_id', f.leadId);
  if (f.documentIds) q = q.in('document_id', f.documentIds.length ? f.documentIds : ['00000000-0000-0000-0000-000000000000']);
  const { data, error } = await q;
  return error ? null : ((data ?? []) as any[]).map(toLine);
}
/** a plan: the id is fixed by the dialog, so a retry of the same press is the same plan */
export async function createPlan(id: string, documentId: string, items: PlanItem[], note: string, replace: boolean): Promise<Res<{ again: boolean }>> {
  const { data, error } = await supabase().rpc('payment_plan_create', {
    p_id: id, p_document: documentId, p_items: items.map((i) => ({ amount: i.amount, due: i.dueDate })), p_note: note.trim().slice(0, 300), p_replace: replace,
  });
  if (error) return { ok: false, error: planErrorHe(error) };
  return { ok: true, data: { again: (data as any)?.result === 'already' } };
}
export async function cancelPlan(planId: string, reason: string): Promise<Res<null>> {
  const { error } = await supabase().rpc('payment_plan_cancel', { p_plan: planId, p_reason: reason.trim().slice(0, 300) });
  return error ? { ok: false, error: planErrorHe(error) } : { ok: true, data: null };
}

// ---- reminders ----------------------------------------------------------------------------------------------------------------
export async function loadReminderSettings(): Promise<ReminderSettings> {
  const { data } = await supabase().from('debt_reminder_settings').select('*').maybeSingle();
  return toSettings(data);
}
/** may this user turn reminders on? The business's owner (with full access) only — the database checks it again */
export async function isBusinessOwner(userId: string, businessId: string | null): Promise<boolean> {
  if (!businessId) return false;
  const { data } = await supabase().from('business_members').select('role, access').eq('user_id', userId).eq('business_id', businessId).maybeSingle();
  return (data as any)?.role === 'owner' && (data as any)?.access === 'full';
}
export async function configureReminders(enabled: boolean, days: number[], channel: Channel): Promise<Res<ReminderSettings>> {
  const { data, error } = await supabase().rpc('debt_reminders_configure', { p_enabled: enabled, p_days: days, p_channel: channel });
  return error ? { ok: false, error: reminderErrorHe(error) } : { ok: true, data: toSettings(data) };
}
export async function previewReminders(days: number[], channel: Channel): Promise<{ email: number; whatsapp: number } | null> {
  const { data, error } = await supabase().rpc('debt_reminders_preview', { p_days: days, p_channel: channel });
  return error || !data ? null : { email: Number((data as any).email ?? 0), whatsapp: Number((data as any).whatsapp ?? 0) };
}
/** the WhatsApp queue: what waits, with the line it is about as it is now (null: paid or changed meanwhile) */
export interface QueuedReminder { reminder: Reminder; line: Line | null }
export async function loadQueue(): Promise<QueuedReminder[] | null> {
  const { data, error } = await supabase().from('debt_reminders').select(REMINDER_COLUMNS).eq('status', 'queued').eq('channel', 'whatsapp')
    .order('created_at').limit(100);
  if (error) return null;
  const list = ((data ?? []) as any[]).map(toReminder);
  if (!list.length) return [];
  const lines = await loadLines({ documentIds: [...new Set(list.map((q) => q.documentId))] }) ?? [];
  return list.map((reminder) => ({
    reminder,
    line: lines.find((l) => l.documentId === reminder.documentId && (reminder.itemId ? l.itemId === reminder.itemId : !l.itemId && !l.planId)) ?? null,
  }));
}
/** "שליחה": asked again in the database first (paid meanwhile → not sent); sent → the values of the text, as they are now */
export async function sendQueued(id: string): Promise<Res<{ result: string; state: any }>> {
  const { data, error } = await supabase().rpc('debt_reminder_whatsapp', { p_id: id });
  if (error) return { ok: false, error: reminderErrorHe(error) };
  return { ok: true, data: { result: String((data as any)?.result ?? ''), state: data } };
}
export async function skipQueued(id: string): Promise<Res<boolean>> {
  const { data, error } = await supabase().rpc('debt_reminder_skip', { p_id: id });
  return error ? { ok: false, error: reminderErrorHe(error) } : { ok: true, data: Boolean(data) };
}
/** "לא לשלוח" on a customer (or lifting it) */
export async function stopReminders(leadId: string, stop: boolean): Promise<Res<boolean>> {
  const { data, error } = await supabase().rpc('debt_reminders_stop', { p_lead: leadId, p_stop: stop });
  return error ? { ok: false, error: reminderErrorHe(error) } : { ok: true, data: Boolean(data) };
}
export async function remindersStopped(leadId: string): Promise<boolean | null> {
  const { data, error } = await supabase().from('debt_reminder_stops').select('id').eq('lead_id', leadId).is('lifted_at', null).limit(1);
  return error ? null : (data ?? []).length > 0;
}
/** the reminders of one invoice, newest first */
export async function documentReminders(documentId: string): Promise<Reminder[]> {
  const { data } = await supabase().from('debt_reminders').select(REMINDER_COLUMNS).eq('document_id', documentId).order('created_at', { ascending: false }).limit(30);
  return ((data ?? []) as any[]).map(toReminder);
}
