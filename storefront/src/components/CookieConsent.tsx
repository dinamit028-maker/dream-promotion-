'use client';
import { useEffect, useState } from 'react';

/**
 * Google Analytics only after the shopper agreed: no script, no cookie of Google before "אישור". "דחייה" is as easy as
 * "אישור", nothing is pre-checked, and the choice can be changed later from the footer. The choice is one first-party
 * cookie (sf_consent) for 180 days. Under the page's CSP ('strict-dynamic') a script this code adds is allowed.
 */
const COOKIE = 'sf_consent';
type Choice = 'analytics' | 'none';

function readChoice(): Choice | null {
  const m = document.cookie.match(/(?:^|;\s*)sf_consent=(analytics|none)/);
  return (m?.[1] as Choice) ?? null;
}
function saveChoice(c: Choice) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${c}; Max-Age=${180 * 24 * 3600}; Path=/; SameSite=Lax${secure}`;
}

declare global { interface Window { dataLayer?: unknown[]; gtag?: (...a: unknown[]) => void } }
let loaded = false;
function loadAnalytics(id: string) {
  if (loaded || !/^G-[A-Z0-9]{4,16}$/.test(id)) return;
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer!.push(arguments); }; // eslint-disable-line prefer-rest-params
  window.gtag('js', new Date());
  window.gtag('config', id);
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(s);
}

export function CookieConsent({ ga4 }: { ga4: string }) {
  const [choice, setChoice] = useState<Choice | null | 'unknown'>('unknown');
  useEffect(() => {
    const c = readChoice();
    setChoice(c);
    if (c === 'analytics') loadAnalytics(ga4);
    const reopen = () => setChoice(null);
    window.addEventListener('sf-cookie-settings', reopen);
    return () => window.removeEventListener('sf-cookie-settings', reopen);
  }, [ga4]);
  if (choice !== null) return null;
  const decide = (c: Choice) => { saveChoice(c); setChoice(c); if (c === 'analytics') loadAnalytics(ga4); };
  return (
    <div className="consent" role="dialog" aria-modal="false" aria-labelledby="consent-title">
      <p id="consent-title" className="consent-title">עוגיות ומדידה</p>
      <p className="consent-text">
        נשמח למדוד בעזרת Google Analytics איך משתמשים באתר, כדי לשפר אותו. זה יקרה רק אם תאשרו. אפשר לשנות את הבחירה בכל רגע מתחתית העמוד.
      </p>
      <div className="consent-actions">
        <button type="button" className="btn btn-primary" onClick={() => decide('analytics')}>אישור</button>
        <button type="button" className="btn btn-ghost" onClick={() => decide('none')}>דחייה</button>
      </div>
    </div>
  );
}

/** "הגדרות עוגיות" in the footer: the banner again */
export function CookieSettings() {
  return (
    <button type="button" className="link-button" onClick={() => window.dispatchEvent(new Event('sf-cookie-settings'))}>
      הגדרות עוגיות
    </button>
  );
}
