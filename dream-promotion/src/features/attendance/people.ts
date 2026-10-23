import { waLink } from '@/features/crm/crm';
import type { Track } from './hours-engine';

/**
 * The people of the attendance module and their rows (tests/attendance-people.test.ts): an employee as the screens use it,
 * the ID check, the invitation by WhatsApp with the personal link, the pay in whole agorot.
 */
export interface Employee {
  id: string; name: string; phone: string; active: boolean; token: string;
  code: string; departmentId: string | null; title: string; trackId: string | null;
  startDate: string | null; endDate: string | null; createdAt: string; lastActiveAt: string | null; invitedAt: string | null;
}
export interface Department { id: string; name: string; active: boolean }
export interface WorkTrack extends Track { id: string; name: string; active: boolean }
export interface PrivateDetails { employeeId: string; idNumber: string; payKind: '' | 'hourly' | 'monthly'; hourlyAgorot: number | null; monthlyAgorot: number | null }
export type AttRole = 'admin' | 'approver' | 'payroll' | 'viewer' | 'none';

export const toEmployee = (r: any): Employee => ({
  id: r.id, name: r.name, phone: r.phone ?? '', active: r.active !== false, token: r.token,
  code: r.employee_code ?? '', departmentId: r.department_id ?? null, title: r.title ?? '', trackId: r.track_id ?? null,
  startDate: r.start_date ?? null, endDate: r.end_date ?? null, createdAt: r.created_at, lastActiveAt: r.last_active_at ?? null, invitedAt: r.invited_at ?? null,
});
export const toTrack = (r: any): WorkTrack => ({
  id: r.id, name: r.name, active: r.active !== false, dayMinutes: (r.day_minutes ?? [0, 0, 0, 0, 0, 0, 0]).map(Number),
  startTime: r.start_time ? String(r.start_time).slice(0, 5) : null, lateGraceMin: r.late_grace_min ?? 0,
  autoBreakMin: r.auto_break_min ?? 0, autoBreakAfterMin: r.auto_break_after_min ?? 0,
});
export const toPrivate = (r: any): PrivateDetails => ({
  employeeId: r.employee_id, idNumber: r.id_number ?? '', payKind: r.pay_kind ?? '', hourlyAgorot: r.hourly_agorot ?? null, monthlyAgorot: r.monthly_agorot ?? null,
});

/** an Israeli ID number: 9 digits (shorter ones padded with zeros) and its check digit */
export function validIsraeliId(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  if (!d || d.length > 9) return false;
  const s = d.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) { let x = Number(s[i]) * ((i % 2) + 1); if (x > 9) x -= 9; sum += x; }
  return sum % 10 === 0 && /[1-9]/.test(s);
}

/** "45.50" / "45,5" → 4550 agorot; empty → null; anything else → undefined (refused) */
export function agorotOf(raw: string): number | null | undefined {
  const s = raw.trim().replace(/[₪\s]/g, '').replace(',', '.');
  if (!s) return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return undefined;
  const [i, f = ''] = s.split('.');
  return Number(i) * 100 + Number((f + '00').slice(0, 2));
}
export const shekels = (agorot: number | null) => (agorot == null ? '' : `${Math.floor(agorot / 100)}${agorot % 100 ? `.${String(agorot % 100).padStart(2, '0')}` : ''}`);

/** the message that invites an employee — their personal link, nothing of Dream */
export const inviteText = (name: string, business: string, link: string) =>
  `שלום ${name.split(' ')[0]}, זה הקישור האישי שלך לשעון הנוכחות${business ? ` של ${business}` : ''}:\n${link}\nפותחים אותו בטלפון, ושומרים למסך הבית (שיתוף ← "הוסף למסך הבית"). משם — כניסה ויציאה בלחיצה.`;
/** wa.me with the message, or '' when the phone is not a phone */
export const inviteLink = (e: Pick<Employee, 'name' | 'phone'>, business: string, link: string) => waLink(e.phone, inviteText(e.name, business, link));

/** hours of a track's day as typed ("8.6", "9", "8:36") → minutes; '' = not a work day */
export function trackDayMinutes(raw: string): number | undefined {
  const s = raw.trim();
  if (!s || s === '0') return 0;
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (hm) return +hm[1] * 60 + +hm[2] <= 1440 ? +hm[1] * 60 + +hm[2] : undefined;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 24 ? Math.round(n * 60) : undefined;
}
export const trackDayText = (min: number) => (min ? (min % 60 ? String(Math.round((min / 60) * 100) / 100) : String(min / 60)) : '');
/** what a track says in one line: "א׳–ה׳ 8.6 ש׳" */
export function trackSummary(t: Pick<Track, 'dayMinutes'>) {
  const letters = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const groups: { from: number; to: number; min: number }[] = [];
  t.dayMinutes.forEach((m, i) => {
    const g = groups[groups.length - 1];
    if (m && g && g.min === m && g.to === i - 1) g.to = i; else if (m) groups.push({ from: i, to: i, min: m });
  });
  if (!groups.length) return 'בלי ימי עבודה';
  return groups.map((g) => `${letters[g.from]}${g.to > g.from ? `–${letters[g.to]}` : ''} ${trackDayText(g.min)} ש׳`).join(', ');
}

/** who may do what on the screens — the same rules as att_role() / att_manages() in the database (it decides; this only hides) */
export const canManage = (r: AttRole) => r === 'admin' || r === 'approver';
export const isAdmin = (r: AttRole) => r === 'admin';
export const seesPrivate = (r: AttRole) => r === 'admin' || r === 'payroll';
