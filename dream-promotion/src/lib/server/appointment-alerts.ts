import { adminDb } from './admin';
import { pushToUser } from './push';
import { dayRange, soonAlerts, tomorrowAlerts, tomorrowDue, SOON_MINUTES, type Alert, type AlertAppt } from '@/features/booking/alerts';

/**
 * The calendar's phone notifications (2.112, migration 20261031006300) — from the timer (/api/cron/commerce, every 2 minutes).
 * Who and what: features/booking/alerts.ts. Each notification is claimed once (appointment_alerts, unique per business) before
 * it is sent: a timer that runs twice, or two at once, never sends it twice. Before the migration: nothing (null).
 */
const missing = (m: string) => /appointment_alerts|schema cache|does not exist|PGRST20[45]/i.test(m);

type Row = { id: string; business_id: string; start_at: string; name: string; service_name: string | null; staff_id: string | null; status: string };
const toAppt = (r: Row): AlertAppt => ({ id: r.id, businessId: r.business_id, start: r.start_at, name: r.name, service: r.service_name ?? '', staffId: r.staff_id, status: r.status });

async function context(appts: AlertAppt[]) {
  const db = adminDb();
  const businesses = [...new Set(appts.map((a) => a.businessId))];
  const staffIds = [...new Set(appts.map((a) => a.staffId).filter(Boolean))] as string[];
  const [{ data: members }, { data: staff }] = await Promise.all([
    db.from('business_members').select('business_id, user_id, role, access').in('business_id', businesses),
    staffIds.length ? db.from('lead_staff').select('id, member_user_id').in('id', staffIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  const owners = new Map<string, string[]>();
  for (const m of (members ?? []) as { business_id: string; user_id: string; role: string; access?: string }[]) {
    if (m.role === 'owner' && (m.access ?? 'full') === 'full') owners.set(m.business_id, [...(owners.get(m.business_id) ?? []), m.user_id]);
  }
  const staffUser = new Map<string, string | null>(((staff ?? []) as { id: string; member_user_id: string | null }[]).map((s) => [s.id, s.member_user_id]));
  return { owners, staffUser };
}

/** claim, then send; a claimed one that reached no device stays claimed (the person turned notifications on later) */
async function send(list: Alert[]): Promise<{ claimed: number; sent: number }> {
  const db = adminDb();
  let claimed = 0, sent = 0;
  for (const a of list) {
    const { data, error } = await db.from('appointment_alerts').insert({ business_id: a.businessId, dedupe_key: a.key, user_id: a.userId }).select('id').maybeSingle();
    if (error) { if (error.code === '23505' || /duplicate/i.test(error.message)) continue; if (missing(error.message)) return { claimed, sent }; throw new Error(error.message); }
    claimed++;
    const r = await pushToUser(a.userId, { title: a.title, body: a.body, url: a.url, tag: a.tag });
    sent += r.sent;
    if (r.sent && data?.id) await db.from('appointment_alerts').update({ devices: r.sent }).eq('id', data.id);
  }
  return { claimed, sent };
}

export async function appointmentAlertsCron(now = Date.now()): Promise<{ soon: number; tomorrow: number; sent: number } | null> {
  const db = adminDb();
  const probe = await db.from('appointment_alerts').select('id').limit(1);
  if (probe.error) { if (missing(probe.error.message)) return null; throw new Error(probe.error.message); }
  const cols = 'id, business_id, start_at, name, service_name, staff_id, status';
  // soon: what starts within the next 15 minutes
  const { data: near, error } = await db.from('appointments').select(cols).in('status', ['booked', 'confirmed'])
    .gt('start_at', new Date(now).toISOString()).lte('start_at', new Date(now + SOON_MINUTES * 60_000).toISOString());
  if (error) throw new Error(error.message);
  let alerts: Alert[] = [];
  const soonList = ((near ?? []) as Row[]).map(toAppt);
  if (soonList.length) { const c = await context(soonList); alerts = soonAlerts(soonList, now, c.staffUser, c.owners); }
  const soon = alerts.length;
  // the day before, from 10:00
  const day = tomorrowDue(now);
  let tomorrow = 0;
  if (day) {
    const { from, to } = dayRange(day);
    const { data: next, error: e2 } = await db.from('appointments').select(cols).in('status', ['booked', 'confirmed']).gte('start_at', from).lt('start_at', to);
    if (e2) throw new Error(e2.message);
    const list = ((next ?? []) as Row[]).map(toAppt);
    if (list.length) { const c = await context(list); const t = tomorrowAlerts(day, list, c.staffUser, c.owners); tomorrow = t.length; alerts = [...alerts, ...t]; }
  }
  const r = await send(alerts);
  return { soon, tomorrow, sent: r.sent };
}
