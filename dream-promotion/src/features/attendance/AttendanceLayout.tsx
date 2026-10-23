'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { PageHead } from '@/components/ui/primitives';
import { EmptyState, Spinner } from '@/components/ui/feedback';
import { IdentificationBadge } from '@/components/ui/Icon';
import { AttendanceScreen } from '@/features/timeclock/AttendanceScreen';
import { attError, attendanceReady, loadSetup, myRole, type Setup } from './api';
import { seesPrivate, type AttRole } from './people';

/**
 * Every screen of "נוכחות ועובדים" (2.107). Before migration 5800 is in the database — the clock's screen exactly as it was
 * (AttendanceScreen) on the module's home, and every other screen says what is missing. After it: the caller's part
 * (att_role — the database decides, the screens only hide) and the business's people, departments and tracks, shared by the
 * screens (reload() after a change). A cashier is sent back to the register.
 */
interface Att {
  role: AttRole;
  userId: string;
  businessId: string;
  businessName: string;
  setup: Setup;
  reload: () => Promise<void>;
  /** a short "✓ …" at the top of the screen */
  say: (msg: string) => void;
}
const Ctx = createContext<Att | null>(null);
export const useAtt = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAtt outside AttendanceLayout');
  return v;
};

export function AttendanceLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const userId = useApp((s) => s.userId);
  const businessId = useApp((s) => s.businessId);
  const cashier = useApp((s) => s.access === 'register');
  const brandName = useApp((s) => s.brand.name);
  const [ready, setReady] = useState<boolean | null>(null);
  const [role, setRole] = useState<AttRole | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => { if (cashier) router.replace('/register'); }, [cashier, router]);

  const reload = useCallback(async (r?: AttRole) => {
    try { setSetup(await loadSetup({ privates: seesPrivate(r ?? role ?? 'none') })); setError(null); }
    catch (e) { setError(attError(e)); }
  }, [role]);

  useEffect(() => {
    if (!isCloudConfigured || !userId || cashier) return;
    let alive = true;
    (async () => {
      const ok = await attendanceReady();
      if (!alive) return;
      setReady(ok);
      if (!ok) return;
      const r = await myRole();
      const { data } = await supabase().from('businesses').select('name').eq('id', businessId ?? '').maybeSingle();
      if (!alive) return;
      setRole(r); setBusinessName((data as any)?.name || brandName || '');
      if (r !== 'none') await reload(r);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, businessId, cashier]);

  const say = useCallback((m: string) => { setFlash(m); setTimeout(() => setFlash(null), 3000); }, []);
  const value = useMemo<Att | null>(() => (role && setup && userId && businessId
    ? { role, userId, businessId, businessName, setup, reload: () => reload(), say } : null), [role, setup, userId, businessId, businessName, reload, say]);

  if (cashier) return null;
  if (!isCloudConfigured || !userId) {
    return (<><PageHead title="נוכחות ועובדים" /><EmptyState icon={<IdentificationBadge />} title="נוכחות ועובדים דורשת חשבון מחובר" body="התחברו לחשבון כדי לנהל עובדים ושעות." /></>);
  }
  if (ready === null) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (!ready) {
    // the clock as it was, until the migration runs
    if (path === '/attendance') return <AttendanceScreen />;
    return (<><PageHead title="נוכחות ועובדים" /><EmptyState icon={<IdentificationBadge />} title="המסך הזה עוד לא פעיל"
      body="צריך להריץ את מיגרציה 20261023005800 (נוכחות ועובדים) ב-Supabase. עד אז — שעון הנוכחות עובד כמו קודם, במסך הראשי של המודול." /></>);
  }
  if (role === 'none') {
    return (<><PageHead title="נוכחות ועובדים" /><EmptyState icon={<IdentificationBadge />} title="אין לך גישה לנוכחות"
      body="נוכחות ועובדים לא כלולה בחבילה של העסק, או שלא הוגדרה לך הרשאה. פנו למנהל המערכת." /></>);
  }
  if (!value) return error ? <p role="alert" className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p> : <div className="flex justify-center py-16"><Spinner /></div>;
  return (
    <Ctx.Provider value={value}>
      {error && <p role="alert" className="mb-4 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}
      {flash && <p role="status" className="mb-4 text-sm font-semibold text-ok">✓ {flash}</p>}
      {children}
    </Ctx.Provider>
  );
}
