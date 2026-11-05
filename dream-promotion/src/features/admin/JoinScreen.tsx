'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { useApp } from '@/lib/store';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { passwordProblem } from './business-state';
import { JOIN_GONE } from './invite';

/**
 * The invited person's page (2.114): /join/<token>. "כניסה" signs them in once (the server's one-time sign-in, turned into a
 * session here), then they choose their own password — a "new password" field with their email as the user name, so the phone
 * offers a strong one and saves it — and they go to their screens. Nothing is used before the tap (a preview reads the page).
 */
type Step = 'loading' | 'gone' | 'ready' | 'password' | 'done';

export function JoinScreen({ token }: { token: string }) {
  const router = useRouter();
  const hydrate = useApp((s) => s.hydrate);
  const [step, setStep] = useState<Step>('loading');
  const [why, setWhy] = useState('');
  const [business, setBusiness] = useState('');
  const [email, setEmail] = useState('');
  const [home, setHome] = useState('/dashboard');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/join/${token}`, { cache: 'no-store' });
        const j = await r.json().catch(() => null);
        if (!live) return;
        if (!r.ok) { setWhy(JOIN_GONE[j?.code] ?? JOIN_GONE.not_found); setStep('gone'); return; }
        setBusiness(j.business ?? ''); setEmail(j.email ?? ''); setStep('ready');
      } catch { if (live) { setWhy('אין חיבור לאינטרנט. נסו שוב.'); setStep('gone'); } }
    })();
    return () => { live = false; };
  }, [token]);

  async function enter() {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/join/${token}`, { method: 'POST', cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        if (r.status === 410 || r.status === 404) { setWhy(JOIN_GONE[j?.code] ?? JOIN_GONE.not_found); setStep('gone'); }
        else setError(j?.message ?? 'לא הצלחנו להכניס אותך. נסו שוב.');
        return;
      }
      const sb = supabase();
      await sb.auth.signOut({ scope: 'local' }).catch(() => undefined);   // another person's session on this phone — not theirs
      const { data, error } = await sb.auth.verifyOtp({ token_hash: j.tokenHash, type: 'magiclink' });
      if (error || !data.user) { setError('לא הצלחנו להכניס אותך. בקשו קישור חדש.'); return; }
      setHome(j.home || '/dashboard');
      await hydrate(data.user.id);
      setStep('password');
    } catch { setError('אין חיבור לאינטרנט. נסו שוב.'); }
    finally { setBusy(false); }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    const weak = passwordProblem(password);
    if (weak) { setError(weak); return; }
    setBusy(true); setError(null);
    try {
      const { error } = await supabase().auth.updateUser({ password });
      if (error) { setError(/different|same/i.test(error.message) ? 'זו כבר הסיסמה שלך — אפשר להמשיך.' : 'לא הצלחנו לשמור את הסיסמה. נסו שוב.'); return; }
      setStep('done');
    } catch { setError('אין חיבור לאינטרנט. נסו שוב.'); }
    finally { setBusy(false); }
  }

  const head = (
    <div className="mb-5 flex items-center gap-2.5">
      <span aria-hidden className="relative h-9 w-9 rounded-xl bg-primary"><span className="absolute inset-[27%] rounded-md bg-white/90" /></span>
      <span className="font-display text-lg font-bold">Dream Promotion</span>
    </div>
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-4">
      <Card className="w-full max-w-md">
        {head}
        {!isCloudConfigured && <p className="text-sm text-muted">החשבונות לא מוגדרים.</p>}
        {step === 'loading' && <p className="flex items-center gap-2 text-muted"><Spinner /> רגע…</p>}
        {step === 'gone' && (<>
          <h1 className="mb-2 font-display text-2xl font-extrabold">הקישור לא פעיל</h1>
          <p className="mb-4 text-sm text-ink-2">{why}</p>
          <Button variant="ghost" onClick={() => router.replace('/auth')}>לכניסה עם מייל וסיסמה</Button>
        </>)}
        {step === 'ready' && (<>
          <h1 className="mb-2 font-display text-2xl font-extrabold">הוזמנת{business ? ` ל${business}` : ''}</h1>
          <p className="mb-1 text-sm text-ink-2">החשבון שלך: <span dir="ltr" className="font-semibold">{email}</span></p>
          <p className="mb-5 text-sm text-muted">לוחצים "כניסה", בוחרים סיסמה — והטלפון שומר אותה.</p>
          <Button variant="primary" className="w-full" disabled={busy} onClick={() => void enter()}>{busy ? <Spinner /> : null}כניסה</Button>
        </>)}
        {step === 'password' && (
          <form onSubmit={savePassword}>
            <h1 className="mb-2 font-display text-2xl font-extrabold">בחירת סיסמה</h1>
            <p className="mb-4 text-sm text-muted">אפשר לבחור את הסיסמה שהטלפון מציע — הוא ישמור אותה, ובכניסה הבאה ימלא אותה לבד.</p>
            {/* the user name for the phone's password manager — the email of this sign-in */}
            <input type="email" name="username" autoComplete="username" value={email} readOnly className="sr-only" tabIndex={-1} aria-hidden />
            <Field label="סיסמה (8 תווים לפחות, אותיות ומספרים)">
              <Input dir="ltr" type="password" name="new-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" className="w-full" disabled={busy || !password}>{busy ? <Spinner /> : null}שמירת הסיסמה</Button>
          </form>
        )}
        {step === 'done' && (<>
          <h1 className="mb-2 font-display text-2xl font-extrabold">הכול מוכן ✓</h1>
          <p className="mb-3 text-sm text-ink-2">את/ה מחובר/ת. כדי לפתוח בלחיצה אחת — שומרים למסך הבית:</p>
          <ul className="mb-3 stack-y-1 text-sm text-ink-2">
            <li>• <strong>אייפון</strong> (Safari): כפתור השיתוף ⬆️ ← "הוסף למסך הבית"</li>
            <li>• <strong>אנדרואיד</strong> (Chrome): ⋮ ← "הוספה למסך הבית"</li>
          </ul>
          <p className="mb-5 text-xs text-muted">בפעם הראשונה שפותחים מהמסך — נכנסים עם המייל, והטלפון ממלא את הסיסמה ששמר.</p>
          <Button variant="primary" className="w-full" onClick={() => router.replace(home)}>כניסה</Button>
        </>)}
        {error && <p role="alert" className="mt-3 text-sm text-(--danger)">{error}</p>}
      </Card>
    </main>
  );
}
