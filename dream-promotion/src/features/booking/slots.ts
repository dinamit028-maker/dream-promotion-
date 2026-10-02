import { israelParts, israelToIso } from '@/lib/il-time';

/**
 * Free appointment times for one day — pure logic, shared by the public booking page, the owner's
 * "new appointment" form and the server that validates every booking (tests/booking.test.ts).
 * All times are Israel time; DST is handled by israelToIso.
 */
export type Hours = Record<string, [string, string][]>; // "0" = Sunday … "6" = Saturday
export interface SlotRules {
  hours: Hours; slotMinutes: number; minNoticeMinutes: number; maxDaysAhead: number; closedDates: string[];
}
export interface Busy { start: string; end: string } // ISO

const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + (m || 0); };
const toHm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Weekday (0 = Sunday) of a calendar date, independent of the device's time zone. */
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export function freeSlots(date: string, durationMin: number, rules: SlotRules, busy: Busy[], now = Date.now()): { time: string; start: string; end: string }[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || durationMin <= 0) return [];
  if (rules.closedDates.includes(date)) return [];
  const todayIL = israelParts(now).date;
  if (date < todayIL) return [];
  const last = israelParts(now + rules.maxDaysAhead * 864e5).date;
  if (date > last) return [];

  const ranges = rules.hours[String(weekdayOf(date))] ?? [];
  const earliest = now + rules.minNoticeMinutes * 60_000;
  const taken = busy.map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()] as const);
  const out: { time: string; start: string; end: string }[] = [];

  for (const [from, to] of ranges) {
    const a = toMin(from), z = toMin(to);
    for (let m = a; m + durationMin <= z; m += rules.slotMinutes) {
      const start = israelToIso(date, toHm(m));
      const end = new Date(new Date(start).getTime() + durationMin * 60_000).toISOString();
      const s = new Date(start).getTime(), e = new Date(end).getTime();
      if (s < earliest) continue;
      if (taken.some(([bs, be]) => s < be && e > bs)) continue; // overlaps an active appointment
      out.push({ time: toHm(m), start, end });
    }
  }
  return out;
}

/** Is this exact start time bookable? (the server re-checks every booking with this) */
export function isFree(startIso: string, durationMin: number, rules: SlotRules, busy: Busy[], now = Date.now()) {
  const day = israelParts(new Date(startIso)).date;
  return freeSlots(day, durationMin, rules, busy, now).some((s) => s.start === new Date(startIso).toISOString());
}

/** The next N days that have any opening hours (for the date picker). */
export function openDays(rules: SlotRules, now = Date.now(), limit = rules.maxDaysAhead) {
  const out: string[] = [];
  for (let k = 0; k <= limit && out.length < 60; k++) {
    const d = israelParts(now + k * 864e5).date;
    if (!rules.closedDates.includes(d) && (rules.hours[String(weekdayOf(d))] ?? []).length) out.push(d);
  }
  return out;
}

/** "Hello Dana, a reminder: …" — a WhatsApp-ready reminder text. */
export const reminderText = (p: { name: string; service: string; whenHe: string; business: string; address?: string }) =>
  `היי ${p.name.split(' ')[0]}, תזכורת לתור שלך ל${p.service} ${p.whenHe} ב${p.business}.${p.address ? ` הכתובת: ${p.address}.` : ''} נתראה! אם צריך לשנות — פשוט תענו להודעה הזו.`;

/** A calendar file (.ics) for the customer's own calendar. */
export function icsFile(p: { uid: string; start: string; end: string; title: string; location?: string }) {
  const f = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dream Promotion//Booking//HE', 'BEGIN:VEVENT',
    `UID:${p.uid}@dream-promotion`, `DTSTAMP:${f(new Date().toISOString())}`, `DTSTART:${f(p.start)}`, `DTEND:${f(p.end)}`,
    `SUMMARY:${p.title.replace(/[\n,;]/g, ' ')}`, ...(p.location ? [`LOCATION:${p.location.replace(/[\n,;]/g, ' ')}`] : []),
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
