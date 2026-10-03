'use client';
import { useCallback, useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';

/**
 * The employee's clock. Opened from the personal link (/clock/<token>) — which also registers this
 * phone — or from the business's QR (/c/<site>), which is what unlocks the button when the business
 * requires a scan. The server stamps the time and checks the code (and the location, when locked).
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

export function ClockView({ token, site, register }: { token: string; site?: string | null; register?: boolean }) {
  const [s, setS] = useState<State | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [shareLoc, setShareLoc] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/clock/${token}${site ? `?site=${encodeURIComponent(site)}` : ''}`).catch(() => null);
    if (!r) { setMissing('אין חיבור לאינטרנט'); return; }
    const j = await r.json();
    if (!r.ok) { setMissing(j.message || 'הקישור לא תקין'); return; }
    setS(j);
    if (register) rememberEmployee(token, j.name);
  }, [token, site, register]);
  useEffect(() => { void load(); try { setShareLoc(localStorage.getItem('dp-clock-loc') === '1'); } catch { /* private mode */ } }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);

  const position = () => new Promise<{ lat?: number; lng?: number }>((res) => {
    if (!(shareLoc || s?.needsLocation) || !navigator.geolocation) return res({});
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({}), { timeout: 6000, maximumAge: 60_000 });
  });

  async function act() {
    if (!s) return;
    const action = s.openSince ? 'out' : 'in';
    setBusy(true); setMsg(null);
    try {
      const loc = await position();
      const r = await fetch(`/api/clock/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, site: site ?? undefined, ...loc }) });
      const j = await r.json();
      if (j.name) setS(j);
      if (r.ok) setMsg({ ok: true, text: action === 'in' ? `נכנסת ב-${clock(j.at)}. משמרת טובה!` : `יצאת ב-${clock(j.at)}. תודה!` });
      else setMsg({ ok: false, text: j.message || 'לא נשמר. נסו שוב.' });
    } catch { setMsg({ ok: false, text: 'אין חיבור. נסו שוב.' }); }
    finally { setBusy(false); }
  }

  if (missing) return <Shell><p className="mt-10 text-center text-ink-2">{missing}</p></Shell>;
  if (!s) return <Shell><div className="flex justify-center py-16"><Spinner /></div></Shell>;
  const inShift = Boolean(s.openSince);
  const locked = Boolean(s.requireScan && !s.siteOk);
  // a phone clock that runs behind the server must never show a negative timer
  const shiftMin = s.openSince ? Math.max(0, Math.round((now - new Date(s.openSince).getTime()) / 60_000)) : 0;

  return (
    <Shell business={s.business}>
      <h1 className="text-center font-display text-3xl font-black">שלום, {s.name.split(' ')[0]}</h1>
      <p className="mt-1 text-center text-sm text-ink-2">{formatIL(new Date(now).toISOString(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>

      {locked ? (
        <div className="my-8 rounded-3xl border-2 border-dashed border-line p-6 text-center">
          <p className="text-5xl" aria-hidden>📷</p>
          <p className="mt-3 text-lg font-bold">{inShift ? 'ליציאה' : 'לכניסה'} — סרקו את קוד ה-QR שבעסק</p>
          <p className="mt-1 text-sm text-ink-2">פותחים את המצלמה של הטלפון, מכוונים לקוד, ולוחצים על הקישור שמופיע.</p>
          {register && <p className="mt-3 text-xs font-semibold text-emerald-600">✓ הטלפון הזה מחובר עכשיו לשעון של {s.name.split(' ')[0]}</p>}
        </div>
      ) : (
      <div className="my-8 flex justify-center">
        <button type="button" onClick={act} disabled={busy || !s.active}
          className={cx('flex h-56 w-56 flex-col items-center justify-center rounded-full text-white shadow-[0_20px_60px_rgba(0,0,0,.35)] transition-transform active:scale-95 disabled:opacity-60',
            inShift ? 'bg-rose-500' : 'bg-emerald-500')}>
          {busy ? <Spinner /> : <>
            <span className="text-4xl font-black">{inShift ? 'יציאה' : 'כניסה'}</span>
            {inShift && <span className="mt-2 text-lg font-semibold tabular-nums">{hhmm(shiftMin)} במשמרת</span>}
          </>}
        </button>
      </div>
      )}

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
            {s.recent.map((r) => (
              <li key={r.in} className="flex justify-between rounded-xl bg-surface-2 px-3 py-2 tabular-nums">
                <span>{formatIL(r.in, { weekday: 'short', day: 'numeric', month: 'numeric' })}</span>
                <span>{clock(r.in)}–{clock(r.out)} · {hhmm(Math.round((+new Date(r.out) - +new Date(r.in)) / 60_000))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.needsLocation ? (
        <p className="mt-6 text-xs text-ink-2">📍 ההחתמה בודקת שאתם בעסק — המיקום נבדק רק ברגע הלחיצה, לא במהלך המשמרת.</p>
      ) : (
      <label className="mt-6 flex items-start gap-2 text-xs text-ink-2">
        <input type="checkbox" checked={shareLoc} onChange={(e) => { setShareLoc(e.target.checked); try { localStorage.setItem('dp-clock-loc', e.target.checked ? '1' : '0'); } catch { /* ignore */ } }} />
        <span>לשתף מיקום ברגע הכניסה והיציאה בלבד (לא במהלך המשמרת).</span>
      </label>
      )}
      <p className="mt-3 text-[11px] text-muted">{s.requireScan ? 'הקישור האישי מחבר את הטלפון שלך לשעון. אל תעבירו אותו לאחרים.' : 'טיפ: באייפון — שיתוף ← "הוספה למסך הבית", וזה ייפתח כמו אפליקציה. הקישור אישי, אל תעבירו אותו.'}</p>
    </Shell>
  );
}

export function Shell({ business, children }: { business?: string; children: React.ReactNode }) {
  return (
    <main dir="rtl" className="mx-auto min-h-screen max-w-md px-4 pb-12 pt-8">
      {business && <p className="mb-4 text-center text-sm font-bold text-primary">{business}</p>}
      {children}
      <p className="mt-10 text-center text-[11px] text-muted">שעון נוכחות · Dream Promotion</p>
    </main>
  );
}
