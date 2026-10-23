import { Buildings, ChartBar, CheckSquareOffset, ClipboardText, GearSix, House, IdentificationBadge, Plus, UsersThree, Clock } from '@/components/ui/Icon';
import type { ModuleConfig } from '@/components/shell/module-nav';
import { attendanceHref } from './routes';

/**
 * "נוכחות ועובדים" as an app of its own (2.107, ModuleShell): the menus of the reference — the companies (employees, departments,
 * approvers), the reports (approvals, absences), the reports and exports, and the settings. Every screen of routes.ts is in the
 * menu exactly once (tests/attendance-module.test.ts keeps it so).
 */
export const ATTENDANCE_MODULE: ModuleConfig = {
  id: 'attendance',
  name: 'נוכחות ועובדים',
  theme: 'module-attendance',
  home: attendanceHref('dashboard'),
  Icon: IdentificationBadge,
  groups: [
    { id: 'dashboard', label: 'לוח בקרה', Icon: House, links: [{ href: attendanceHref('dashboard'), label: 'לוח בקרה', Icon: House }] },
    { id: 'company', label: 'עובדים ומחלקות', Icon: UsersThree, links: [
      { href: attendanceHref('employees'), label: 'עובדים', Icon: UsersThree },
      { href: attendanceHref('departments'), label: 'מחלקות ומאשרים', Icon: Buildings },
    ] },
    { id: 'reports', label: 'דיווחים', Icon: ClipboardText, links: [
      { href: attendanceHref('approvals'), label: 'אישור דיווחים', Icon: CheckSquareOffset },
      { href: attendanceHref('absences'), label: 'היעדרויות', Icon: ClipboardText },
    ] },
    { id: 'exports', label: 'דוחות וייצוא', Icon: ChartBar, links: [{ href: attendanceHref('reports'), label: 'דוחות וייצוא', Icon: ChartBar }] },
    { id: 'settings', label: 'הגדרות', Icon: GearSix, links: [{ href: attendanceHref('settings'), label: 'הגדרות', Icon: GearSix }] },
  ],
  tabs: [
    { href: attendanceHref('dashboard'), label: 'בקרה', Icon: House },
    { href: attendanceHref('employees'), label: 'עובדים', Icon: UsersThree },
    { href: attendanceHref('approvals'), label: 'אישורים', Icon: CheckSquareOffset },
    { href: attendanceHref('reports'), label: 'דוחות', Icon: ChartBar },
  ],
  actions: [
    { id: 'employee', label: 'הוספת עובד/ת', Icon: Plus, href: attendanceHref('employees', { new: '1' }) },
    { id: 'shift', label: 'דיווח שעות', Icon: Clock, href: attendanceHref('dashboard', { report: '1' }) },
    { id: 'absence', label: 'רישום היעדרות', Icon: ClipboardText, href: attendanceHref('absences', { new: '1' }) },
  ],
};
