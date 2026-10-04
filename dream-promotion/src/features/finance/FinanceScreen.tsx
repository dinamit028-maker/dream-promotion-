'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { Button, Card, Chip, Field, Input, PageHead } from '@/components/ui/primitives';
import { EmptyState, Spinner } from '@/components/ui/feedback';
import { Wallet } from '@/components/ui/Icon';
import { formatIL } from '@/lib/il-time';
import type { Business } from '@/features/documents/openformat';
import { entityOf, chargesVat, type EntityType } from './rules';
import { FINANCE_MIGRATION, accessState, financeError, type AccessState } from './api';
import { Note, type CatalogPick } from './ui';
import { Overview } from './Overview';
import { DocumentCenter } from './DocumentCenter';
import { Receivables } from './Receivables';
import { Quotes } from './Quotes';
import { Expenses } from './Expenses';
import { Income } from './Income';
import { Reports } from './Reports';
import { Accountant } from './Accountant';
import { FinanceSettings } from './FinanceSettings';

/**
 * "כספים" — Dream Finance. One accounting engine for the register, the document center, the CRM, quotes and expenses.
 * Tabs: overview · documents · income · expenses · receivables · quotes · reports · accountant · settings.
 * A cashier never gets here (the menu hides it, the shell sends them to the register, the database refuses anyway).
 * A super admin sees a business's money only after opening access with a reason (logged in that business's audit log).
 */
export type FinanceTab = 'overview' | 'documents' | 'income' | 'expenses' | 'receivables' | 'quotes' | 'reports' | 'accountant' | 'settings';
const TABS: [FinanceTab, string][] = [
  ['overview', 'סקירה'], ['documents', 'מסמכים'], ['income', 'הכנסות'], ['expenses', 'הוצאות'], ['receivables', 'חייבים'],
  ['quotes', 'הצעות מחיר'], ['reports', 'דוחות'], ['accountant', 'רואה חשבון'], ['settings', 'הגדרות'],
];

export interface Profile {
  tradingName: string; phone: string; email: string; bankName: string; bankBranch: string; bankAccount: string; paymentTerms: string;
  quoteValidDays: number; docNote: string; vatPeriod: 'monthly' | 'bimonthly'; accountantName: string; accountantEmail: string;
}
export const EMPTY_PROFILE: Profile = { tradingName: '', phone: '', email: '', bankName: '', bankBranch: '', bankAccount: '', paymentTerms: 'immediate', quoteValidDays: 30,
  docNote: '', vatPeriod: 'bimonthly', accountantName: '', accountantEmail: '' };
export interface Settings {
  entity: EntityType; vatRate: number; dealerNumber: string; companyNumber: string; legalName: string; street: string; houseNo: string; city: string; zip: string; payLink: string;
}
interface Ctx {
  userId: string; settings: Settings; profile: Profile; business: Business & { entityType: string; ready: boolean }; vat: boolean;
  access: AccessState; catalog: CatalogPick[]; reload: () => Promise<void>; say: (m: string) => void; fail: (m: string | null) => void;
  go: (tab: FinanceTab, params?: Record<string, string>) => void; params: URLSearchParams;
}
const FinanceCtx = createContext<Ctx | null>(null);
export const useFinance = () => { const c = useContext(FinanceCtx); if (!c) throw new Error('outside the finance screen'); return c; };

export const toSettings = (r: any): Settings => ({
  entity: entityOf(r?.entity_type, r?.business_type), vatRate: Number(r?.vat_rate ?? 18), dealerNumber: r?.dealer_number ?? '', companyNumber: r?.company_number ?? '',
  legalName: r?.legal_name ?? '', street: r?.street ?? '', houseNo: r?.house_no ?? '', city: r?.city ?? '', zip: r?.zip ?? '', payLink: r?.pay_link ?? '',
});
export const toProfile = (r: any): Profile => (!r ? EMPTY_PROFILE : {
  tradingName: r.trading_name ?? '', phone: r.phone ?? '', email: r.email ?? '', bankName: r.bank_name ?? '', bankBranch: r.bank_branch ?? '', bankAccount: r.bank_account ?? '',
  paymentTerms: r.payment_terms ?? 'immediate', quoteValidDays: Number(r.quote_valid_days ?? 30), docNote: r.doc_note ?? '', vatPeriod: r.vat_period === 'monthly' ? 'monthly' : 'bimonthly',
  accountantName: r.accountant_name ?? '', accountantEmail: r.accountant_email ?? '',
});

export function FinanceScreen() {
  const router = useRouter();
  const { userId, brand } = useApp();
  const cashier = useApp((s) => s.access === 'register');
  const [tab, setTab] = useState<FinanceTab>('overview');
  const [params, setParams] = useState(() => new URLSearchParams());
  const [state, setState] = useState<{ access: AccessState; settings: Settings; profile: Profile; catalog: CatalogPick[] } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const say = useCallback((m: string) => { setFlash(m); setTimeout(() => setFlash(null), 4000); }, []);

  useEffect(() => { if (cashier) router.replace('/register'); }, [cashier, router]);
  // ?tab=documents&new=305&lead=… — links from the CRM card and the overview
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get('tab') as FinanceTab | null;
    if (t && TABS.some(([k]) => k === t)) setTab(t);
    setParams(q);
  }, []);
  const go = useCallback((t: FinanceTab, p: Record<string, string> = {}) => {
    setTab(t); setParams(new URLSearchParams(p)); setError(null);
    window.history.replaceState(null, '', `/finance?tab=${t}`);
  }, []);

  const load = useCallback(async () => {
    if (!userId) return;
    const a = await accessState();
    if (!a.ok) { setBlocked(a.error); return; }
    const sb = supabase();
    const [st, fp, it] = await Promise.all([
      sb.from('register_settings').select('*').maybeSingle(),
      a.state.open ? sb.from('business_finance_profile').select('*').maybeSingle() : Promise.resolve({ data: null, error: null }),
      sb.from('catalog_items').select('id, name, price, kind').eq('active', true).order('sort'),
    ]);
    setBlocked(null);
    setState({ access: a.state, settings: toSettings(st.data), profile: toProfile(fp.data),
      catalog: ((it.data ?? []) as any[]).map((c) => ({ id: c.id, name: c.name, price: Number(c.price), kind: c.kind })) });
  }, [userId]);
  useEffect(() => { void load(); }, [load]);

  const ctx = useMemo<Ctx | null>(() => {
    if (!state || !userId) return null;
    const s = state.settings;
    return {
      userId, settings: s, profile: state.profile, access: state.access, catalog: state.catalog, vat: chargesVat(s.entity), reload: load, say, fail: setError, go, params,
      business: { dealerNumber: s.dealerNumber, companyNumber: s.companyNumber, name: s.legalName || brand.name, street: s.street, houseNo: s.houseNo, city: s.city, zip: s.zip,
        entityType: s.entity, ready: /^[0-9]{9}$/.test(s.dealerNumber) && Boolean(s.legalName || brand.name) },
    };
  }, [state, userId, brand.name, load, say, go, params]);

  if (!isCloudConfigured || !userId) return (<><PageHead title="כספים" /><EmptyState icon={<Wallet />} title="הכספים דורשים חשבון מחובר" body="התחברו לחשבון כדי לנהל מסמכים, הכנסות והוצאות." /></>);
  if (cashier) return null;
  if (blocked) return (<><PageHead title="כספים" /><Note tone="warn">{blocked === FINANCE_MIGRATION ? FINANCE_MIGRATION : blocked}</Note></>);
  if (!state || !ctx) return <div className="py-10 text-center"><Spinner /></div>;
  if (!state.access.open) return <><PageHead title="כספים" /><PrivacyGate access={state.access} onOpened={load} /></>;

  return (
    <FinanceCtx.Provider value={ctx}>
      <PageHead title="כספים" sub={state.access.lockedUntil ? `הספרים סגורים עד ${state.access.lockedUntil.split('-').reverse().join('/')}` : undefined} />
      {state.access.superAdmin && !state.access.member && state.access.grantUntil && (
        <p role="status" className="mb-3 rounded-2xl bg-amber-500/15 p-3 text-sm font-semibold text-amber-800 dark:text-amber-200">
          🔓 גישת מנהל-על פתוחה עד {formatIL(state.access.grantUntil, { timeStyle: 'short' })} — כל פעולה נרשמת ביומן של העסק.
          <button type="button" className="ms-2 underline" onClick={async () => { await supabase().rpc('close_finance_access', { p_business: state.access.business }); await load(); }}>סגירת הגישה</button>
        </p>
      )}
      <div className="-mx-4 mb-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0" role="tablist" aria-label="מסכי הכספים">
        {TABS.map(([k, l]) => <Chip key={k} role="tab" aria-selected={tab === k} on={tab === k} onClick={() => go(k)} className="shrink-0">{l}</Chip>)}
      </div>
      {!ctx.business.ready && tab !== 'settings' && (
        <div className="mb-3"><Note tone="warn">כדי להפיק מסמכים צריך למלא את פרטי העסק (מספר עוסק, שם). <button type="button" className="font-semibold underline" onClick={() => go('settings')}>להגדרות</button></Note></div>
      )}
      {error && <p role="alert" className="mb-3 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}
      {flash && <p role="status" className="mb-3 rounded-2xl bg-emerald-500/15 p-3 text-sm font-semibold text-emerald-700 dark:text-emerald-300">✓ {flash}</p>}
      {tab === 'overview' && <Overview />}
      {tab === 'documents' && <DocumentCenter />}
      {tab === 'income' && <Income />}
      {tab === 'expenses' && <Expenses />}
      {tab === 'receivables' && <Receivables />}
      {tab === 'quotes' && <Quotes />}
      {tab === 'reports' && <Reports />}
      {tab === 'accountant' && <Accountant />}
      {tab === 'settings' && <FinanceSettings />}
    </FinanceCtx.Provider>
  );
}

/** a super admin in a business they are not a member of: the money stays closed until they open it, with a reason */
function PrivacyGate({ access, onOpened }: { access: AccessState; onOpened: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!access.superAdmin) return <Note tone="warn">אין לך גישה לנתונים הכספיים של העסק הזה.</Note>;
  async function open() {
    setBusy(true); setError(null);
    const { error: e } = await supabase().rpc('open_finance_access', { p_business: access.business, p_reason: reason.trim(), p_minutes: minutes });
    setBusy(false);
    if (e) { setError(financeError(e)); return; }
    await onOpened();
  }
  return (
    <Card className="p-4">
      <p className="mb-1 text-lg font-bold">🔒 הנתונים הכספיים של העסק הזה סגורים</p>
      <p className="mb-3 text-sm text-ink-2">כמנהל-על אפשר לפתוח גישה זמנית — עם סיבה. הפתיחה, הסיבה והזמן נרשמים ביומן הביקורת של העסק, ובעל העסק רואה אותם.</p>
      <Field label="סיבה (לדוגמה: בדיקת תקלה בדוח לבקשת בעל העסק)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
      <div className="mb-3 flex flex-wrap gap-1.5">{[15, 60, 240].map((m) => <Chip key={m} on={minutes === m} onClick={() => setMinutes(m)}>{m < 60 ? `${m} דקות` : `${m / 60} ${m === 60 ? 'שעה' : 'שעות'}`}</Chip>)}</div>
      {error && <p className="mb-2 text-sm text-warn">{error}</p>}
      <Button variant="primary" disabled={busy || reason.trim().length < 5} onClick={() => void open()}>{busy ? 'פותח…' : 'פתיחת גישה זמנית'}</Button>
    </Card>
  );
}
