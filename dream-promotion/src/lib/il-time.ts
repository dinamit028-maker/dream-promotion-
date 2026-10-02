/**
 * Israel time, whatever the device clock says. Scheduling is entered as a date + time in Israel;
 * a browser set to another time zone (travel, a laptop on UTC) must not move the publication.
 * Handles summer / winter time (DST) by asking Intl for the real offset at that moment.
 */
export const IL_TZ = 'Asia/Jerusalem';

function offsetMinutes(utcMs: number, tz = IL_TZ): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - Math.floor(utcMs / 60000) * 60000) / 60000;
}

/** "2026-10-06" + "19:30" in Israel → the exact UTC moment (ISO). */
export function israelToIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall - offsetMinutes(wall) * 60000;
  t = wall - offsetMinutes(t) * 60000; // second pass settles the DST edge
  return new Date(t).toISOString();
}

/** A moment → its Israeli calendar date, time and weekday (0 = Sunday). */
export function israelParts(at: Date | number): { date: string; time: string; weekday: number } {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: IL_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(at));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return {
    date: `${g('year')}-${g('month')}-${g('day')}`,
    time: `${String(Number(g('hour')) % 24).padStart(2, '0')}:${g('minute')}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')),
  };
}

/** Shown to the user in Israel time. */
export const formatIL = (at: string | Date, opts: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' }) =>
  new Date(at).toLocaleString('he-IL', { ...opts, timeZone: IL_TZ });
