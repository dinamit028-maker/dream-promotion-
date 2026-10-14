'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';
import { shiftLine } from './hours';
import { LINK_NOT_VALID, clockManifestPath, isClockToken } from './clock-app';
import { QrScanner } from './QrScanner';

/**
 * The employee's clock. Opened from the personal link (/clock/<token>) — which also registers this
 * phone — or from the business's QR (/c/<site>), which is what unlocks the button when the business
 * requires a scan. There "סריקה" reads the QR with the camera inside the page (QrScanner), so the clock
 * never sends the employee out to the phone's camera. The server stamps the time and checks the code
 * (and the location, when locked). Saved to the home screen, the icon opens this employee's personal
 * link (clock-app.ts) — never Dream.
 */
type State = { name: string; business: string; active: boolean; openSince: string | null; todayMinutes: number; recent: { in: string; out: string }[];
  requireScan?: boolean; needsLocation?: boolean; siteOk?: boolean };
export const DEVICE_KEY = 'dp-clock-tokens';
/** remember on this phone who the employee is (one phone may serve more than one employee) */
export function rememberEmployee(token: string, name: string) {
  try {
    const list: { token: string; name: string }[] = JSON.parse(localStorage.getItem(DEVICE_KEY) || '[]');
    localStorage.setItem(DEVICE_KEY, JSON.stringify([{ token, name }, ...list.filter((x) => x.token !== token)].slice(0, 5)));
  } catch { /* private mode: the personal link still works */ }
}
const hhmm = (min: number) => `${Math.floor(min / 60)}:${String(Math.max(0, min) % 60).padStart(2, '0')}`;
const clock = (iso: string) => formatIL(iso, { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => formatIL(iso, { weekday: 'short', day: 'numeric', month: 'numeric' });
/** opened from the home-screen icon (iPhone: navigator.standalone) */
const isStandalone = () => (navigator as { standalone?: boolean }).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;

export function ClockView({ token, site, register }: { token: string; site?: string | null; register?: boolean }) {
  const [s, setS] = useState<State | null>(null);
  const [missing, setMissing] = useState<{ text: string; retry: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [shareLoc, setShareLoc] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [standalone, setStandalone] = useState(false);

  /** quiet: coming back to the app — a failure keeps what is on the screen */
  const load = useCallback(async (quiet = false) => {
    const r = await fetch(`/api/clock/${token}${site ? `?site=${encodeURIComponent(site)}` : ''}`, { cache: 'no-store' }).catch(() => null);
    // a server error page is not JSON: say so instead of a spinner that never stops
    const j = r ? await r.json().catch(() => null) : null;
    if (r?.status === 404) { setMissing({ text: LINK_NOT_VALID, retry: false }); return; }
    if (r?.ok && j) { setMissing(null); setS(j); if (register) rememberEmployee(token, j.name); return; }
    if (quiet) return;
    // a home-screen app has no reload button — so the message has one
    setMissing({ text: !r ? 'אין חיבור לאינטרנט. בדקו את החיבור ונסו שוב.' : j?.message || 'השעון לא נטען כרגע. נסו שוב בעוד רגע.', retry: true });
  }, [token, site, register]);
  useEffect(() => {
    void load();
    try { setShareLoc(localStorage.getItem('dp-clock-loc') === '1'); } catch { /* private mode */ }
    setStandalone(isStandalone());
  }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  // the home-screen app comes back from the background with the screen of hours ago: ask the server again
  useEffect(() => {
    const back = () => { if (document.visibilityState === 'visible' && !acting.current) { setNow(Date.now()); void load(true); } };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [load]);

  const position = () => new Promise<{ lat?: number; lng?: number }>((res) => {
    if (!(shareLoc || s?.needsLocation) || !navigator.geolocation) return res({});
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({}), { timeout: 6000, maximumAge: 60_000 });
  });

  /** scanned: the business's code read by "סריקה" (otherwise the one of /c/<site>, when the page was opened from the QR) */
  async function act(scanned?: string) {
    if (!s) return;
    const action = s.openSince ? 'out' : 'in';
    setBusy(true); setMsg(null); acting.current = true;
    try {
      const loc = await position();
      const r = await fetch(`/api/clock/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, site: scanned ?? site ?? undefined, ...loc }) });
      const j = await r.json().catch(() => ({}));
      if (j.name) setS(j);
      if (r.ok) setMsg({ ok: true, text: action === 'in' ? `נכנסת ב-${clock(j.at)}. משמרת טובה!` : `יצאת ב-${clock(j.at)}. תודה!` });
      else setMsg({ ok: false, text: j.message || 'לא נשמר. נסו שוב.' });
    } catch { setMsg({ ok: false, text: 'אין חיבור. נסו שוב.' }); }
    finally { setBusy(false); acting.current = false; }
  }

  if (missing) return (
    <Shell app={token}>
      <p className="mt-10 text-center text-ink-2">{missing.text}</p>
      {missing.retry && <div className="mt-5 flex justify-center"><button type="button" onClick={() => { setMissing(null); void load(); }} className="min-h-11 rounded-full bg-primary px-6 font-semibold text-white">לנסות שוב</button></div>}
    </Shell>
  );
  if (!s) return <Shell app={token}><div className="flex justify-center py-16"><Spinner /></div></Shell>;
  const inShift = Boolean(s.openSince);
  const locked = Boolean(s.requireScan && !s.siteOk);
  // a phone clock that runs behind the server must never show a negative timer
  const shiftMin = s.openSince ? Math.max(0, Math.round((now - new Date(s.openSince).getTime()) / 60_000)) : 0;

  return (
    <Shell app={token} business={s.business}>
      <h1 className="text-center font-display text-3xl font-black">שלום, {s.name.split(' ')[0]}</h1>
      <p className="mt-1 text-center text-sm text-ink-2">{formatIL(new Date(now).toISOString(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>

      {locked ? (
        <div className="my-8 rounded-3xl border-2 border-dashed border-line p-6 text-center">
          <p className="text-lg font-bold">{inShift ? 'ליציאה' : 'לכניסה'} — סורקים את קוד ה-QR שבעסק</p>
          <button type="button" onClick={() => { setMsg(null); setScanning(true); }} disabled={busy || !s.active}
            className={cx('mx-auto mt-5 flex h-44 w-44 flex-col items-center justify-center rounded-full text-white shadow-[0_20px_60px_rgba(0,0,0,.35)] transition-transform active:scale-95 disabled:opacity-60',
              inShift ? 'bg-rose-500' : 'bg-emerald-500')}>
            {busy ? <Spinner /> : <>
              <span className="text-4xl" aria-hidden>📷</span>
              <span className="mt-1 text-3xl font-black">סריקה</span>
              {inShift && <span className="mt-1 text-sm font-semibold tabular-nums">{hhmm(shiftMin)} במשמרת</span>}
            </>}
          </button>
          <p className="mt-4 text-sm text-ink-2">המצלמה נפתחת כאן, בתוך השעון. מכוונים לקוד — ו{inShift ? 'היציאה' : 'הכניסה'} נרשמת מיד.</p>
          {register && <p className="mt-3 text-xs font-semibold text-emerald-600">✓ הטלפון הזה מחובר עכשיו לשעון של {s.name.split(' ')[0]}</p>}
        </div>
      ) : (
      <div className="my-8 flex justify-center">
        <button type="button" onClick={() => void act()} disabled={busy || !s.active}
          className={cx('flex h-56 w-56 flex-col items-center justify-center rounded-full text-white shadow-[0_20px_60px_rgba(0,0,0,.35)] transition-transform active:scale-95 disabled:opacity-60',
            inShift ? 'bg-rose-500' : 'bg-emerald-500')}>
          {busy ? <Spinner /> : <>
            <span className="text-4xl font-black">{inShift ? 'יציאה' : 'כניסה'}</span>
            {inShift && <span className="mt-2 text-lg font-semibold tabular-nums">{hhmm(shiftMin)} במשמרת</span>}
          </>}
        </button>
      </div>
      )}
      {scanning && <QrScanner onCode={(code) => { setScanning(false); void act(code); }} onClose={() => setScanning(false)} />}

      {msg && <p className={cx('mb-4 rounded-2xl p-3 text-center font-semibold', msg.ok ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>{msg.text}</p>}
      {!s.active && <p className="mb-4 text-center text-sm text-warn">העובד/ת לא פעיל/ה. פנו למנהל/ת.</p>}

      <div className="grid grid-cols-2 gap-2 text-center">
        <div className="rounded-2xl bg-surface-2 p-3"><span className="block text-xs text-muted">היום</span><strong className="text-xl tabular-nums">{hhmm(s.todayMinutes)}</strong></div>
        <div className="rounded-2xl bg-surface-2 p-3"><span className="block text-xs text-muted">{inShift ? 'נכנסת ב' : 'סטטוס'}</span><strong className="text-xl">{inShift ? clock(s.openSince!) : 'לא במשמרת'}</strong></div>
      </div>

      {s.recent.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-sm font-semibold">משמרות אחרונות</p>
          <ul className="grid gap-1.5 text-sm">
            {s.recent.map((r) => {
              const l = shiftLine(r.in, r.out);
              return (
                <li key={r.in} className={cx('rounded-xl bg-surface-2 px-3 py-2 tabular-nums', l.tooLong && 'ring-1 ring-warn')}>
                  <div className="flex items-center justify-between gap-2">
                    <span>{day(r.in)}{l.tooLong && <span className="ms-2 rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-bold text-warn">חריגה</span>}</span>
                    {/* in → out reads left to right, whatever the page's direction */}
                    <span><bdi dir="ltr">{`${l.inTime}–${l.outTime}`}</bdi> · {hhmm(l.minutes)}</span>
                  </div>
                  {l.outOtherDay && <p className="mt-0.5 text-end text-xs text-muted">יציאה: {day(r.out)}</p>}
                  {l.tooLong && <p className="mt-0.5 text-xs text-warn">יותר מ-14 שעות. אם שכחת לצאת — עדכנו את המנהל/ת.</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {s.needsLocation ? (
        <p className="mt-6 text-xs text-ink-2">📍 ההחתמה בודקת שאתם בעסק — המיקום נבדק רק ברגע ההחתמה, לא במהלך המשמרת.</p>
      ) : (
      <label className="mt-6 flex items-start gap-2 text-xs text-ink-2">
        <input type="checkbox" checked={shareLoc} onChange={(e) => { setShareLoc(e.target.checked); try { localStorage.setItem('dp-clock-loc', e.target.checked ? '1' : '0'); } catch { /* ignore */ } }} />
        <span>לשתף מיקום ברגע הכניסה והיציאה בלבד (לא במהלך המשמרת).</span>
      </label>
      )}
      <p className="mt-3 text-[11px] text-muted">
        {/* only on the personal link: its icon opens this employee's clock (from /c/<site> the phone may keep that address) */}
        {register && !standalone && 'טיפ: באייפון — שיתוף ← "הוספה למסך הבית", והשעון ייפתח מהאייקון כמו אפליקציה. '}
        הקישור אישי ומחבר את הטלפון שלך לשעון. אל תעבירו אותו לאחרים.
      </p>
    </Shell>
  );
}

/** app: the employee's token — links this employee's home-screen manifest (clock-app.ts); React moves the tag into <head> */
export function Shell({ business, app, children }: { business?: string; app?: string; children: React.ReactNode }) {
  return (
    <main dir="rtl" className="mx-auto min-h-screen max-w-md px-4 pb-[max(env(safe-area-inset-bottom),3rem)] pt-[max(env(safe-area-inset-top),2rem)]">
      {app && isClockToken(app) && <link rel="manifest" href={clockManifestPath(app)} />}
      {business && <p className="mb-4 text-center text-sm font-bold text-primary">{business}</p>}
      {children}
      <p className="mt-10 text-center text-[11px] text-muted">שעון נוכחות · Dream Promotion</p>
    </main>
  );
}
