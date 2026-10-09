import { ClockView } from '@/features/timeclock/ClockView';

/** The employee's personal link: opening it once connects this phone to the employee's clock. */
export default async function ClockPage(props: { params: Promise<{ token: string }> }) {
  const params = await props.params;   // Next 15: a page's params arrive as a promise
  return <ClockView token={params.token} register />;
}
