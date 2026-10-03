import { ClockView } from '@/features/timeclock/ClockView';

/** The employee's personal link: opening it once connects this phone to the employee's clock. */
export default function ClockPage({ params }: { params: { token: string } }) {
  return <ClockView token={params.token} register />;
}
