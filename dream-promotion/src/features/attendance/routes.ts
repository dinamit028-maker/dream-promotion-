/**
 * The attendance module's addresses ("נוכחות ועובדים", 2.107). Pure: the shell decides by them whether the module opens as an app
 * of its own (ModuleShell), and a business that bought attendance only is kept inside them (AppShell, attendanceOnly).
 */
export type AttendanceSection = 'dashboard' | 'employees' | 'departments' | 'approvals' | 'absences' | 'reports' | 'settings';
export const ATTENDANCE_SECTIONS: readonly { id: AttendanceSection; path: string; label: string }[] = [
  { id: 'dashboard', path: '/attendance', label: 'לוח בקרה' },
  { id: 'employees', path: '/attendance/employees', label: 'עובדים' },
  { id: 'departments', path: '/attendance/departments', label: 'מחלקות ומאשרים' },
  { id: 'approvals', path: '/attendance/approvals', label: 'אישור דיווחים' },
  { id: 'absences', path: '/attendance/absences', label: 'היעדרויות' },
  { id: 'reports', path: '/attendance/reports', label: 'דוחות וייצוא' },
  { id: 'settings', path: '/attendance/settings', label: 'הגדרות' },
];
const trim = (p: string) => p.replace(/\/+$/, '') || '/';
/** /attendance and everything under it */
export const isAttendancePath = (pathname: string) => { const p = trim(pathname); return p === '/attendance' || p.startsWith('/attendance/'); };
export function attendanceHref(section: AttendanceSection, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `${ATTENDANCE_SECTIONS.find((s) => s.id === section)?.path ?? '/attendance'}${q ? `?${q}` : ''}`;
}
/** one employee's monthly report ("YYYY-MM"; none = this month) */
export const employeeMonthHref = (id: string, month?: string) =>
  `/attendance/employees/${encodeURIComponent(id)}${month ? `?month=${encodeURIComponent(month)}` : ''}`;
/** a business with attendance only: where any other address of the app goes (the module's home) */
export const attendanceOnlyTarget = (pathname: string) => (isAttendancePath(pathname) ? null : '/attendance');
