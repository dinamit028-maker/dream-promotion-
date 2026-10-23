import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { attRoleOf } from '../src/lib/server/attendance';
import { clockRequestInput } from '../src/features/attendance/clock-request';

test('attendance server: the caller\'s part — the same as att_role() in the database', () => {
  assert.equal(attRoleOf(null, true), 'admin');
  assert.equal(attRoleOf(null, false), 'none');
  assert.equal(attRoleOf({ role: 'owner', access: 'full' }, false), 'admin');
  assert.equal(attRoleOf({ role: 'editor', access: 'full' }, false), 'admin');
  assert.equal(attRoleOf({ role: 'viewer', access: 'full' }, false), 'viewer');
  assert.equal(attRoleOf({ role: 'editor', access: 'register' }, false), 'none');
  assert.equal(attRoleOf({ role: 'editor', access: 'full', attendance_role: 'approver' }, false), 'approver');
  assert.equal(attRoleOf({ role: 'viewer', access: 'full', attendance_role: 'payroll' }, false), 'payroll');
  assert.equal(attRoleOf({ role: 'owner', access: 'register', attendance_role: 'admin' }, false), 'none', 'a cashier never');
});

const ID = '11111111-2222-4333-8444-555555555555';
test('attendance server: what an employee may ask — only these fields and values', () => {
  const ok = clockRequestInput({ type: 'request', id: ID, kind: 'shift', clockIn: '2026-09-08T06:00:00Z', clockOut: '2026-09-08T12:00:00Z', note: 'שכחתי\nטלפון', extra: 'x' });
  assert.ok(ok.ok && ok.input.type === 'request' && ok.input.note === 'שכחתי טלפון' && !('extra' in ok.input));
  const out = clockRequestInput({ type: 'request', id: ID, kind: 'missing_out', entryId: ID, clockIn: '2026-09-08T06:00:00Z', clockOut: '2026-09-08T12:00:00Z' });
  assert.ok(out.ok && out.input.type === 'request' && out.input.clockIn === null, 'a missing clock-out carries the out only');
  assert.equal(clockRequestInput({ type: 'request', id: ID, kind: 'fix', clockIn: '2026-09-08T06:00:00Z', clockOut: '2026-09-08T12:00:00Z' }).ok, false, 'a fix names its entry');
  assert.equal(clockRequestInput({ type: 'request', id: ID, kind: 'shift', clockIn: '2026-09-08T12:00:00Z', clockOut: '2026-09-08T06:00:00Z' }).ok, false);
  assert.equal(clockRequestInput({ type: 'request', id: 'x', kind: 'shift', clockIn: '2026-09-08T06:00:00Z', clockOut: '2026-09-08T12:00:00Z' }).ok, false, 'an id');
  assert.equal(clockRequestInput({ type: 'request', id: ID, kind: 'delete' }).ok, false);
  const abs = clockRequestInput({ type: 'absence', id: ID, kind: 'sick', from: '2026-09-10', to: '2026-09-11' });
  assert.ok(abs.ok && abs.input.type === 'absence' && abs.input.minutes === null);
  assert.equal(clockRequestInput({ type: 'absence', id: ID, kind: 'sick', from: '2026-09-10', to: '2026-09-11', minutes: 60 }).ok, false, 'hours — one day');
  assert.equal(clockRequestInput({ type: 'absence', id: ID, kind: 'holiday', from: '2026-09-10' }).ok, false);
  assert.equal(clockRequestInput(null).ok, false);
});

const TOKEN = 'tok_ATTENDANCEREQUEST1234567890';
const tables: Record<string, any[]> = {
  employees: [{ id: 'e1', business_id: 'b1', active: true, token: TOKEN }, { id: 'e2', business_id: 'b1', active: false, token: 'tok_INACTIVEINACTIVEINACTIVE12' }],
  businesses: [{ id: 'b1', status: 'active', paid_until: null, grace_days: 0 }],
};
const calls: { fn: string; args: any }[] = [];
before(() => {
  // the database functions this route calls (their own rules: tests/sql/attendance-core.check.sql), as the client answers
  const db = fakeDb(tables);
  (globalThis as any).__DP_TEST_ADMIN_DB__ = { ...db, rpc: async (fn: string, a: any) => {
    calls.push({ fn, args: a });
    if (fn === 'att_request_create') return a.p_in < '2026-01-01' ? { data: null, error: { message: 'att: the month is closed' } } : { data: a.p_id, error: null };
    if (fn === 'att_absence_add') return { data: a.p_id, error: null };
    return { data: null, error: { message: `Could not find the function public.${fn}` } };
  } };
});
const ctx = (t = TOKEN) => ({ params: Promise.resolve({ token: t }) });
const post = (body: any) => new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 200)}` } });

test('attendance server: an employee\'s request from the personal link waits for a manager — nothing written into the hours', async () => {
  const r = await import('../src/app/api/clock/[token]/request/route');
  const ok = await r.POST(post({ type: 'request', id: ID, kind: 'shift', clockIn: '2026-09-08T06:00:00Z', clockOut: '2026-09-08T12:00:00Z', note: 'x' }), ctx());
  assert.equal(ok.status, 200);
  assert.deepEqual(calls[0], { fn: 'att_request_create', args: { p_id: ID, p_employee: 'e1', p_kind: 'shift', p_entry: null, p_in: '2026-09-08T06:00:00.000Z', p_out: '2026-09-08T12:00:00.000Z', p_note: 'x' } });
  const closed = await r.POST(post({ type: 'request', id: ID, kind: 'shift', clockIn: '2025-09-08T06:00:00Z', clockOut: '2025-09-08T12:00:00Z' }), ctx());
  assert.equal(closed.status, 409); assert.match((await closed.json()).message, /החודש כבר נסגר/);
  const abs = await r.POST(post({ type: 'absence', id: ID, kind: 'vacation', from: '2026-09-10', to: '2026-09-10' }), ctx());
  assert.equal(abs.status, 200); assert.equal(calls.at(-1)!.args.p_file, '', 'no file from the link (stage 2)');
  assert.equal((await r.POST(post({ type: 'request', id: ID }), ctx())).status, 400);
  assert.equal((await r.POST(post({ type: 'absence', id: ID, kind: 'vacation', from: '2026-09-10' }), ctx('tok_INACTIVEINACTIVEINACTIVE12'))).status, 403);
  assert.equal((await r.POST(post({}), ctx('tok_NOSUCHTOKENNOSUCHTOKEN1234'))).status, 404);
  assert.equal((tables.time_entries ?? []).length, 0, 'no hours');
});
