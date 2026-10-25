/**
 * The attendance functions of migration 5800 (2.107) for the in-memory Supabase of the browser tests (fake-supabase.ts) — and the
 * employee's clock API (/api/clock/<token>) as the server answers it. The rules themselves are tested on Postgres
 * (tests/sql/attendance-core.check.sql, attendance-compare.sh); this mirrors them so the real screens run end to end:
 * a reason always, nothing in the future, no two entries at once (an open one runs until now), a correction = the old entry voided +
 * a new one that replaces it, a closed month refuses everything, a month closes only after it ended and with nothing open or
 * waiting in it; every insert / clock-out / void in time_entry_events.
 */
import { randomUUID } from 'node:crypto';

type Row = Record<string, any>;
export interface AttFake { tables: Record<string, Row[]>; opts: { businessId: string; userId: string } }
const t = (f: AttFake, name: string) => (f.tables[name] ||= []);
const ok = (body: any) => ({ status: 200, body });
const no = (message: string, code = 'P0001') => ({ status: 400, body: { code, message, details: null, hint: null } });
const il = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
const monthOf = (iso: string) => il(iso).slice(0, 7);

/** every write of the hours leaves its line (z_att_entry_log) */
export function attEvent(f: AttFake, e: Row, kind: string, before: Row | null, reason: string, channel: 'app' | 'clock') {
  const view = (x: Row | null) => (x ? { clock_in: x.clock_in, clock_out: x.clock_out, method: x.method, out_method: x.out_method, replaces: x.replaces ?? null,
    voided_at: x.voided_at ?? null, void_reason: x.void_reason ?? '' } : {});
  t(f, 'time_entry_events').push({ id: randomUUID(), business_id: e.business_id, employee_id: e.employee_id, entry_id: e.id, at: new Date(Date.now() + t(f, 'time_entry_events').length).toISOString(),
    actor: channel === 'app' ? f.opts.userId : null, actor_name: channel === 'app' ? 'רונית הבעלים' : '', channel, kind, before: view(before), after: view(e), reason });
}

const closed = (f: AttFake, emp: string, iso: string | null) => Boolean(iso) && t(f, 'attendance_months').some((m) => m.employee_id === emp && m.month === monthOf(iso!) && m.status === 'closed');
const overlaps = (f: AttFake, emp: string, a: string, b: string | null, except?: string) => t(f, 'time_entries').some((x) => x.employee_id === emp && !x.voided_at && x.id !== except
  && +new Date(x.clock_in) < (b ? +new Date(b) : Infinity) && +new Date(a) < (x.clock_out ? +new Date(x.clock_out) : Math.max(Date.now(), +new Date(x.clock_in) + 1000)));
const reason = (r: unknown) => (typeof r === 'string' && r.trim().length >= 2 ? r.trim().slice(0, 300) : null);

export function attendanceRpc(f: AttFake & { attendanceRole?: string }, fn: string, a: any): { status: number; body: any } | null {
  if (!fn.startsWith('att_')) return null;
  const now = Date.now();
  const entries = t(f, 'time_entries');
  const insertEntry = (r: Row, why: string) => {
    const e = { id: r.id ?? randomUUID(), user_id: f.opts.userId, business_id: f.opts.businessId, source: 'manual', edited: true, note: why, created_at: new Date().toISOString(),
      created_by: f.opts.userId, voided_at: null, voided_by: null, void_reason: '', replaces: null, in_lat: null, in_lng: null, out_lat: null, out_lng: null, ...r };
    entries.push(e); attEvent(f, e, e.replaces ? 'replacement' : 'created', null, why, 'app'); return e;
  };
  switch (fn) {
    case 'att_role': return ok(f.attendanceRole ?? 'admin');
    case 'att_entry_add': {
      const why = reason(a.p_reason); if (!why) return no('att: a reason is required', '22023');
      const hit = entries.find((x) => x.id === a.p_id); if (hit) return ok(hit.id);
      if (!a.p_in || !a.p_out || a.p_out <= a.p_in) return no('att: a shift has its clock-in and its clock-out', '22023');
      if (+new Date(a.p_out) > now + 5 * 60_000) return no('att: a shift in the future', '22023');
      if (closed(f, a.p_employee, a.p_in) || closed(f, a.p_employee, a.p_out)) return no('att: the month is closed', '23514');
      if (overlaps(f, a.p_employee, a.p_in, a.p_out)) return no('att: overlaps another entry of this employee', '23P01');
      insertEntry({ id: a.p_id, employee_id: a.p_employee, clock_in: new Date(a.p_in).toISOString(), clock_out: new Date(a.p_out).toISOString(), method: 'manual', out_method: 'manual' }, why);
      return ok(a.p_id);
    }
    case 'att_entry_fix': {
      const why = reason(a.p_reason); if (!why) return no('att: a reason is required', '22023');
      const e = entries.find((x) => x.id === a.p_entry); if (!e) return no('not allowed', '42501');
      if (entries.some((x) => x.id === a.p_new_id && x.replaces === e.id)) return ok(a.p_new_id);
      if (e.voided_at) return no('att: the entry was already corrected or voided', '23514');
      if (!a.p_in || !a.p_out || a.p_out <= a.p_in) return no('att: a shift has its clock-in and its clock-out', '22023');
      if (+new Date(a.p_out) > now + 5 * 60_000) return no('att: a shift in the future', '22023');
      if (closed(f, e.employee_id, e.clock_in) || closed(f, e.employee_id, a.p_in)) return no('att: the month is closed', '23514');
      if (overlaps(f, e.employee_id, a.p_in, a.p_out, e.id)) return no('att: overlaps another entry of this employee', '23P01');
      const before = { ...e };
      Object.assign(e, { voided_at: new Date().toISOString(), voided_by: f.opts.userId, void_reason: why, clock_out: e.clock_out ?? new Date(Math.max(now, +new Date(e.clock_in) + 1000)).toISOString() });
      attEvent(f, e, 'voided', before, why, 'app');
      const sameIn = new Date(a.p_in).toISOString() === e.clock_in, sameOut = before.clock_out && new Date(a.p_out).toISOString() === before.clock_out;
      insertEntry({ id: a.p_new_id, employee_id: e.employee_id, clock_in: new Date(a.p_in).toISOString(), clock_out: new Date(a.p_out).toISOString(), replaces: e.id,
        method: sameIn ? e.method : a.p_method ?? 'manual', out_method: sameOut ? e.out_method ?? e.method : a.p_method ?? 'manual',
        in_lat: sameIn ? e.in_lat : null, in_lng: sameIn ? e.in_lng : null, out_lat: sameOut ? e.out_lat : null, out_lng: sameOut ? e.out_lng : null }, why);
      return ok(a.p_new_id);
    }
    case 'att_entry_close': {
      const why = reason(a.p_reason); if (!why) return no('att: a reason is required', '22023');
      const e = entries.find((x) => x.id === a.p_entry); if (!e) return no('not allowed', '42501');
      if (e.voided_at || e.clock_out) return no('att: the shift is not open', '23514');
      if (!a.p_out || a.p_out <= e.clock_in || +new Date(a.p_out) > now + 5 * 60_000) return no('att: the clock-out is after the clock-in, not in the future', '22023');
      if (closed(f, e.employee_id, e.clock_in)) return no('att: the month is closed', '23514');
      const before = { ...e };
      Object.assign(e, { clock_out: new Date(a.p_out).toISOString(), out_method: a.p_method ?? 'manual', edited: true, note: e.note ? `${e.note} · ${why}` : why });
      attEvent(f, e, 'clock_out', before, why, 'app');
      return ok(e.id);
    }
    case 'att_entry_void': {
      const why = reason(a.p_reason); if (!why) return no('att: a reason is required', '22023');
      const e = entries.find((x) => x.id === a.p_entry); if (!e) return no('not allowed', '42501');
      if (e.voided_at) return ok(e.id);
      if (closed(f, e.employee_id, e.clock_in)) return no('att: the month is closed', '23514');
      const before = { ...e };
      Object.assign(e, { voided_at: new Date().toISOString(), voided_by: f.opts.userId, void_reason: why, clock_out: e.clock_out ?? new Date(Math.max(now, +new Date(e.clock_in) + 1000)).toISOString() });
      attEvent(f, e, 'voided', before, why, 'app');
      return ok(e.id);
    }
    case 'att_request_decide': {
      const r = t(f, 'time_requests').find((x) => x.id === a.p_request); if (!r) return no('not allowed', '42501');
      if (r.status !== 'pending') return no('att: the request was already decided', '23514');
      let res: string | null = null;
      if (a.p_approve) {
        const why = `בקשת העובד/ת${r.note ? `: ${r.note}` : ''}`;
        if (r.kind === 'missing_out') { const x = attendanceRpc(f, 'att_entry_close', { p_entry: r.entry_id, p_out: r.clock_out, p_reason: why, p_method: 'request' })!; if (x.status !== 200) return x; res = r.entry_id; }
        else if (r.kind === 'fix') { const x = attendanceRpc(f, 'att_entry_fix', { p_entry: r.entry_id, p_new_id: randomUUID(), p_in: r.clock_in, p_out: r.clock_out, p_reason: why, p_method: 'request' })!; if (x.status !== 200) return x; res = x.body; }
        else {
          if (closed(f, r.employee_id, r.clock_in)) return no('att: the month is closed', '23514');
          if (overlaps(f, r.employee_id, r.clock_in, r.clock_out)) return no('att: overlaps another entry of this employee', '23P01');
          res = insertEntry({ employee_id: r.employee_id, clock_in: r.clock_in, clock_out: r.clock_out, method: 'request', out_method: 'request' }, why).id;
        }
      } else if (!reason(a.p_note)) return no('att: a reason is required', '22023');
      Object.assign(r, { status: a.p_approve ? 'approved' : 'rejected', decided_by: f.opts.userId, decided_at: new Date().toISOString(), decision_note: (a.p_note ?? '').trim(), result_entry_id: res });
      return ok(res);
    }
    case 'att_absence_add': {
      const list = t(f, 'absences');
      if (list.some((x) => x.id === a.p_id)) return ok(a.p_id);
      if (t(f, 'attendance_months').some((m) => m.employee_id === a.p_employee && m.status === 'closed' && m.month >= String(a.p_from).slice(0, 7) && m.month <= String(a.p_to ?? a.p_from).slice(0, 7))) return no('att: the month is closed', '23514');
      list.push({ id: a.p_id, business_id: f.opts.businessId, employee_id: a.p_employee, kind: a.p_kind, from_day: a.p_from, to_day: a.p_to ?? a.p_from, minutes: a.p_minutes ?? null,
        note: a.p_note ?? '', file_path: a.p_file ?? '', status: 'approved', requested_by: 'manager', decided_by: f.opts.userId, decided_at: new Date().toISOString(), decision_note: '',
        created_by: f.opts.userId, created_at: new Date().toISOString() });
      return ok(a.p_id);
    }
    case 'att_absence_decide': {
      const x = t(f, 'absences').find((r) => r.id === a.p_id); if (!x) return no('not allowed', '42501');
      if ((a.p_status === 'rejected' || a.p_status === 'cancelled') && !reason(a.p_note)) return no('att: a reason is required', '22023');
      if ((a.p_status === 'approved' || a.p_status === 'rejected') && x.status !== 'pending') return no('att: the absence was already decided', '23514');
      Object.assign(x, { status: a.p_status, decided_by: f.opts.userId, decided_at: new Date().toISOString(), decision_note: (a.p_note ?? '').trim() });
      return ok(x.id);
    }
    case 'att_month_mark': {
      const months = t(f, 'attendance_months');
      const m = months.find((x) => x.employee_id === a.p_employee && x.month === a.p_month);
      const cur = m?.status ?? 'open';
      const today = il(new Date().toISOString());
      const why = a.p_kind === 'reopened' ? reason(a.p_reason) : '';
      let snap: Row | null = null;
      if (a.p_kind === 'approved') { if (cur === 'closed') return no('att: the month is closed', '23514'); if (cur === 'approved') return ok(cur); }
      else if (a.p_kind === 'closed') {
        if (cur === 'closed') return ok(cur);
        if (a.p_month >= today.slice(0, 7)) return no('att: a month closes after it ended', '23514');
        if (entries.some((x) => x.employee_id === a.p_employee && !x.voided_at && !x.clock_out && monthOf(x.clock_in) <= a.p_month)) return no('att: an open shift (no clock-out) — close it first', '23514');
        if (t(f, 'time_requests').some((q) => q.employee_id === a.p_employee && q.status === 'pending' && monthOf(q.clock_in ?? entries.find((x) => x.id === q.entry_id)?.clock_in ?? '') === a.p_month)) return no('att: a request is waiting in this month', '23514');
        if (t(f, 'absences').some((x) => x.employee_id === a.p_employee && x.status === 'pending' && x.from_day.slice(0, 7) <= a.p_month && x.to_day.slice(0, 7) >= a.p_month)) return no('att: an absence is waiting in this month', '23514');
        const emp = t(f, 'employees').find((e) => e.id === a.p_employee);
        const track = t(f, 'work_tracks').find((x) => x.id === emp?.track_id);
        if (!track) return no('att: the hours track of the employee is not set', '23514');
        snap = { ...track };
      } else if (a.p_kind === 'reopened') { if (!why) return no('att: a reason is required', '22023'); if (cur !== 'closed') return ok(cur); }
      const status = a.p_kind === 'reopened' ? 'open' : a.p_kind;
      const rules_snapshot = a.p_kind === 'closed' ? snap : a.p_kind === 'reopened' ? null : m?.rules_snapshot ?? null;
      if (m) Object.assign(m, { status, rules_snapshot, updated_at: new Date().toISOString() });
      else months.push({ employee_id: a.p_employee, month: a.p_month, business_id: f.opts.businessId, status, rules_snapshot, updated_at: new Date().toISOString() });
      t(f, 'attendance_month_events').push({ id: randomUUID(), business_id: f.opts.businessId, employee_id: a.p_employee, month: a.p_month, kind: a.p_kind, reason: why || '',
        actor: f.opts.userId, actor_name: 'רונית הבעלים', at: new Date(Date.now() + t(f, 'attendance_month_events').length).toISOString() });
      return ok(status);
    }
    default: return no(`Could not find the function public.${fn}`, 'PGRST202');
  }
}

/** /api/clock/<token> as the server answers it (src/app/api/clock/[token]/route.ts — its rules: tests/clock-api.test.ts) */
export function clockApi(f: AttFake, token: string, method: string, body: any): { status: number; json: any } {
  const emp = t(f, 'employees').find((e) => e.token === token);
  if (!emp) return { status: 404, json: { code: 'not_found', message: 'הקישור לא תקין, בקש קישור חדש מהמנהל' } };
  const mine = () => t(f, 'time_entries').filter((x) => x.employee_id === emp.id && !x.voided_at).sort((a, b) => (a.clock_in < b.clock_in ? 1 : -1));
  const state = () => {
    const open = mine().find((x) => !x.clock_out);
    return { name: emp.name, business: 'מסעדת הים', active: emp.active, requireScan: false, needsLocation: false, siteOk: true, openSince: open?.clock_in ?? null,
      todayMinutes: 0, recent: mine().filter((x) => x.clock_out).slice(0, 5).map((x) => ({ in: x.clock_in, out: x.clock_out })) };
  };
  if (method === 'GET') return { status: 200, json: state() };
  const open = mine().find((x) => !x.clock_out);
  const at = new Date().toISOString();
  if (body.action === 'in') {
    if (open) return { status: 409, json: { code: 'already_in', message: 'כבר במשמרת', ...state() } };
    const e = { id: randomUUID(), user_id: f.opts.userId, business_id: f.opts.businessId, employee_id: emp.id, clock_in: at, clock_out: null, source: 'self', method: 'link', out_method: null,
      in_lat: body.lat ?? null, in_lng: body.lng ?? null, out_lat: null, out_lng: null, edited: false, note: '', voided_at: null, void_reason: '', replaces: null, created_at: at };
    t(f, 'time_entries').push(e); attEvent(f, e, 'created', null, '', 'clock'); emp.last_active_at = at;
  } else if (body.action === 'out') {
    if (!open) return { status: 409, json: { code: 'not_in', message: 'אין משמרת פתוחה', ...state() } };
    const before = { ...open };
    Object.assign(open, { clock_out: at, out_method: open.method, out_lat: body.lat ?? null, out_lng: body.lng ?? null });
    attEvent(f, open, 'clock_out', before, '', 'clock'); emp.last_active_at = at;
  }
  return { status: 200, json: { ok: true, at, ...state() } };
}

/** the tables of 5800: before it they are missing; after it, the hours and their history are written by the functions only */
export const ATT_TABLES = ['departments', 'work_tracks', 'employee_private', 'attendance_approvers', 'time_requests', 'absences', 'attendance_months', 'attendance_month_events', 'time_entry_events'];
export const ATT_FUNCTION_ONLY = ['time_entries', 'time_requests', 'absences', 'attendance_months', 'attendance_month_events', 'time_entry_events'];

/** the columns' defaults of 5800 (the fake keeps what is sent; the database fills the rest) */
const DEFAULTS: Record<string, Row> = {
  departments: { active: true },
  work_tracks: { active: true, start_time: null, late_grace_min: 0, auto_break_min: 0, auto_break_after_min: 0, ot_mode: 'daily', monthly_minutes: null,
    monthly_tier1_minutes: null, tier1_minutes: 120, tier1_pct: 125, tier2_pct: 150, rest_weekday: 6, rest_pct: 150, rest_tier1_pct: 175, rest_tier2_pct: 200,
    festival_pct: 150, independence_rest: true, independence_pct: 200, eve_minutes: null },
  attendance_approvers: { active: true },
  employees: { active: true, employee_code: '', title: '', department_id: null, track_id: null, start_date: null, end_date: null, last_active_at: null, invited_at: null },
  employee_private: { id_number: '', pay_kind: '', hourly_agorot: null, monthly_agorot: null },
};
export function attDefaults(table: string, r: Row) {
  for (const [k, v] of Object.entries(DEFAULTS[table] ?? {})) if (r[k] === undefined) r[k] = v;
}

// ---- 2.108 (5900): טופס 101 — what the database does (tests/sql/form101.check.sql checks the real one) ----------------------------
export const F101_TABLES = ['form101_requests', 'form101_submissions'];
/** before insert: the defaults; a submission only on an open link, its version from the database */
export function form101Insert(f: AttFake, table: string, r: Row): string | null {
  if (table === 'form101_requests') { r.status ??= 'sent'; r.kind ??= 'year'; r.opened_at ??= null; r.done_at ??= null; return null; }
  if (table !== 'form101_submissions') return null;
  const q = t(f, 'form101_requests').find((x) => x.id === r.request_id);
  if (!q || !['sent', 'opened'].includes(q.status) || !(Date.parse(q.expires_at) > Date.now())) return 'form101: the link is no longer valid';
  r.version = 1 + Math.max(0, ...t(f, 'form101_submissions').filter((s) => s.employee_id === r.employee_id && s.tax_year === r.tax_year).map((s) => s.version));
  Object.assign(r, { submitted_at: new Date().toISOString(), paper_path: null, paper_at: null, paper_by: null, reviewed_at: null, reviewed_by: null, review_note: r.review_note ?? '' });
  return null;
}
export function form101AfterInsert(f: AttFake, table: string, r: Row) {
  if (table !== 'form101_submissions') return;
  const q = t(f, 'form101_requests').find((x) => x.id === r.request_id);
  if (q) Object.assign(q, { status: 'submitted', done_at: new Date().toISOString() });
}
/** before update: a link only moves forward; a signed form is never changed — the paper and the review once each */
export function form101Update(table: string, old: Row, patch: Row): string | null {
  if (table === 'form101_requests') {
    if (['submitted', 'cancelled', 'expired'].includes(old.status) && patch.status && patch.status !== old.status) return 'form101: the link is closed';
    if (patch.status === 'opened' && old.status === 'sent') patch.opened_at = new Date().toISOString();
    if (['cancelled', 'expired'].includes(patch.status)) patch.done_at = new Date().toISOString();
    return null;
  }
  if (table !== 'form101_submissions') return null;
  const allowed = ['paper_path', 'paper_at', 'paper_by', 'reviewed_at', 'reviewed_by', 'review_note'];
  if (Object.keys(patch).some((k) => !allowed.includes(k))) return 'form101: a signed form is never changed — send a new one';
  if (old.paper_path && 'paper_path' in patch) return 'form101: the signed paper was already received';
  if (old.reviewed_at && 'reviewed_at' in patch) return 'form101: already reviewed';
  if (patch.paper_path) patch.paper_at = new Date().toISOString();
  return null;
}
