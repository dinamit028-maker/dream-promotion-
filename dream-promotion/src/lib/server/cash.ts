import { adminDb } from './admin';
import { notifyManagers } from './notify';

/**
 * The cheques' reminder (2.95, migration 20261011005000 — docs/FINANCE_ADDITIONS_HE.md T9): a cheque in the drawer is reminded
 * once, the business's days before it is due (or once when it is already late and was never reminded) — a phone notification to
 * the managers. The database picks what is due and marks it in the same statement (cheque_reminders_claim: 08:00–20:00 Israel
 * time, not on Saturday, only a business whose desks are on), so two runs at once never remind twice.
 */
const ils = (n: number) => `₪${n.toLocaleString('he-IL', { maximumFractionDigits: 2 })}`;
const day = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().slice(0, 2).join('/') : d);

export interface ChequeAlert { business: string; count: number; total: number; firstDue: string; cheques: { number: string; amount: number; due: string; customer: string }[] }
/** the notification of a business's cheques: how many, how much, the first day — and to the cheques screen */
export function chequePush(a: ChequeAlert): { title: string; body: string; url: string; tag: string } {
  const one = a.cheques[0];
  const body = a.count === 1 && one
    ? `צ׳ק ${one.number || ''}${one.customer ? ` של ${one.customer}` : ''} · ${ils(one.amount)} · לפירעון ${day(one.due)} — להפקיד`
    : `${a.count} צ׳קים · ${ils(a.total)} · הראשון לפירעון ${day(a.firstDue)} — להפקיד`;
  return { title: 'צ׳קים לפירעון', body: body.replace(/\s+/g, ' ').trim(), url: '/finance/cash?tab=cheques', tag: `cheques:${a.business}` };
}

export async function chequeRemindersCron(): Promise<{ businesses: number; cheques: number; sent: number } | null> {
  const { data, error } = await adminDb().rpc('cheque_reminders_claim', { p_limit: 100 });
  if (error) {
    // before migration 5000 there is nothing to remind
    if (/cheque_reminders_claim|schema cache|does not exist|PGRST20[24]/i.test(error.message)) return null;
    throw new Error(error.message);
  }
  let sent = 0, cheques = 0;
  const list = (Array.isArray(data) ? data : []) as ChequeAlert[];
  for (const a of list) {
    cheques += Number(a.count) || 0;
    sent += (await notifyManagers(a.business, chequePush(a))).sent;
  }
  return { businesses: list.length, cheques, sent };
}
