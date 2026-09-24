'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { useApp } from '@/lib/store';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { AdapterNote, Spinner } from '@/components/ui/feedback';

export type Mode = 'in' | 'up' | 'reset';

/** Email and password — the same form on /auth and in the landing-page dialog. */
export function AuthForm({ initialMode = 'in', compact = false }: { initialMode?: Mode; compact?: boolean }) {
  const router = useRouter();
  const hydrate = useApp((s) => s.hydrate);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // already signed in? go straight in
  useEffect(() => {
    if (!isCloudConfigured) return;
    supabase().auth.getSession().then(async ({ data }) => {
      if (data.session?.user) {
        await hydrate(data.session.user.id);
        router.replace('/dashboard');
      }
    });
  }, [hydrate, router]);

  function explain(message: string) {
    const m = message.toLowerCase();
    if (m.includes('invalid login')) return 'האימייל או הסיסמה שגויים.';
    if (m.includes('already registered')) return 'המייל הזה כבר רשום. נסו להתחבר.';
    if (m.includes('password')) return 'הסיסמה צריכה להיות באורך שש תווים לפחות.';
    if (m.includes('email')) return 'כתובת המייל לא תקינה.';
    if (m.includes('rate')) return 'יותר מדי ניסיונות. המתינו רגע.';
    return message;
  }

  async function submit() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const sb = supabase();
      if (mode === 'reset') {
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
          {mode === 'in' ? 'כניסה לחשבון' : mode === 'up' ? 'פתיחת חשבון' : 'איפוס סיסמה'}
        </h1>
        <p className="mb-6 mt-1 text-sm text-muted">
          {mode === 'reset' ? 'נשלח קישור לאיפוס למייל.' : 'התוכן, הסרטונים והיומן נשמרים לחשבון שלכם.'}
        </p>

        <Field label="אימייל">
          <Input type="email" dir="ltr" autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </Field>

        {mode !== 'reset' && (
          <Field label="סיסמה">
            <Input type="password" dir="ltr" value={password}
              autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="לפחות 6 תווים" />
          </Field>
        )}

        {error && <p className="mb-3 text-sm text-[var(--danger)]">{error}</p>}
        {notice && <p className="mb-3 text-sm text-ok">{notice}</p>}

        <Button variant="primary" size="lg" className="w-full" onClick={submit} disabled={busy || !email}>
          {busy ? <><Spinner />רגע…</> : mode === 'in' ? 'כניסה' : mode === 'up' ? 'יצירת חשבון' : 'שליחת קישור'}
        </Button>

        <div className="mt-5 flex flex-wrap justify-between gap-3 text-sm">
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
        </div>
      </>
  );
  if (compact) return body;
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6">
      <Card className="w-full max-w-md">{body}</Card>
    </main>
  );
}
