'use client';
import Link from 'next/link';

/**
 * What a screen shows when it fails instead of a white page (error.tsx of the app and of the public pages): what happened in
 * Hebrew, that nothing saved was lost, "try again" (the screen only) and "reload" (the whole page — after a deploy, an old
 * tab may miss the new version's files). The technical detail stays in the browser console, never on the screen.
 */
export function ErrorScreen({ reset, home = '/dashboard', homeLabel = 'למסך הבית' }: { reset?: () => void; home?: string; homeLabel?: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4" dir="rtl">
      <div role="alert" className="w-full max-w-md rounded-xl border border-line bg-surface p-6 text-center shadow-sm">
        <h1 className="font-display text-xl font-bold">משהו השתבש במסך הזה</h1>
        <p className="mt-2 text-muted">המסך לא נטען כמו שצריך. מה שכבר נשמר — נשמר ולא נמחק. אפשר לנסות שוב, או לרענן את הדף.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {reset && <button type="button" onClick={reset} className="min-h-11 rounded-full bg-primary px-5 font-semibold text-white">לנסות שוב</button>}
          <button type="button" onClick={() => window.location.reload()} className="min-h-11 rounded-full border border-line px-5 font-semibold">רענון הדף</button>
          <Link href={home} className="inline-flex min-h-11 items-center rounded-full px-4 font-semibold text-muted">{homeLabel}</Link>
        </div>
      </div>
    </div>
  );
}
