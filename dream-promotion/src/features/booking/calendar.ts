import { formatIL, israelParts, israelToIso } from '@/lib/il-time';
import { weekdayOf, type Hours } from './slots';

/**
 * The appointments calendar (2.105, migration 5700): a practitioner's colour, the days a view shows, where an appointment sits on
 * its day, appointments at the same hour side by side (like Outlook), the month's grid and what the history says. Pure — no
 * database, no React (tests/booking-calendar.test.ts). Israel time throughout, whatever the device's clock (il-time.ts).
 */

// ---------------------------------------------------------------------------------------------------------------- colours --

/** the colours a practitioner may have — the same list as lead_staff_color_check in migration 20261018005700 (a test compares) */
export const CALENDAR_COLORS = [
  { key: 'pink', label: 'ורוד' }, { key: 'turquoise', label: 'טורקיז' }, { key: 'yellow', label: 'צהוב' },
  { key: 'violet', label: 'סגול' }, { key: 'orange', label: 'כתום' }, { key: 'blue', label: 'כחול' },
  { key: 'green', label: 'ירוק' }, { key: 'red', label: 'אדום' }, { key: 'gray', label: 'אפור' },
] as const;
export type CalendarColor = (typeof CALENDAR_COLORS)[number]['key'];
export const isCalendarColor = (c: unknown): c is CalendarColor => CALENDAR_COLORS.some((x) => x.key === c);
/**
 * 2.106: the colours of the days — Friday, Saturday and a holiday — are the calendar's own, never a practitioner's (the owner's
 * decision, 18.10.2026). They stay in the list above (the database's check is the same list); a practitioner picks from the
 * others, and one who had one of them before is shown in a free colour of her own until another is picked.
 */
export const DAY_COLORS = { fri: 'orange', sat: 'blue', chag: 'violet' } as const satisfies Record<string, CalendarColor>;
const dayColors = new Set<string>(Object.values(DAY_COLORS));
export const PRACTITIONER_COLORS = CALENDAR_COLORS.filter((c) => !dayColors.has(c.key));
export const isPractitionerColor = (c: unknown): c is CalendarColor => isCalendarColor(c) && !dayColors.has(c);

/** a person of the team as the calendar knows her (appointment_staff() — never a number) */
export type CalStaff = { id: string; name: string; color: string; practitioner: boolean; memberUserId: string | null; active: boolean };

/**
 * A practitioner's colour: her own (a practitioner's colour — 2.106: never a day's); else one no practitioner has, by her place
 * among those with none (so two never share one while there are enough). 'none': no practitioner — the grey of an appointment
 * waiting for one.
 */
export function staffColor(staff: CalStaff[], id: string | null | undefined): CalendarColor | 'none' {
  if (!id) return 'none';
  const own = staff.find((x) => x.id === id)?.color;
  if (isPractitionerColor(own)) return own;
  const pract = staff.filter((x) => x.practitioner || x.id === id);
  const taken = new Set(pract.map((x) => x.color).filter(isPractitionerColor));
  const all = PRACTITIONER_COLORS.map((c) => c.key);
  const free = all.filter((k) => !taken.has(k));
  const i = Math.max(0, pract.filter((x) => !isPractitionerColor(x.color)).findIndex((x) => x.id === id));
  const pool = free.length ? free : all;
  return pool[i % pool.length];
}

/** the practitioners the calendar shows as columns: on the team and marked, in the team's order */
export const practitioners = (staff: CalStaff[]) => staff.filter((s) => s.practitioner && s.active);

/**
 * An appointment's colour on the calendar: its practitioner's. With none: 'none' (grey, dashed — waiting for one) where the
 * business has practitioners, and 'plain' (the app's own colour) where it has none — there, no appointment waits for anyone.
 */
export function apptColor(staff: CalStaff[], id: string | null | undefined): CalendarColor | 'none' | 'plain' {
  if (!id && !practitioners(staff).length) return 'plain';
  return staffColor(staff, id);
}

// ------------------------------------------------------------------------------------------------------------------- days --

export type CalView = 'day' | 'week' | 'month' | 'list';
export const CAL_VIEWS: { key: CalView; label: string }[] = [
  { key: 'day', label: 'יום' }, { key: 'week', label: 'שבוע' }, { key: 'month', label: 'חודש' }, { key: 'list', label: 'רשימה' },
];

/** "2026-10-18" + n days (a calendar date: no clock, no time zone) */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** the Sunday that starts the date's week */
export const weekStart = (date: string) => addDays(date, -weekdayOf(date));
/** the Israel date of a moment */
export const dayOf = (iso: string) => israelParts(new Date(iso)).date;
/** minutes since midnight, Israel time, of a moment */
export function minuteOfDay(iso: string): number {
  const [h, m] = israelParts(new Date(iso)).time.split(':').map(Number);
  return h * 60 + m;
}

/** the month's cells: whole weeks, from the Sunday on or before the 1st to the Saturday on or after its last day */
export function monthCells(date: string): { date: string; inMonth: boolean }[] {
  const first = `${date.slice(0, 7)}-01`;
  const month = first.slice(0, 7);
  const out: { date: string; inMonth: boolean }[] = [];
  for (let d = weekStart(first); out.length < 42; d = addDays(d, 1)) {
    if (out.length % 7 === 0 && out.length && d.slice(0, 7) > month) break;
    out.push({ date: d, inMonth: d.slice(0, 7) === month });
  }
  return out;
}

/** the days a view shows */
export function viewDays(view: CalView, date: string): string[] {
  if (view === 'day') return [date];
  if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(weekStart(date), i));
  if (view === 'month') return monthCells(date).map((c) => c.date);
  return [];
}

/** what to load for a view: [from, to) as ISO moments — the list: from today (or 30 days back) to 120 days ahead */
export function viewRange(view: CalView, date: string, today: string, past = false): { from: string; to: string } {
  if (view === 'list') return { from: israelToIso(past ? addDays(today, -30) : today, '00:00'), to: israelToIso(addDays(today, 120), '00:00') };
  const days = viewDays(view, date);
  return { from: israelToIso(days[0], '00:00'), to: israelToIso(addDays(days[days.length - 1], 1), '00:00') };
}

/** the next (+1) or the previous (-1) day / week / month; a month keeps its day where it can (31 → the month's last) */
export function shiftDate(view: CalView, date: string, dir: 1 | -1): string {
  if (view === 'day') return addDays(date, dir);
  if (view === 'week' || view === 'list') return addDays(date, 7 * dir);
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + dir, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.toISOString().slice(0, 7)}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

const noon = (date: string) => israelToIso(date, '12:00');
export const WEEKDAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
/** 2.106: Friday and Saturday have a colour each, the same in every view (globals.css .cal-fri / .cal-sat); a date or a weekday */
export const weekendTone = (day: string | number) => {
  const w = typeof day === 'number' ? day : weekdayOf(day);
  return w === 5 ? 'cal-fri' : w === 6 ? 'cal-sat' : '';
};
/** a day's colour on the calendar: a holiday's (chag: holidays.ts chagDay — .cal-chag) over Friday's or Saturday's */
export const dayTone = (date: string, chag = false) => (chag ? 'cal-chag' : weekendTone(date));
/**
 * A day the calendar shows closed (striped, "סגור"): Sunday to Thursday, not a holiday, with no hours on its weekday or one of
 * the business's closed days. Friday, Saturday and the holidays are open for appointments like any day — their colour marks
 * them (the owner's decision, 18.10.2026); closed to customers is the booking page's business (slots.ts), not the calendar's.
 */
export const closedDay = (hours: Hours, closedDates: string[], date: string, chag = false) =>
  !chag && weekdayOf(date) < 5 && (closedDates.includes(date) || !(hours[String(weekdayOf(date))] ?? []).length);
/**
 * The hours a new appointment of the calendar is offered on a day: the day's own; on a Friday, a Saturday or a holiday that has
 * none — the business's usual day (its earliest opening to its latest closing; with no hours at all, 09:00–19:00). The booking
 * page keeps its own rules: no hours, no booking.
 */
export function calendarHours(hours: Hours, date: string, chag = false): Hours {
  const w = weekdayOf(date);
  if ((hours[String(w)] ?? []).length || (!chag && w < 5)) return hours;
  const all = Object.values(hours).flat();
  const usual: [string, string] = all.length ? [all.map((r) => r[0]).sort()[0], all.map((r) => r[1]).sort()[all.length - 1]] : ['09:00', '19:00'];
  return { ...hours, [String(w)]: [usual] };
}
/** "אין תורים" / "תור אחד" / "5 תורים" */
export const apptCount = (n: number) => (n === 0 ? 'אין תורים' : n === 1 ? 'תור אחד' : `${n} תורים`);
/** "א׳ 18.10" */
export const shortDay = (date: string) => `${WEEKDAY_LETTERS[weekdayOf(date)]} ${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}`;

/** the title of a view: "יום ראשון, 18 באוקטובר" / "18–24 באוקטובר 2026" / "אוקטובר 2026" */
export function viewTitle(view: CalView, date: string): string {
  if (view === 'day') return formatIL(noon(date), { weekday: 'long', day: 'numeric', month: 'long' });
  if (view === 'month') return formatIL(noon(date), { month: 'long', year: 'numeric' });
  const a = weekStart(date), b = addDays(a, 6);
  const month = (d: string) => formatIL(noon(d), { month: 'long' });
  const year = b.slice(0, 4);
  return a.slice(0, 7) === b.slice(0, 7)
    ? `${Number(a.slice(8))}–${Number(b.slice(8))} ב${month(b)} ${year}`
    : `${Number(a.slice(8))} ב${month(a)} – ${Number(b.slice(8))} ב${month(b)} ${year}`;
}

// ------------------------------------------------------------------------------------------------------- the hours of a day --

type Span = { start: string; end: string };

/**
 * The hours a day or a week shows, in minutes from midnight (whole hours): the opening hours of those days, widened to every
 * appointment on them; 08:00–20:00 when nothing is open.
 */
export function hourSpan(hours: Hours, days: string[], appts: Span[]): { from: number; to: number } {
  let from = Infinity, to = -Infinity;
  const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + (m || 0); };
  for (const d of days) {
    for (const [a, b] of hours[String(weekdayOf(d))] ?? []) { from = Math.min(from, toMin(a)); to = Math.max(to, toMin(b)); }
  }
  const shown = new Set(days);
  for (const a of appts) {
    const d = dayOf(a.start);
    if (!shown.has(d)) continue;
    from = Math.min(from, minuteOfDay(a.start));
    to = Math.max(to, dayOf(a.end) === d ? minuteOfDay(a.end) : 24 * 60);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { from: 8 * 60, to: 20 * 60 };
  return { from: Math.max(0, Math.floor(from / 60) * 60), to: Math.min(24 * 60, Math.ceil(to / 60) * 60) };
}

/** where an appointment sits on its day: from the top and how tall, in minutes from the first hour shown (cut to the day) */
export function place(a: Span, span: { from: number; to: number }): { top: number; height: number } {
  const d = dayOf(a.start);
  const s = minuteOfDay(a.start);
  const e = dayOf(a.end) === d ? minuteOfDay(a.end) : 24 * 60;
  const top = Math.max(0, s - span.from);
  return { top, height: Math.max(0, Math.min(e, span.to) - span.from - top) };
}

/** appointments at the same hour side by side (like Outlook): each group that overlaps splits the column into lanes */
export function placeLanes<T extends Span>(items: T[]): { item: T; lane: number; lanes: number }[] {
  const sorted = [...items].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const out: { item: T; lane: number; lanes: number }[] = [];
  let group: { item: T; lane: number; lanes: number }[] = [];
  let groupEnd = '';
  let ends: string[] = [];
  const close = () => { for (const g of group) g.lanes = ends.length; out.push(...group); group = []; ends = []; };
  for (const item of sorted) {
    if (group.length && item.start >= groupEnd) close();
    let lane = ends.findIndex((end) => end <= item.start);
    if (lane < 0) { lane = ends.length; ends.push(item.end); } else ends[lane] = item.end;
    group.push({ item, lane, lanes: 0 });
    groupEnd = group.length === 1 || item.end > groupEnd ? item.end : groupEnd;
  }
  close();
  return out;
}

// --------------------------------------------------------------------------------------------------------- the history --

export type ApptEventKind = 'created' | 'moved' | 'staff' | 'status' | 'edited';
export type ApptEvent = {
  id: string; at: string; actorName: string; kind: ApptEventKind;
  before: Record<string, unknown>; after: Record<string, unknown>;
};

const STATUS_LINE: Record<string, string> = {
  booked: 'הוחזר ל"נקבע"', confirmed: 'התור אושר', done: 'סומן: הגיע/ה', no_show: 'סומן: לא הגיע/ה', cancelled: 'התור בוטל',
};
const FIELD_HE: Record<string, string> = {
  name: 'השם', phone: 'הטלפון', email: 'המייל', note: 'ההערה', service_id: 'השירות', service_name: 'השירות', lead_id: 'הכרטיס', location_id: 'הסניף',
};
const hm = (iso: string) => israelParts(new Date(iso)).time;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** what one line of the history says — about the appointment, so it reads the same whoever did it */
export function eventLine(e: Pick<ApptEvent, 'kind' | 'before' | 'after'>): string {
  const b = e.before ?? {}, a = e.after ?? {};
  switch (e.kind) {
    case 'created':
      if (a.source === 'public') return 'נקבע בדף ההזמנות';
      return str(a.staff) ? `נקבע התור אצל ${str(a.staff)}` : 'נקבע התור';
    case 'moved': {
      const from = str(b.start), to = str(a.start);
      if (!from || !to) return 'השעה שונתה';
      // 2.110: an end set by hand — only the end changed, or the length changed with the move
      const len = (s: string, e: string) => (e ? new Date(e).getTime() - new Date(s).getTime() : 0);
      const endFrom = str(b.end), endTo = str(a.end);
      if (from === to) return endFrom && endTo && endFrom !== endTo ? `שעת הסיום שונתה מ-${hm(endFrom)} ל-${hm(endTo)}` : 'השעה שונתה';
      const sameDay = dayOf(from) === dayOf(to);
      const at = (iso: string) => (sameDay ? hm(iso) : `${shortDay(dayOf(iso))} ${hm(iso)}`);
      const longer = endFrom && endTo && len(from, endFrom) !== len(to, endTo) ? `, עד ${hm(endTo)}` : '';
      return `הוזז מ-${at(from)} ל-${at(to)}${longer}`;
    }
    case 'staff': {
      const from = str(b.staff), to = str(a.staff);
      if (from && to) return `הועבר מ${from} ל${to}`;
      if (to) return `שובץ אצל ${to}`;
      return from ? `השיבוץ אצל ${from} בוטל` : 'השיבוץ שונה';
    }
    case 'status': return STATUS_LINE[str(a.status)] ?? 'הסטטוס שונה';
    case 'edited': {
      const names = [...new Set(Object.keys(a).map((k) => FIELD_HE[k]).filter(Boolean))];
      return names.length ? `עודכנו: ${names.join(', ')}` : 'הפרטים עודכנו';
    }
  }
}

/** who did it: her name then; the booking page; or the system (a change with no session) */
export const eventWho = (e: Pick<ApptEvent, 'actorName' | 'kind' | 'after'>) =>
  e.actorName || (e.kind === 'created' && e.after?.source === 'public' ? 'דף ההזמנות' : 'המערכת');

/** "18.10, 08:52" */
export const eventWhen = (iso: string) => `${Number(dayOf(iso).slice(8))}.${Number(dayOf(iso).slice(5, 7))}, ${hm(iso)}`;
