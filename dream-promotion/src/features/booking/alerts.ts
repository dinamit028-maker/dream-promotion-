import { israelParts, israelToIso } from '@/lib/il-time';
import { addDays } from './calendar';

/**
 * Phone notifications of the calendar (2.112, migration 20261031006300). The owner of the system (31.10.2026):
 *   soon     — 15 minutes before an appointment: to its practitioner (her account) and the business's owners;
 *   tomorrow — at 10:00 the day before (until 20:00, if the timer missed it): "מחר X תורים — לשלוח תזכורות", to the same people,
 *              opening the list of tomorrow's customers, each with a WhatsApp message sent from their own WhatsApp.
 * Who and what — only here (the server's timer, appointment-alerts.ts, only sends); each one once (appointment_alerts).
 */
export const SOON_MINUTES = 15;
export const TOMORROW_FROM = '10:00';
export const TOMORROW_UNTIL = '20:00';

export type AlertAppt = { id: string; businessId: string; start: string; name: string; service: string; staffId: string | null; status: string };
export type Alert = { businessId: string; userId: string; key: string; title: string; body: string; url: string; tag: string };

const live = (a: AlertAppt) => a.status === 'booked' || a.status === 'confirmed';
const hm = (iso: string) => israelParts(new Date(iso)).time;

/** the people of an appointment: its practitioner's account, then the owners — each once */
export function peopleOf(a: AlertAppt, staffUser: Map<string, string | null>, owners: Map<string, string[]>): string[] {
  const own = a.staffId ? staffUser.get(a.staffId) ?? null : null;
  return [...new Set([...(own ? [own] : []), ...(owners.get(a.businessId) ?? [])])];
}

/** appointments starting within the next 15 minutes (not ones that started) */
export function soonDue(appts: AlertAppt[], now: number): AlertAppt[] {
  return appts.filter((a) => live(a) && new Date(a.start).getTime() > now && new Date(a.start).getTime() <= now + SOON_MINUTES * 60_000);
}

export function soonAlerts(appts: AlertAppt[], now: number, staffUser: Map<string, string | null>, owners: Map<string, string[]>): Alert[] {
  return soonDue(appts, now).flatMap((a) => {
    const left = Math.max(1, Math.round((new Date(a.start).getTime() - now) / 60_000));
    const what = [a.name, a.service].filter(Boolean).join(' · ');
    return peopleOf(a, staffUser, owners).map((userId) => ({
      businessId: a.businessId, userId, key: `soon:${a.id}:${new Date(a.start).toISOString()}:${userId}`,  // 2.112.1: a moved appointment — again, at its new hour
      title: `תור ב-${hm(a.start)} — בעוד ${left} דק׳`, body: `${what} — להכין את הקליניקה`,
      url: `/appointments?appt=${a.id}`, tag: `appt-soon-${a.id}`,
    }));
  });
}

/** the day whose reminders are due now (Israel time, 10:00–20:00 of the day before), or null */
export function tomorrowDue(now: number): string | null {
  const p = israelParts(now);
  return p.time >= TOMORROW_FROM && p.time < TOMORROW_UNTIL ? addDays(p.date, 1) : null;
}
/** the range of a day in Israel time, for the database */
export const dayRange = (day: string) => ({ from: israelToIso(day, '00:00'), to: israelToIso(addDays(day, 1), '00:00') });

/** one notification per person and day: how many of tomorrow's appointments are theirs */
export function tomorrowAlerts(day: string, appts: AlertAppt[], staffUser: Map<string, string | null>, owners: Map<string, string[]>): Alert[] {
  const count = new Map<string, { businessId: string; n: number }>();
  for (const a of appts.filter(live)) {
    for (const userId of peopleOf(a, staffUser, owners)) {
      const k = `${a.businessId}|${userId}`;
      count.set(k, { businessId: a.businessId, n: (count.get(k)?.n ?? 0) + 1 });
    }
  }
  return [...count.entries()].map(([k, { businessId, n }]) => {
    const userId = k.split('|')[1];
    return {
      businessId, userId, key: `tomorrow:${day}:${userId}`,
      title: n === 1 ? 'מחר תור אחד — לשלוח תזכורת' : `מחר ${n} תורים — לשלוח תזכורות`,
      body: 'לחצו לרשימה: תזכורת בוואטסאפ לכל לקוח/ה בלחיצה.',
      url: `/appointments?reminders=${day}`, tag: `appt-tomorrow-${day}`,
    };
  });
}
