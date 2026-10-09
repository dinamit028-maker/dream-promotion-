'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { useApp } from '@/lib/store';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { AdapterNote, Spinner } from '@/components/ui/feedback';

export type Mode = 'in' | 'up' | 'reset' | 'newpass';

/** the address a password-reset link lands on: signed in for one purpose — choosing a new password */
export const isRecoveryLink = (hash: string) => /(^|[#&])type=recovery(&|$)/.test(hash);
/** a reset / confirmation link that failed (expired, used twice): the server says so in the address */
export const linkError = (hash: string) => /(^|[#&])error(_code)?=/.test(hash);

/** Email and password — the same form on /auth and in the landing-page dialog. */
export function AuthForm({ initialMode = 'in', compact = false }: { initialMode?: Mode; compact?: boolean }) {
  const router = useRouter();
  const hydrate = useApp((s) => s.hydrate);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  // a password-reset link: never go on into the app before the new password is saved
  const recovering = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // already signed in? go straight in — unless this is a password-reset link (read before the client consumes the address)
  useEffect(() => {
    if (!isCloudConfigured) return;
    const hash = location.hash;
    if (isRecoveryLink(hash)) { recovering.current = true; setMode('newpass'); }
    else if (linkError(hash)) {
      setMode('reset'); setError('הקישור פג תוקף או שכבר השתמשו בו. אפשר לבקש קישור חדש כאן.');
      history.replaceState(null, '', location.pathname + location.search);
    }
    const sb = supabase();
    const { data: sub } = sb.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') { recovering.current = true; setMode('newpass'); } });
    sb.auth.getSession().then(async ({ data }) => {
      // the recovery event comes a moment after the session: wait for it before deciding to go in
      await new Promise((r) => setTimeout(r, 50));
      if (data.session?.user && !recovering.current) {
        await hydrate(data.session.user.id);
        router.replace('/dashboard');
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [hydrate, router]);

  const explain = explainAuthError;

  async function submit() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const sb = supabase();
      if (mode === 'newpass') {
        if (password.length < 6) throw new Error('password should be at least 6 characters');
        if (password !== password2) { setError('שתי הסיסמאות לא זהות.'); return; }
        const { data, error } = await sb.auth.updateUser({ password });
        if (error) throw error;
        recovering.current = false;
        setNotice('הסיסמה עודכנה. נכנסים לחשבון…');
        history.replaceState(null, '', location.pathname);
        if (data.user) { await hydrate(data.user.id); router.replace('/dashboard'); }
      } else if (mode === 'reset') {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/auth` });
        if (error) throw error;
        setNotice('שלחנו קישור לאיפוס סיסמה למייל שלכם.');
      } else if (mode === 'up') {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session?.user) { await hydrate(data.session.user.id); router.replace('/dashboard'); }
        else setNotice('שלחנו מייל לאישור הכתובת. אחרי האישור אפשר להתחבר.');
      } else {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.user) { await hydrate(data.user.id); router.replace('/dashboard'); }
      }
    } catch (e: any) {
      setError(explain(e?.message ?? 'שגיאה'));
    } finally { setBusy(false); }
  }

  if (!isCloudConfigured) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <h1 className="mb-3 font-display text-2xl font-extrabold">חשבונות לא מוגדרים</h1>
          <AdapterNote>
            הוסיפו <code>NEXT_PUBLIC_SUPABASE_URL</code> ו-<code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> במשתני הסביבה של Vercel ובצעו פריסה מחדש.
          </AdapterNote>
        </Card>
      </main>
    );
  }

  const body = (
      <>
        <div className="mb-6 flex items-center gap-2.5">
          <span aria-hidden className="relative h-9 w-9 rounded-xl bg-primary">
            <span className="absolute inset-[27%] rounded-md bg-white/90" />
          </span>
          <span className="font-display text-lg font-bold">Dream Promotion</span>
        </div>

        <h1 className="font-display text-2xl font-extrabold">
          {mode === 'in' ? 'כניסה לחשבון' : mode === 'up' ? 'פתיחת חשבון' : mode === 'newpass' ? 'בחירת סיסמה חדשה' : 'איפוס סיסמה'}
        </h1>
        <p className="mb-6 mt-1 text-sm text-muted">
          {mode === 'reset' ? 'נשלח קישור לאיפוס למייל.' : mode === 'newpass' ? 'הקישור אומת. בחרו סיסמה חדשה לחשבון.' : 'התוכן, הסרטונים והיומן נשמרים לחשבון שלכם.'}
        </p>

        {mode !== 'newpass' && (
          <Field label="אימייל">
            <Input type="email" dir="ltr" autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </Field>
        )}

        {mode === 'newpass' && (
          <>
            <Field label="סיסמה חדשה">
              <Input type="password" dir="ltr" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="לפחות 6 תווים" />
            </Field>
            <Field label="שוב, לאימות">
              <Input type="password" dir="ltr" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()} />
            </Field>
          </>
        )}

        {mode !== 'reset' && mode !== 'newpass' && (
          <Field label="סיסמה">
            <Input type="password" dir="ltr" value={password}
              autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="לפחות 6 תווים" />
          </Field>
        )}

        {error && <p className="mb-3 text-sm text-(--danger)">{error}</p>}
        {notice && <p className="mb-3 text-sm text-ok">{notice}</p>}

        <Button variant="primary" size="lg" className="w-full" onClick={submit} disabled={busy || (mode === 'newpass' ? !password || !password2 : !email)}>
          {busy ? <><Spinner />רגע…</> : mode === 'in' ? 'כניסה' : mode === 'up' ? 'יצירת חשבון' : mode === 'newpass' ? 'שמירת הסיסמה' : 'שליחת קישור'}
        </Button>

        {mode !== 'newpass' && <div className="mt-5 flex flex-wrap justify-between gap-3 text-sm">
          {mode !== 'in' && (
            <button type="button" className="font-semibold text-primary hover:underline" onClick={() => { setMode('in'); setError(null); }}>
              יש לי כבר חשבון
            </button>
          )}
          {mode !== 'up' && (
            <button type="button" className="font-semibold text-primary hover:underline" onClick={() => { setMode('up'); setError(null); }}>
              פתיחת חשבון חדש
            </button>
          )}
          {mode !== 'reset' && (
            <button type="button" className="text-muted hover:underline" onClick={() => { setMode('reset'); setError(null); }}>
              שכחתי סיסמה
            </button>
          )}
        </div>}
      </>
  );
  if (compact) return body;
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6">
      <Card className="w-full max-w-md">{body}</Card>
    </main>
  );
}

/** what the sign-in service answered → Hebrew (the English original stays in the console, never on the screen) */
export function explainAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login')) return 'האימייל או הסיסמה שגויים.';
  if (m.includes('not confirmed')) return 'צריך לאשר את כתובת המייל: פתחו את המייל ששלחנו ולחצו על הקישור, ואז התחברו.';
  if (m.includes('already registered') || m.includes('already been registered')) return 'המייל הזה כבר רשום. נסו להתחבר.';
  if (m.includes('different from the old')) return 'הסיסמה החדשה צריכה להיות שונה מהקודמת.';
  if (m.includes('security purposes') || m.includes('rate limit') || m.includes('too many')) return 'יותר מדי ניסיונות. המתינו כדקה ונסו שוב.';
  if (m.includes('session') && (m.includes('missing') || m.includes('expired'))) return 'פג תוקף ההתחברות. בקשו קישור חדש לאיפוס הסיסמה.';
  if (m.includes('password')) return 'הסיסמה צריכה להיות באורך שש תווים לפחות.';
  if (m.includes('email')) return 'כתובת המייל לא תקינה.';
  if (m.includes('failed to fetch') || m.includes('network') || m.includes('load failed')) return 'אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.';
  if (typeof console !== 'undefined') console.error('auth:', message);
  return 'משהו השתבש. נסו שוב בעוד רגע.';
}
