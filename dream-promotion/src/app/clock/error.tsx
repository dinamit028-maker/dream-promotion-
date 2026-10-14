'use client';
import { useEffect } from 'react';
import { ErrorScreen } from '@/components/system/ErrorScreen';

/** the employee's clock failed: try again or reload — never a link into Dream (its home leads to the sign-in) */
export default function ClockError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <ErrorScreen reset={reset} home={null} />;
}
