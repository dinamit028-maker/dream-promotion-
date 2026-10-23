import { AttendanceLayout } from '@/features/attendance/AttendanceLayout';

/** every screen of "נוכחות ועובדים" (2.107): readiness, the caller's part and the business's people (AttendanceLayout) */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AttendanceLayout>{children}</AttendanceLayout>;
}
