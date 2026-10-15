import { clockMetadata } from '@/features/timeclock/clock-app';

/** The business's QR (/c/<site>) opens the employee's clock — the same app as /clock, never Dream's. */
export const metadata = clockMetadata;

export default function ScanLayout({ children }: { children: React.ReactNode }) {
  return children;
}
