'use client';
import type { ReactNode } from 'react';
import { cx } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';
import { weekdayOf, type Hours } from './slots';
import {
  WEEKDAY_LETTERS, apptColor, apptCount, closedDay, dayOf, dayTone, hourSpan, minuteOfDay, monthCells, place, placeLanes, practitioners, staffColor,
  viewDays, weekendTone, type CalStaff,
} from './calendar';
import { chagDay, holidaysIn, holidayTone, type Holiday } from './holidays';
import type { Appointment } from './booking.service';

/**
 * The calendar's views (2.105): a day — a column for each practitioner (or one column with lanes, when there are none); a week —
 * appointments at the same hour side by side, like Outlook; a month — up to three names a day and "+N", the chosen day's list
 * under it. Each appointment in its practitioner's colour (calendar.ts); a tap opens it, a tap on an empty hour books there.
 * 2.106: the holidays of Israel on every day they fall on (holidays.ts); Friday, Saturday and a holiday in a colour each — open
 * for appointments like any day; a weekday the business is closed (no hours, a vacation) striped.
 */

type Base = {
  appts: Appointment[]; staff: CalStaff[]; hours: Hours; closedDates: string[]; today: string; nowMinute: number;
  onOpen: (a: Appointment) => void;
  onSlot: (date: string, time: string, staffId: string | null) => void;
};

const live = (a: Appointment) => a.status !== 'cancelled';
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const timeOf = (iso: string) => hm(minuteOfDay(iso));
const mark = (a: Appointment) => (a.status === 'done' ? ' ✓' : a.status === 'no_show' ? ' ✗' : '');

/** a tap on an empty place of a column → the quarter hour it falls on */
function slotAt(e: React.MouseEvent<HTMLDivElement>, from: number, perMin: number) {
  const box = e.currentTarget.getBoundingClientRect();
  const min = from + Math.max(0, e.clientY - box.top) / perMin;
  return hm(Math.floor(min / 15) * 15);
}

/**
 * a day's holidays, each in its look ("חול המועד סוכות", "ערב פסח"); nothing on another day. inline: inside a line of text;
 * wrap: up to two lines (a month's narrow day on a phone), else one
 */
export function HolidayLine({ list, inline, wrap, className }: { list: Holiday[]; inline?: boolean; wrap?: boolean; className?: string }) {
  if (!list.length) return null;
  const names = list.map((h, i) => <span key={h.name} className={holidayTone(h.kind)}>{i ? ' · ' : ''}{h.name}</span>);
  return inline ? <span className={className}>{names}</span>
    : <span className={cx(wrap ? 'line-clamp-2' : 'block truncate', className)} title={list.map((h) => h.name).join(' · ')}>{names}</span>;
}

/** how many lines fit a block this tall (px): the hour and the name in one; the hour, then the name; and the service under them */
const linesFor = (px: number, narrow: boolean): 1 | 2 | 3 => (narrow || px < 34 ? 1 : px < 50 ? 2 : 3);

function Block({ a, staff, style, onOpen, lines, range }: {
  a: Appointment; staff: CalStaff[]; style: React.CSSProperties; onOpen: (a: Appointment) => void;
  lines: 1 | 2 | 3;
  /** from–to when the block is wide enough (alone in its column); else only when it starts */
  range: boolean;
}) {
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(a); }} style={style}
      className={cx('cal-appt absolute overflow-hidden rounded-lg px-1.5 py-0.5 text-start text-xs leading-tight shadow-sm', `cal-${apptColor(staff, a.staffId)}`,
        a.status === 'no_show' && 'opacity-60')}
      aria-label={`${timeOf(a.start)}–${timeOf(a.end)} ${a.name}${a.serviceName ? `, ${a.serviceName}` : ''}`}>
      {lines === 1 ? (
        <span className="flex items-center gap-1 whitespace-nowrap"><span className="tabular-nums opacity-80">{timeOf(a.start)}{mark(a)}</span><b className="truncate">{a.name}</b></span>
      ) : (<>
        <span className="block truncate tabular-nums opacity-80">{range ? `${timeOf(a.start)}–${timeOf(a.end)}` : timeOf(a.start)}{mark(a)}</span>
        <b className="block truncate text-[13px]">{a.name}</b>
        {lines === 3 && a.serviceName && <span className="block truncate opacity-85">{a.serviceName}</span>}
      </>)}
    </button>
  );
}

function HourGrid({ from, to, perMin }: { from: number; to: number; perMin: number }) {
  const lines: ReactNode[] = [];
  for (let m = from; m <= to; m += 30) {
    lines.push(<div key={m} className={cx('pointer-events-none absolute inset-x-0 border-t', m % 60 ? 'border-dashed border-line/60' : 'border-line')} style={{ top: (m - from) * perMin }} />);
  }
  return <>{lines}</>;
}

function TimeColumn({ from, to, perMin }: { from: number; to: number; perMin: number }) {
  const labels: ReactNode[] = [];
  for (let m = from + 60; m < to; m += 60) {
    labels.push(<span key={m} className="absolute end-1.5 -translate-y-1/2 text-[11px] tabular-nums text-muted" style={{ top: (m - from) * perMin }}>{hm(m)}</span>);
  }
  return <div className="relative w-11 shrink-0" style={{ height: (to - from) * perMin }}>{labels}</div>;
}

function NowLine({ minute, from, to, perMin }: { minute: number; from: number; to: number; perMin: number }) {
  if (minute < from || minute > to) return null;
  return <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" style={{ top: (minute - from) * perMin }} aria-hidden="true" />;
}

// ---------------------------------------------------------------------------------------------------------------- a day --

/** a day: a column for each practitioner shown; with none — one column, appointments at one hour side by side */
export function DayView({ date, columns, ...p }: Base & { date: string; columns: CalStaff[] }) {
  const perMin = 64 / 60;
  const shown = p.appts.filter((a) => live(a) && dayOf(a.start) === date);
  const span = hourSpan(p.hours, [date], shown);
  const height = (span.to - span.from) * perMin;
  const unassigned = columns.length ? shown.filter((a) => !a.staffId) : [];
  const holidays = holidaysIn(date, date).get(date) ?? [];
  const closed = closedDay(p.hours, p.closedDates, date, chagDay(holidays)) && !shown.length;
  const tone = dayTone(date, chagDay(holidays));
  const cols: { id: string | null; title: ReactNode; list: Appointment[] }[] = columns.length
    ? columns.map((s) => ({
      id: s.id, list: shown.filter((a) => a.staffId === s.id),
      title: <><b className="flex items-center justify-center gap-1.5 text-sm"><span className={cx('cal-dot h-2.5 w-2.5 rounded-full', `cal-${staffColor(p.staff, s.id)}`)} />{s.name.split(' ')[0]}</b></>,
    }))
    : [{ id: null, list: shown, title: null }];
  return (
    <div className="grid gap-2">
      {(holidays.length > 0 || closed) && (
        <p className="rounded-2xl border border-line bg-surface px-3 py-2 text-sm">
          <HolidayLine list={holidays} inline />{holidays.length > 0 && closed ? ' · ' : ''}{closed && <span className="font-semibold text-muted">סגור</span>}
        </p>
      )}
      {unassigned.length > 0 && (
        <div className="cal-none flex flex-wrap items-center gap-2 rounded-2xl border border-dashed border-line bg-surface-2 px-3 py-2 text-sm">
          <span className="font-semibold">{unassigned.length === 1 ? 'תור אחד בלי מטפל/ת:' : `${unassigned.length} תורים בלי מטפל/ת:`}</span>
          {unassigned.map((a) => (
            <button key={a.id} type="button" onClick={() => p.onOpen(a)} className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-semibold">
              <span className="tabular-nums">{timeOf(a.start)}</span> · {a.name} · <span className="text-primary">לשיבוץ ›</span>
            </button>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        {columns.length > 0 && (
          <div className={cx('flex border-b border-line', tone)}>
            <div className="w-11 shrink-0" />
            {cols.map((c) => (
              <div key={c.id ?? 'all'} className="min-w-0 flex-1 border-s border-line px-1 py-2 text-center">
                {c.title}<small className="block text-[11px] text-muted">{apptCount(c.list.length)}</small>
              </div>
            ))}
          </div>
        )}
        <div className={cx('relative flex', tone)}>
          <TimeColumn from={span.from} to={span.to} perMin={perMin} />
          {cols.map((c) => {
            const lanes = c.id === null ? placeLanes(c.list) : c.list.map((item) => ({ item, lane: 0, lanes: 1 }));
            return (
              <div key={c.id ?? 'all'} className={cx('relative min-w-0 flex-1 cursor-copy border-s border-line', closed && 'cal-closed')} style={{ height }}
                onClick={(e) => p.onSlot(date, slotAt(e, span.from, perMin), c.id)}>
                <HourGrid from={span.from} to={span.to} perMin={perMin} />
                {lanes.map(({ item, lane, lanes: n }) => {
                  const at = place(item, span);
                  const h = Math.max(18, at.height * perMin - 2);
                  return <Block key={item.id} a={item} staff={p.staff} onOpen={p.onOpen} lines={linesFor(h, n > 2)} range={n === 1}
                    style={{ top: at.top * perMin + 1, height: h, insetInlineStart: `calc(${(lane * 100) / n}% + 3px)`, width: `calc(${100 / n}% - 6px)` }} />;
                })}
              </div>
            );
          })}
          {date === p.today && <NowLine minute={p.nowMinute} from={span.from} to={span.to} perMin={perMin} />}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------------------------------- a week --

/** a week, Sunday to Saturday: the appointments of each day side by side when they meet */
export function WeekView({ date, ...p }: Base & { date: string }) {
  const perMin = 48 / 60;
  const days = viewDays('week', date);
  const shown = p.appts.filter(live);
  const span = hourSpan(p.hours, days, shown);
  const height = (span.to - span.from) * perMin;
  // a week with a holiday has a line for it under every day's date (empty on the others — the counts stay in one row)
  const holidays = holidaysIn(days[0], days[days.length - 1]);
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface scrollbar-thin">
      <div className="min-w-[760px]">
        <div className="flex border-b border-line">
          <div className="w-11 shrink-0" />
          {days.map((d) => {
            const n = shown.filter((a) => dayOf(a.start) === d).length;
            const chag = chagDay(holidays.get(d) ?? []);
            const closed = closedDay(p.hours, p.closedDates, d, chag) && !n;
            return (
              <div key={d} className={cx('min-w-0 flex-1 border-s border-line px-1 py-2 text-center', dayTone(d, chag))}>
                <b className={cx('block text-sm', d === p.today && 'cal-accent')}>{WEEKDAY_LETTERS[weekdayOf(d)]} {Number(d.slice(8))}.{Number(d.slice(5, 7))}</b>
                {holidays.size > 0 && (holidays.get(d)
                  ? <HolidayLine list={holidays.get(d)!} className="text-[11px] leading-4" />
                  : <span className="block h-4" aria-hidden="true" />)}
                <small className="text-[11px] text-muted">{closed ? 'סגור' : apptCount(n)}</small>
              </div>
            );
          })}
        </div>
        <div className="relative flex">
          <TimeColumn from={span.from} to={span.to} perMin={perMin} />
          {days.map((d) => {
            const list = shown.filter((a) => dayOf(a.start) === d);
            const chag = chagDay(holidays.get(d) ?? []);
            const closed = closedDay(p.hours, p.closedDates, d, chag) && !list.length;
            return (
              <div key={d} className={cx('relative min-w-0 flex-1 cursor-copy border-s border-line', dayTone(d, chag), closed && 'cal-closed')} style={{ height }}
                onClick={(e) => p.onSlot(d, slotAt(e, span.from, perMin), null)}>
                <HourGrid from={span.from} to={span.to} perMin={perMin} />
                {placeLanes(list).map(({ item, lane, lanes: n }) => {
                  const at = place(item, span);
                  const h = Math.max(16, at.height * perMin - 2);
                  return <Block key={item.id} a={item} staff={p.staff} onOpen={p.onOpen} lines={linesFor(h, n > 2)} range={n === 1}
                    style={{ top: at.top * perMin + 1, height: h, insetInlineStart: `calc(${(lane * 100) / n}% + 2px)`, width: `calc(${100 / n}% - 4px)` }} />;
                })}
                {d === p.today && <NowLine minute={p.nowMinute} from={span.from} to={span.to} perMin={perMin} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------------------- a month --

/** a month like Outlook's: up to three names a day in their colours and "+N"; the chosen day's appointments under it */
export function MonthView({ date, onPick, ...p }: Base & { date: string; onPick: (date: string) => void }) {
  const cells = monthCells(date);
  const shown = p.appts.filter(live);
  const of = (d: string) => shown.filter((a) => dayOf(a.start) === d).sort((x, y) => x.start.localeCompare(y.start));
  const chosen = of(date);
  const withStaff = practitioners(p.staff).length > 0;
  const holidays = holidaysIn(cells[0].date, cells[cells.length - 1].date);
  const names = (d: string) => (holidays.get(d) ?? []).map((h) => h.name).join(' · ');
  return (
    <div className="grid gap-3">
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="grid grid-cols-7 border-b border-line">
          {WEEKDAY_LETTERS.map((l, i) => <span key={l} className={cx('py-1.5 text-center text-xs font-bold text-muted', weekendTone(i))}>{l}</span>)}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((c, i) => {
            const list = of(c.date);
            const chag = chagDay(holidays.get(c.date) ?? []);
            const closed = c.inMonth && closedDay(p.hours, p.closedDates, c.date, chag) && !list.length;
            return (
              <button key={c.date} type="button" onClick={() => onPick(c.date)}
                className={cx('flex min-h-[92px] min-w-0 flex-col justify-start overflow-hidden border-t border-line p-0.5 text-start sm:min-h-[110px] sm:p-1', i % 7 !== 0 && 'border-s',
                  dayTone(c.date, chag), !c.inMonth && 'bg-surface-2 opacity-60', closed && 'cal-closed')}
                aria-label={`${formatIL(`${c.date}T12:00:00Z`, { weekday: 'long', day: 'numeric', month: 'long' })}${names(c.date) ? ` · ${names(c.date)}` : ''}: ${apptCount(list.length)}`}>
                <span className={cx('mb-0.5 inline-block min-w-6 self-start rounded-full px-1 text-center text-xs font-bold',
                  c.date === date ? 'bg-primary text-white' : c.date === p.today ? 'cal-accent' : 'text-ink-2')}>{Number(c.date.slice(8))}</span>
                <HolidayLine list={holidays.get(c.date) ?? []} wrap className="mb-0.5 px-0.5 text-[10px] leading-3 sm:text-[11px] sm:leading-4" />
                {list.slice(0, 3).map((a) => (
                  <span key={a.id} className={cx('cal-appt mb-0.5 block truncate rounded px-1 text-[10.5px] font-bold sm:text-xs', `cal-${apptColor(p.staff, a.staffId)}`)}>
                    {a.name.split(' ')[0]}
                  </span>
                ))}
                {list.length > 3 && <span className="cal-accent block px-0.5 text-[10.5px] font-bold" dir="ltr">+{list.length - 3}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="rounded-2xl border border-line bg-surface p-3">
        <h3 className="mb-1 font-bold">
          {formatIL(`${date}T12:00:00Z`, { weekday: 'long', day: 'numeric', month: 'long' })}
          {holidays.has(date) && <> · <HolidayLine list={holidays.get(date)!} inline /></>} · {apptCount(chosen.length)}
        </h3>
        {!chosen.length && <p className="py-2 text-sm text-muted">אין תורים ביום הזה.</p>}
        {chosen.map((a) => {
          const s = p.staff.find((x) => x.id === a.staffId);
          return (
            <button key={a.id} type="button" onClick={() => p.onOpen(a)} className="flex w-full items-center gap-2.5 border-b border-dashed border-line py-2 text-start text-sm last:border-0">
              <span className={cx('cal-dot h-8 w-1 shrink-0 rounded', `cal-${apptColor(p.staff, a.staffId)}`)} />
              <span className="w-[86px] shrink-0 text-xs tabular-nums text-muted">{timeOf(a.start)}–{timeOf(a.end)}{mark(a)}</span>
              <span className="min-w-0 flex-1 truncate"><b>{a.name}</b>{a.serviceName ? ` · ${a.serviceName}` : ''}</span>
              {(withStaff || s) && <span className={cx('cal-appt shrink-0 rounded-full px-2 py-0.5 text-xs font-bold', `cal-${apptColor(p.staff, a.staffId)}`)}>{s ? s.name.split(' ')[0] : 'לשיבוץ'}</span>}
            </button>
          );
        })}
        <button type="button" onClick={() => p.onSlot(date, '', null)} className="mt-2 text-sm font-semibold text-primary">+ תור ביום הזה</button>
      </div>
    </div>
  );
}

