import { israelParts } from '@/lib/il-time';

/**
 * Time clock math — pure, shared by the owner's report and the employee page (tests/timeclock.test.ts).
 * A shift belongs to the Israeli calendar day it started on (a night shift 22:00–06:00 is one shift).
 */
export interface Entry { id: string; employeeId: string; clockIn: string; clockOut: string | null; edited?: boolean; source?: 'self' | 'manual'; note?: string; inLat?: number | null; inLng?: number | null }
export interface Employee { id: string; name: string; phone: string; hourlyRate: number | null; active: boolean; token: string }

export const minutesOf = (e: Pick<Entry, 'clockIn' | 'clockOut'>, now = Date.now()) =>
  Math.max(0, Math.round(((e.clockOut ? new Date(e.clockOut).getTime() : now) - new Date(e.clockIn).getTime()) / 60_000));

/** 7:05 style */
export const hhmm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
/** 7.08 style (for payroll / Excel) */
export const decimalHours = (min: number) => Math.round((min / 60) * 100) / 100;

export const dayOf = (iso: string) => israelParts(new Date(iso)).date;

/** first and last calendar day of a month, as YYYY-MM-DD (Israel) */
export function monthRange(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

export interface EmployeeTotals { employeeId: string; minutes: number; days: number; shifts: number; open: number; longDays: string[]; pay: number | null }

/**
 * Totals per employee for closed shifts that started inside [fromDay, toDay].
 * Open shifts are counted separately (not paid until closed). Days over 9 hours are flagged so the
 * owner notices overtime or a forgotten clock-out.
 */
export function totals(entries: Entry[], employees: Employee[], fromDay: string, toDay: string): EmployeeTotals[] {
  return employees.map((emp) => {
    const mine = entries.filter((e) => e.employeeId === emp.id && dayOf(e.clockIn) >= fromDay && dayOf(e.clockIn) <= toDay);
    const closed = mine.filter((e) => e.clockOut);
    const perDay = new Map<string, number>();
    for (const e of closed) perDay.set(dayOf(e.clockIn), (perDay.get(dayOf(e.clockIn)) ?? 0) + minutesOf(e));
    const minutes = [...perDay.values()].reduce((a, b) => a + b, 0);
    return {
      employeeId: emp.id, minutes, days: perDay.size, shifts: closed.length, open: mine.length - closed.length,
      longDays: [...perDay.entries()].filter(([, m]) => m > 9 * 60).map(([d]) => d).sort(),
      pay: emp.hourlyRate != null ? Math.round(decimalHours(minutes) * emp.hourlyRate * 100) / 100 : null,
    };
  });
}

/** CSV for the accountant (UTF-8 with BOM so Excel shows Hebrew) */
export function reportCsv(entries: Entry[], employees: Employee[], fromDay: string, toDay: string) {
  const name = new Map(employees.map((e) => [e.id, e.name]));
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = entries
    .filter((e) => e.clockOut && dayOf(e.clockIn) >= fromDay && dayOf(e.clockIn) <= toDay)
    .sort((a, b) => (name.get(a.employeeId) ?? '').localeCompare(name.get(b.employeeId) ?? '') || a.clockIn.localeCompare(b.clockIn))
    .map((e) => [name.get(e.employeeId), dayOf(e.clockIn), israelParts(new Date(e.clockIn)).time, israelParts(new Date(e.clockOut!)).time,
      decimalHours(minutesOf(e)), e.edited || e.source === 'manual' ? 'תוקן ידנית' : '', e.note ?? ''].map(esc).join(','));
  const sum = totals(entries, employees, fromDay, toDay).filter((t) => t.shifts)
    .map((t) => [name.get(t.employeeId), 'סה״כ', '', '', decimalHours(t.minutes), t.pay != null ? `₪${t.pay}` : '', `${t.days} ימים`].map(esc).join(','));
  return '\uFEFF' + ['עובד/ת,תאריך,כניסה,יציאה,שעות,הערה,פירוט', ...rows, '', ...sum].join('\r\n');
}

/** a private link token: 32 url-safe random characters */
export function newToken() {
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[b % 64]).join('') + Date.now().toString(36).slice(-8);
}
