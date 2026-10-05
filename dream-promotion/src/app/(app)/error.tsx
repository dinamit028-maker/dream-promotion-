'use client';
import { useEffect } from 'react';
import { ErrorScreen } from '@/components/system/ErrorScreen';

/** a screen of the app failed: the menus stay, the screen says so in Hebrew (never a white page) */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <ErrorScreen reset={reset} />;
}
