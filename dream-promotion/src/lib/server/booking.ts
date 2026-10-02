import { adminDb } from './admin';
import type { Busy, SlotRules } from '@/features/booking/slots';
import { phoneDigits } from '@/features/crm/crm';

/** Server side of the public booking page — only what a customer may see, nothing private. */
export async function loadBusiness(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(slug)) return null;
  const db = adminDb();
  const { data: s } = await db.from('booking_settings').select('*').eq('slug', slug).eq('enabled', true).maybeSingle();
  if (!s) return null;
  const { data: services } = await db.from('booking_services').select('id, name, minutes, price')
    .eq('user_id', s.user_id).eq('active', true).order('sort').order('created_at');
  return { settings: s as any, services: (services ?? []) as { id: string; name: string; minutes: number; price: number | null }[] };
}

export const rulesOf = (s: any): SlotRules => ({
  hours: s.hours ?? {}, slotMinutes: s.slot_minutes ?? 30, minNoticeMinutes: s.min_notice_minutes ?? 120,
  maxDaysAhead: s.max_days_ahead ?? 30, closedDates: (s.closed_dates ?? []).map(String),
});

/** active appointments between two moments (a day, with margin) */
export async function busyBetween(userId: string, fromIso: string, toIso: string): Promise<Busy[]> {
  const { data } = await adminDb().from('appointments').select('start_at, end_at')
    .eq('user_id', userId).in('status', ['booked', 'confirmed']).lt('start_at', toIso).gt('end_at', fromIso);
  return (data ?? []).map((r: any) => ({ start: r.start_at, end: r.end_at }));
}

/** The booking lands in the CRM: an existing contact (same phone) or a new one, plus a timeline entry. */
export async function attachToCrm(userId: string, p: { name: string; phone: string; email: string; summary: string }) {
  const db = adminDb();
  const digits = phoneDigits(p.phone);
  const { data: leads } = await db.from('leads').select('id, phone, status').eq('user_id', userId).limit(5000);
  let lead = (leads ?? []).find((l: any) => digits && phoneDigits(l.phone) === digits) as any;
  if (lead) {
    if (lead.status !== 'נסגר') await db.from('leads').update({ status: 'נקבע תור' }).eq('id', lead.id).eq('user_id', userId);
  } else {
    const ins = await db.from('leads').insert({
      user_id: userId, name: p.name, phone: p.phone, source: 'הזמנת תור אונליין', status: 'נקבע תור',
      ...(p.email ? { email: p.email } : {}),
    }).select('id').single();
    lead = ins.data;
    if (!lead && ins.error && /email/.test(ins.error.message)) { // CRM migration not run yet
      lead = (await db.from('leads').insert({ user_id: userId, name: p.name, phone: p.phone, source: 'הזמנת תור אונליין', status: 'נקבע תור' }).select('id').single()).data;
    }
  }
  if (lead?.id) await db.from('lead_activities').insert({ user_id: userId, lead_id: lead.id, kind: 'meeting', body: p.summary }).then(() => {}, () => {});
  return lead?.id as string | undefined;
}
