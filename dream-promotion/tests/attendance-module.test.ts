import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTENDANCE_MODULE } from '../src/features/attendance/module';
import { ATTENDANCE_SECTIONS, attendanceHref, attendanceOnlyTarget, employeeMonthHref, isAttendancePath } from '../src/features/attendance/routes';
import { appEntries } from '../src/components/shell/menu-search';

test('attendance module: every screen in the menu exactly once, and nothing else', () => {
  const links = ATTENDANCE_MODULE.groups.flatMap((g) => g.links.map((l) => l.href));
  assert.equal(new Set(links).size, links.length, 'once');
  assert.deepEqual([...links].sort(), ATTENDANCE_SECTIONS.map((s) => s.path).sort());
  for (const t of ATTENDANCE_MODULE.tabs) assert.ok(links.includes(t.href), t.href);
  for (const a of ATTENDANCE_MODULE.actions) assert.ok(isAttendancePath(a.href.split('?')[0]), a.href);
  assert.equal(ATTENDANCE_MODULE.home, '/attendance');
});

test('attendance module: its addresses, and a business with attendance only is kept inside them', () => {
  assert.ok(isAttendancePath('/attendance')); assert.ok(isAttendancePath('/attendance/employees/x')); assert.ok(isAttendancePath('/attendance/'));
  assert.ok(!isAttendancePath('/attendances')); assert.ok(!isAttendancePath('/dashboard'));
  assert.equal(attendanceHref('employees', { new: '1' }), '/attendance/employees?new=1');
  assert.equal(employeeMonthHref('a b', '2026-09'), '/attendance/employees/a%20b?month=2026-09');
  assert.equal(attendanceOnlyTarget('/dashboard'), '/attendance');
  assert.equal(attendanceOnlyTarget('/onboarding'), '/attendance');
  assert.equal(attendanceOnlyTarget('/finance/documents'), '/attendance');
  assert.equal(attendanceOnlyTarget('/attendance/reports'), null);
});

test('attendance module: its screens are found by the menu search, with the words people use', () => {
  const e = appEntries();
  for (const s of ATTENDANCE_SECTIONS) assert.ok(e.some((x) => x.href === s.path), s.path);
  assert.ok(e.find((x) => x.href === '/attendance/absences')!.keywords.includes('מחלה'));
  assert.ok(e.find((x) => x.href === '/attendance/reports')!.keywords.includes('שכר'));
});
