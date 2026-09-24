'use client';
import { useEffect } from 'react';

const MINE = process.env.NEXT_PUBLIC_BUILD_ID;

/**
 * After a new deploy, every open tab quietly reloads to the new version —
 * on load, when the tab regains focus, and every 5 minutes. No manual refresh or incognito needed.
 */
export function VersionWatcher() {
  useEffect(() => {
    let stop = false;
    async function check() {
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        const { build } = await r.json();
        if (stop || !build || !MINE || build === MINE) return;
        // guard against a reload loop if the edge is briefly serving mixed builds
        const key = `dp-reloaded-${build}`;
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');
        location.reload();
      } catch { /* offline — try again later */ }
    }
    check();
    const onFocus = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onFocus);
    const t = setInterval(check, 5 * 60 * 1000);
    return () => { stop = true; clearInterval(t); document.removeEventListener('visibilitychange', onFocus); };
  }, []);
  return null;
}
