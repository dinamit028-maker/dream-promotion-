import { adminDb } from './admin';
import { businessOpen } from './business';
import type { Busy, SlotRules } from '@/features/booking/slots';
import { phoneDigits } from '@/features/crm/crm';

/** Server side of the public booking page — only what a customer may see, nothing private.
 *  null = no such page; 'locked' = the business is locked (the page says the service is unavailable). */
export async function loadBusiness(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(slug)) return null;
  const db = adminDb();
  const { data: s } = await db.from('booking_settings').select('*').eq('slug', slug).eq('enabled', true).maybeSingle();
  if (!s) return null;
  if (!(await businessOpen((s as any).business_id))) return 'locked' as const;
  const list = (cols: string) => db.from('booking_services').select(cols).eq('business_id', (s as any).business_id).eq('active', true).order('sort').order('created_at');
  // a service's deposit comes with migration 4300 — before it, the services read as they did
  let res = await list('id, name, minutes, price, deposit');
  if (res.error) res = await list('id, name, minutes, price');
  const services = ((res.data ?? []) as any[]).map((x) => ({ id: x.id as string, name: x.name as string, minutes: Number(x.minutes), price: x.price == null ? null : Number(x.price),
    deposit: x.deposit == null ? null : Number(x.deposit) }));
  return { settings: s as any, services };
}

/**
 * Does the business take a deposit by link now (migration 4300)? Its terminal is connected and checked ("בדיקת חיבור"), and a
 * live one only while the platform's switch of payment links is on. Before the migration: no.
 */
export async function depositsOpen(businessId: string): Promise<boolean> {
  const { data, error } = await adminDb().from('payment_accounts').select('mode, verified_at').eq('business_id', businessId).maybeSingle();
  if (error || !data || !(data as any).verified_at) return false;
  if ((data as any).mode !== 'live') return true;
  const live = await adminDb().rpc('payment_links_live');
  return live.data === true;
}

export const rulesOf = (s: any): SlotRules => ({
  hours: s.hours ?? {}, slotMinutes: s.slot_minutes ?? 30, minNoticeMinutes: s.min_notice_minutes ?? 120,
  maxDaysAhead: s.max_days_ahead ?? 30, closedDates: (s.closed_dates ?? []).map(String),
});

/** active appointments of a business between two moments (a day, with margin) */
export async function busyBetween(businessId: string, fromIso: string, toIso: string): Promise<Busy[]> {
  const { data } = await adminDb().from('appointments').select('start_at, end_at')
    .eq('business_id', businessId).in('status', ['booked', 'confirmed']).lt('start_at', toIso).gt('end_at', fromIso);
  return (data ?? []).map((r: any) => ({ start: r.start_at, end: r.end_at }));
}

/** The booking lands in the business's CRM: an existing contact (same phone) or a new one, plus a timeline entry.
 *  userId = the business owner (recorded as creator); businessId is explicit — never the owner's "current" business. */
export async function attachToCrm(userId: string, businessId: string, p: { name: string; phone: string; email: string; summary: string }) {
  const db = adminDb();
  const digits = phoneDigits(p.phone);
  const { data: leads } = await db.from('leads').select('id, phone, status').eq('business_id', businessId).limit(5000);
  let lead = (leads ?? []).find((l: any) => digits && phoneDigits(l.phone) === digits) as any;
  if (lead) {
    if (lead.status !== 'נסגר') await db.from('leads').update({ status: 'נקבע תור' }).eq('id', lead.id).eq('business_id', businessId);
  } else {
    const ins = await db.from('leads').insert({
      user_id: userId, business_id: businessId, name: p.name, phone: p.phone, source: 'הזמנת תור אונליין', status: 'נקבע תור',
      ...(p.email ? { email: p.email } : {}),
    }).select('id').single();
    lead = ins.data;
    if (!lead && ins.error && /email/.test(ins.error.message)) { // CRM migration not run yet
      lead = (await db.from('leads').insert({ user_id: userId, business_id: businessId, name: p.name, phone: p.phone, source: 'הזמנת תור אונליין', status: 'נקבע תור' }).select('id').single()).data;
    }
  }
  if (lead?.id) await db.from('lead_activities').insert({ user_id: userId, business_id: businessId, lead_id: lead.id, kind: 'meeting', body: p.summary }).then(() => {}, () => {});
  return lead?.id as string | undefined;
}
