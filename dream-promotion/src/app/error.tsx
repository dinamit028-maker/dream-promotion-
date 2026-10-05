'use client';
import { useEffect } from 'react';
import { ErrorScreen } from '@/components/system/ErrorScreen';

/** a public page (document, quote, booking, sign-in) failed: a Hebrew message instead of a white page */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <ErrorScreen reset={reset} home="/" homeLabel="לדף הראשי" />;
}
