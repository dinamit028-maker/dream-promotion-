import { clockMetadata } from '@/features/timeclock/clock-app';

/** The employee's clock is not Dream: never Dream's manifest (its icon opened Dream's sign-in), the clock's own name. */
export const metadata = clockMetadata;

export default function ClockLayout({ children }: { children: React.ReactNode }) {
  return children;
}
