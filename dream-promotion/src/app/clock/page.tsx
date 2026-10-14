import { Shell } from '@/features/timeclock/ClockView';
import { LINK_NOT_VALID } from '@/features/timeclock/clock-app';

/** /clock without the personal part (a cut link): the clock's message — not Dream's "page not found", whose links lead to the sign-in */
export default function ClockWithoutLink() {
  return <Shell><p className="mt-10 text-center text-ink-2">{LINK_NOT_VALID}</p></Shell>;
}
