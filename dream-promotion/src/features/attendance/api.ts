import { supabase } from '@/lib/supabase/client';
import { israelToIso } from '@/lib/il-time';
import { newToken } from '@/features/timeclock/hours';
import { addDay, daysOfMonth, type AbsenceKind, type EngineAbsence, type EngineEntry, type Method } from './hours-engine';
import type { ContractRules } from './overtime-rules';
import { toEmployee, toPrivate, toTrack, type AttRole, type Department, type Employee, type PrivateDetails, type WorkTrack } from './people';

/**
 * The attendance module's data (2.107). Reads go through row-level security (the business worked in now; an approver — their
 * people only); every write of hours, requests, absences and months goes through the att_* functions of migration 5800, which
 * check who, the business, the closed month and the reason. Employees, departments, tracks and approvers are written directly
 * (their policies: the admin only).
 */
const db = () => supabase();
const uuid = () => crypto.randomUUID();

/** the database's refusal → what the manager is told */
export function attError(e: unknown): string {
  const m = String((e as any)?.message ?? e ?? '');
  if (/relation .* does not exist|schema cache|function .* does not exist|could not find the function/i.test(m)) return 'צריך להריץ את מיגרציה 20261023005800 (נוכחות ועובדים) ב-Supabase.';
  if (/month is closed/.test(m)) return 'החודש סגור. כדי לשנות — פותחים אותו מחדש (עם סיבה) במסך הדוח החודשי.';
  if (/reason is required/.test(m)) return 'צריך לכתוב סיבה (לפחות 2 תווים).';
  if (/overlaps/.test(m)) return 'יש כבר רישום של העובד/ת בשעות האלה. אם יש משמרת פתוחה — סוגרים אותה קודם.';
  if (/one_open|23505/.test(m) && /time_entries/.test(m)) return 'לעובד/ת הזה/ו כבר יש משמרת פתוחה.';
  if (/employees_code_uq/.test(m)) return 'מספר העובד כבר קיים בעסק.';
  if (/id_number_check/.test(m)) return 'מספר תעודת זהות — 9 ספרות.';
  if (/in the future|future/.test(m)) return 'אי אפשר לדווח שעות שעוד לא היו.';
  if (/clock-in and its clock-out|after the clock-in/.test(m)) return 'שעת היציאה חייבת להיות אחרי שעת הכניסה.';
  if (/already corrected|already decided|not open/.test(m)) return 'הרישום כבר השתנה בינתיים. מרעננים ומנסים שוב.';
  if (/open shift/.test(m)) return 'יש משמרת פתוחה בחודש (בלי יציאה). סוגרים אותה ואז סוגרים את החודש.';
  if (/request is waiting|absence is waiting/.test(m)) return 'יש בקשה או היעדרות שממתינות לאישור בחודש הזה.';
  if (/after it ended/.test(m)) return 'סוגרים חודש רק אחרי שהוא נגמר.';
  if (/not a member/.test(m)) return 'המאשר/ת צריך/ה להיות משתמש/ת בעסק.';
  if (/not allowed|row-level security|permission denied|42501/.test(m)) return 'אין לך הרשאה לפעולה הזו.';
  return 'משהו השתבש. נסו שוב.';
}
const must = async <T,>(p: PromiseLike<{ data: T; error: any }>): Promise<T> => { const { data, error } = await p; if (error) throw error; return data; };

/** is migration 5800 in the database? (before it — the old clock screen, as it was) */
export async function attendanceReady(): Promise<boolean> {
  const { error } = await db().from('attendance_months').select('employee_id').limit(1);
  return !error;
}
export async function myRole(): Promise<AttRole> {
  const { data, error } = await db().rpc('att_role');
  return error ? 'none' : ((data as AttRole) ?? 'none');
}

export interface Setup { employees: Employee[]; departments: Department[]; tracks: WorkTrack[]; privates: Map<string, PrivateDetails>; approvers: Approver[] }
export interface Approver { id: string; userId: string; departmentId: string | null; employeeId: string | null; active: boolean }
export async function loadSetup(o: { privates?: boolean } = {}): Promise<Setup> {
  const [e, d, t, a, p] = await Promise.all([
    must(db().from('employees').select('*').order('created_at')),
    must(db().from('departments').select('*').order('created_at')),
    must(db().from('work_tracks').select('*').order('created_at')),
    must(db().from('attendance_approvers').select('*').eq('active', true).order('created_at')),
    o.privates ? must(db().from('employee_private').select('*')) : Promise.resolve([]),
  ]);
  return {
    employees: (e as any[]).map(toEmployee),
    departments: (d as any[]).map((r) => ({ id: r.id, name: r.name, active: r.active })),
    tracks: (t as any[]).map(toTrack),
    approvers: (a as any[]).map((r) => ({ id: r.id, userId: r.approver_user_id, departmentId: r.department_id, employeeId: r.employee_id, active: r.active })),
    privates: new Map((p as any[]).map((r) => [r.employee_id, toPrivate(r)])),
  };
}

export type Entry = EngineEntry & { employeeId: string; edited: boolean; createdAt: string };
const toEntry = (r: any): Entry => ({
  id: r.id, employeeId: r.employee_id, clockIn: r.clock_in, clockOut: r.clock_out, method: (r.method ?? null) as Method | null, outMethod: (r.out_method ?? null) as Method | null,
  source: r.source, voidedAt: r.voided_at, replaces: r.replaces, inLat: r.in_lat, inLng: r.in_lng, outLat: r.out_lat, outLng: r.out_lng, note: r.note ?? '',
  edited: Boolean(r.edited), createdAt: r.created_at,
});
/** the moments of a month (Israel): from its first midnight to the next month's */
export const monthBounds = (month: string) => {
  const days = daysOfMonth(month);
  return { from: israelToIso(days[0], '00:00'), to: israelToIso(addDay(days[days.length - 1]), '00:00') };
};
/** the entries that started in a month (with the voided ones — the history shows them), and the open shifts of anyone */
export async function loadEntries(month: string, employeeId?: string): Promise<Entry[]> {
  const { from, to } = monthBounds(month);
  let q = db().from('time_entries').select('*').gte('clock_in', from).lt('clock_in', to).order('clock_in');
  if (employeeId) q = q.eq('employee_id', employeeId);
  let o = db().from('time_entries').select('*').is('clock_out', null).is('voided_at', null);
  if (employeeId) o = o.eq('employee_id', employeeId);
  const [a, b] = await Promise.all([must(q), must(o)]);
  const all = new Map<string, Entry>();
  for (const r of [...(a as any[]), ...(b as any[])]) all.set(r.id, toEntry(r));
  return [...all.values()];
}

export type Absence = EngineAbsence & { employeeId: string; note: string; filePath: string; requestedBy: 'employee' | 'manager'; decisionNote: string; createdAt: string };
const toAbsence = (r: any): Absence => ({
  id: r.id, employeeId: r.employee_id, kind: r.kind, from: r.from_day, to: r.to_day, minutes: r.minutes, status: r.status, note: r.note ?? '',
  filePath: r.file_path ?? '', requestedBy: r.requested_by, decisionNote: r.decision_note ?? '', createdAt: r.created_at,
});
export async function loadAbsences(o: { month?: string; employeeId?: string; status?: string } = {}): Promise<Absence[]> {
  let q = db().from('absences').select('*').order('from_day', { ascending: false });
  if (o.month) { const d = daysOfMonth(o.month); q = q.lte('from_day', d[d.length - 1]).gte('to_day', d[0]); }
  if (o.employeeId) q = q.eq('employee_id', o.employeeId);
  if (o.status) q = q.eq('status', o.status);
  return ((await must(q)) as any[]).map(toAbsence);
}

export interface TimeRequest { id: string; employeeId: string; kind: 'missing_in' | 'missing_out' | 'shift' | 'fix'; entryId: string | null; clockIn: string | null; clockOut: string | null;
  note: string; status: string; decisionNote: string; createdAt: string }
export async function loadRequests(status = 'pending'): Promise<TimeRequest[]> {
  const rows = (await must(db().from('time_requests').select('*').eq('status', status).order('created_at'))) as any[];
  return rows.map((r) => ({ id: r.id, employeeId: r.employee_id, kind: r.kind, entryId: r.entry_id, clockIn: r.clock_in, clockOut: r.clock_out, note: r.note ?? '',
    status: r.status, decisionNote: r.decision_note ?? '', createdAt: r.created_at }));
}

export type MonthState = 'open' | 'approved' | 'closed';
export async function loadMonths(month: string): Promise<Map<string, MonthState>> {
  return new Map([...(await loadMonthRows(month))].map(([k, v]) => [k, v.status]));
}
/** a month of each employee: its state, and the track it was closed with (a closed month is computed by it — never by today's track) */
export async function loadMonthRows(month: string): Promise<Map<string, { status: MonthState; snapshot: WorkTrack | null }>> {
  const rows = (await must(db().from('attendance_months').select('employee_id, status, rules_snapshot').eq('month', month))) as any[];
  return new Map(rows.map((r) => [r.employee_id, { status: r.status as MonthState, snapshot: r.status === 'closed' && r.rules_snapshot ? toTrack(r.rules_snapshot) : null }]));
}
/** the track to compute a month by: the closed month's snapshot, else the employee's track today */
export const trackFor = (employeeTrack: WorkTrack | null | undefined, month?: { snapshot: WorkTrack | null } | null) => month?.snapshot ?? employeeTrack ?? null;

export interface HistoryLine { at: string; kind: string; entryId: string; actorName: string; channel: string; reason: string; before: any; after: any }
export async function loadHistory(employeeId: string, entryIds: string[]): Promise<HistoryLine[]> {
  if (!entryIds.length) return [];
  const rows = (await must(db().from('time_entry_events').select('*').eq('employee_id', employeeId).in('entry_id', entryIds).order('at'))) as any[];
  return rows.map((r) => ({ at: r.at, kind: r.kind, entryId: r.entry_id, actorName: r.actor_name ?? '', channel: r.channel, reason: r.reason ?? '', before: r.before, after: r.after }));
}
export async function loadMonthHistory(employeeId: string, month: string) {
  const rows = (await must(db().from('attendance_month_events').select('*').eq('employee_id', employeeId).eq('month', month).order('at'))) as any[];
  return rows.map((r) => ({ at: r.at as string, kind: r.kind as string, reason: (r.reason ?? '') as string, actorName: (r.actor_name ?? '') as string }));
}

// ---- writes ----------------------------------------------------------------------------------------------------------------
export interface EmployeeForm { name: string; phone: string; code: string; departmentId: string | null; title: string; trackId: string | null; startDate: string | null; endDate: string | null }
const employeeRow = (f: EmployeeForm) => ({
  name: f.name.trim(), phone: f.phone.trim(), employee_code: f.code.trim(), department_id: f.departmentId || null, title: f.title.trim(),
  track_id: f.trackId || null, start_date: f.startDate || null, end_date: f.endDate || null,
});
export async function addEmployee(userId: string, f: EmployeeForm): Promise<string> {
  const row = await must(db().from('employees').insert({ ...employeeRow(f), user_id: userId, token: newToken() }).select('id').single());
  return (row as any).id;
}
export const saveEmployee = (id: string, f: EmployeeForm) => must(db().from('employees').update(employeeRow(f)).eq('id', id));
/** archive / back to active (never deleted) */
export const setEmployeeActive = (id: string, active: boolean, endDate?: string | null) =>
  must(db().from('employees').update(active ? { active: true, end_date: null } : { active: false, end_date: endDate ?? null }).eq('id', id));
export const newLink = (id: string) => must(db().from('employees').update({ token: newToken() }).eq('id', id));
export const markInvited = (id: string) => must(db().from('employees').update({ invited_at: new Date().toISOString() }).eq('id', id));
export const savePrivate = (businessId: string, p: PrivateDetails) => must(db().from('employee_private').upsert({
  employee_id: p.employeeId, business_id: businessId, id_number: p.idNumber, pay_kind: p.payKind, hourly_agorot: p.hourlyAgorot, monthly_agorot: p.monthlyAgorot,
}, { onConflict: 'employee_id' }));

export const addDepartment = (businessId: string, name: string) => must(db().from('departments').insert({ business_id: businessId, name: name.trim() }));
export const setDepartment = (id: string, patch: { name?: string; active?: boolean }) => must(db().from('departments').update(patch).eq('id', id));
export interface TrackForm { name: string; dayMinutes: number[]; startTime: string | null; lateGraceMin: number; rules: ContractRules }
const trackRow = (t: TrackForm) => ({ name: t.name.trim(), day_minutes: t.dayMinutes, start_time: t.startTime || null, late_grace_min: t.lateGraceMin,
  auto_break_min: t.rules.autoBreakMin, auto_break_after_min: t.rules.autoBreakAfterMin,
  ot_mode: t.rules.mode, monthly_minutes: t.rules.mode === 'monthly' ? t.rules.monthlyMinutes : null,
  monthly_tier1_minutes: t.rules.mode === 'monthly' ? t.rules.monthlyTier1Minutes : null,
  tier1_minutes: t.rules.tier1Minutes, tier1_pct: t.rules.tier1Pct, tier2_pct: t.rules.tier2Pct,
  rest_weekday: t.rules.restWeekday, rest_pct: t.rules.restPct, rest_tier1_pct: t.rules.restTier1Pct, rest_tier2_pct: t.rules.restTier2Pct,
  festival_pct: t.rules.festivalPct, independence_rest: t.rules.independenceRest, independence_pct: t.rules.independencePct, eve_minutes: t.rules.eveMinutes });
export const setTrackActive = (id: string, active: boolean) => must(db().from('work_tracks').update({ active }).eq('id', id));
/** hours leave the system as PDF only (the business's setting, default on) */
export async function loadExportsPdfOnly(): Promise<boolean> {
  const { data, error } = await db().from('timeclock_settings').select('exports_pdf_only').maybeSingle();
  return error || !data ? true : (data as any).exports_pdf_only !== false;
}
export async function setExportsPdfOnly(userId: string, on: boolean) {
  return must(db().from('timeclock_settings').upsert({ user_id: userId, exports_pdf_only: on }, { onConflict: 'business_id' }));
}
export const addTrack = (businessId: string, t: TrackForm) => must(db().from('work_tracks').insert({ business_id: businessId, ...trackRow(t) }));
export const saveTrack = (id: string, t: TrackForm) => must(db().from('work_tracks').update(trackRow(t)).eq('id', id));
export const addApprover = (businessId: string, userId: string, target: { departmentId?: string; employeeId?: string }) =>
  must(db().from('attendance_approvers').insert({ business_id: businessId, approver_user_id: userId, department_id: target.departmentId ?? null, employee_id: target.employeeId ?? null }));
export const removeApprover = (id: string) => must(db().from('attendance_approvers').update({ active: false }).eq('id', id));

const rpc = (fn: string, args: Record<string, unknown>) => must(db().rpc(fn, args));
/** a whole shift a manager reports (Israeli date + times; an out before the in = the next day) */
export const shiftMoments = (date: string, inT: string, outT: string) => {
  const a = israelToIso(date, inT);
  const b = israelToIso(outT <= inT ? addDay(date) : date, outT);
  return { in: a, out: b };
};
export const entryAdd = (employeeId: string, inIso: string, outIso: string, reason: string, id = uuid()) =>
  rpc('att_entry_add', { p_id: id, p_employee: employeeId, p_in: inIso, p_out: outIso, p_reason: reason });
export const entryFix = (entryId: string, inIso: string, outIso: string, reason: string, newId = uuid()) =>
  rpc('att_entry_fix', { p_entry: entryId, p_new_id: newId, p_in: inIso, p_out: outIso, p_reason: reason, p_method: 'manual' });
export const entryClose = (entryId: string, outIso: string, reason: string) => rpc('att_entry_close', { p_entry: entryId, p_out: outIso, p_reason: reason, p_method: 'manual' });
export const entryVoid = (entryId: string, reason: string) => rpc('att_entry_void', { p_entry: entryId, p_reason: reason });
export const requestDecide = (id: string, approve: boolean, note: string) => rpc('att_request_decide', { p_request: id, p_approve: approve, p_note: note });
export const absenceAdd = (a: { employeeId: string; kind: AbsenceKind; from: string; to: string; minutes: number | null; note: string; file: string }, id = uuid()) =>
  rpc('att_absence_add', { p_id: id, p_employee: a.employeeId, p_kind: a.kind, p_from: a.from, p_to: a.to, p_minutes: a.minutes, p_note: a.note, p_file: a.file });
export const absenceDecide = (id: string, status: 'approved' | 'rejected' | 'cancelled', note: string) => rpc('att_absence_decide', { p_id: id, p_status: status, p_note: note });
export const monthMark = (employeeId: string, month: string, kind: 'approved' | 'closed' | 'reopened', reason = '') =>
  rpc('att_month_mark', { p_employee: employeeId, p_month: month, p_kind: kind, p_reason: reason });

/** a sick note → the private bucket, in the business's folder (the database checks the folder too) */
export async function uploadAbsenceFile(businessId: string, employeeId: string, file: File): Promise<string> {
  const ext = (file.name.split('.').pop() ?? 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'pdf';
  const path = `${businessId}/${employeeId}/${uuid()}.${ext}`;
  const { error } = await db().storage.from('attendance-files').upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw error;
  return path;
}
export async function absenceFileUrl(path: string): Promise<string | null> {
  const { data } = await db().storage.from('attendance-files').createSignedUrl(path, 300);
  return data?.signedUrl ?? null;
}
