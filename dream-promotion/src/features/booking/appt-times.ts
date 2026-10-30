import { israelToIso } from '@/lib/il-time';

/**
 * "משעה עד שעה" (2.110): the end of an appointment — by default its treatment's length, and anyone in the calendar may set
 * another one for this appointment only (the owner of the system, 30.10.2026). An appointment ends the same day, after it starts.
 * The database still refuses two appointments of one practitioner at once.
 */
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const toMinutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
export const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** the end by the treatment's length — never past 23:59 of the day */
export const defaultEnd = (start: string, minutes: number) => (HM.test(start) ? fromMinutes(Math.min(toMinutes(start) + minutes, 23 * 60 + 59)) : '');

/** what stops these hours, or null */
export function timesProblem(start: string, end: string): string | null {
  if (!HM.test(start)) return 'בחרו שעת התחלה.';
  if (!HM.test(end)) return 'בחרו עד איזו שעה.';
  if (toMinutes(end) <= toMinutes(start)) return 'שעת הסיום חייבת להיות אחרי שעת ההתחלה.';
  if (toMinutes(end) - toMinutes(start) < 5) return 'תור של 5 דקות לפחות.';
  return null;
}

/** the appointment's start and end, in Israel time, for the database */
export function apptRange(day: string, start: string, end: string): { start: string; end: string } {
  return { start: israelToIso(day, start), end: israelToIso(day, end) };
}

/** a treatment's default length: 5 minutes to 8 hours (booking_services_minutes_check) */
export const lengthProblem = (m: number) => (!Number.isInteger(m) || m < 5 || m > 480 ? 'משך של 5 עד 480 דקות.' : null);

/** 2.110: "how long" — tapped, the end moves to the start plus it (11:00 + שעה וחצי → 12:30) */
export const DURATIONS = [15, 30, 40, 45, 60, 75, 90, 120, 150, 180] as const;
export function durationLabel(m: number): string {
  if (m <= 0) return '';
  const h = Math.floor(m / 60), r = m % 60;
  const hours = h === 0 ? '' : h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`;
  if (!r) return hours;
  if (!h) return r === 30 ? 'חצי שעה' : r === 15 ? 'רבע שעה' : `${r} דק׳`;
  return r === 30 ? `${hours} וחצי` : r === 15 ? `${hours} ורבע` : r === 45 ? `${hours} ו-45 דק׳` : `${hours} ו-${r} דק׳`;
}
/** the length between two hours of a day, in minutes (0 when not a range) */
export const lengthOf = (start: string, end: string) => (timesProblem(start, end) ? 0 : toMinutes(end) - toMinutes(start));
