'use client';
import { useEffect, useState } from 'react';

const MINE = process.env.NEXT_PUBLIC_BUILD_ID;
/** right after the page opens nothing was typed yet — a reload there loses nothing */
const QUIET_MS = 8_000;

/**
 * After a new deploy, an open tab moves to the new version without a manual refresh or incognito:
 *  - right after the page opens: it reloads by itself (nothing was typed yet);
 *  - later (the tab regains focus, or every 5 minutes): it never reloads by itself — a cart in the register, a document
 *    being written or a dialog would be lost — it shows a bar "יש גרסה חדשה" and the user updates when ready.
 */
export function VersionWatcher() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stop = false;
    const opened = Date.now();
    async function check() {
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        const { build } = await r.json();
        if (stop || !build || !MINE || build === MINE) return;
        // guard against a reload loop if the edge is briefly serving mixed builds
        const key = `dp-reloaded-${build}`;
        let seen = false;
        try { seen = Boolean(sessionStorage.getItem(key)); } catch { /* private mode */ }
        if (!seen && Date.now() - opened < QUIET_MS) {
          try { sessionStorage.setItem(key, '1'); } catch { /* private mode */ }
          location.reload();
          return;
        }
        setReady(true);
      } catch { /* offline — try again later */ }
    }
    check();
    const onFocus = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onFocus);
    const t = setInterval(check, 5 * 60 * 1000);
    return () => { stop = true; clearInterval(t); document.removeEventListener('visibilitychange', onFocus); };
  }, []);
  if (!ready) return null;
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-200 flex justify-center px-3 pt-[max(env(safe-area-inset-top),8px)] print:hidden">
      <div className="flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-2 text-sm shadow-lg">
        <span className="font-semibold">יש גרסה חדשה של האפליקציה.</span>
        <span className="text-muted">כדאי לעדכן אחרי שמסיימים את מה שפתוח.</span>
        <button type="button" onClick={() => location.reload()} className="min-h-11 rounded-full bg-primary px-4 font-semibold text-white">עדכון עכשיו</button>
        <button type="button" onClick={() => setReady(false)} className="min-h-11 rounded-full px-3 font-semibold text-muted">אחר כך</button>
      </div>
    </div>
  );
}
