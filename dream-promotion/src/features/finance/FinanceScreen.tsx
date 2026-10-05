'use client';
import { Suspense, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useApp } from '@/lib/store';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { Button, Card, Chip, Field, Input, PageHead } from '@/components/ui/primitives';
import { useModuleActions } from '@/components/shell/ModuleShell';
import { EmptyState, Spinner } from '@/components/ui/feedback';
import { Wallet } from '@/components/ui/Icon';
import { formatIL } from '@/lib/il-time';
import type { Business } from '@/features/documents/openformat';
import { entityOf, chargesVat, type EntityType } from './rules';
import { FINANCE_MIGRATION, accessState, financeError, type AccessState } from './api';
import { Note, type CatalogPick } from './ui';
import { financeHref, financeLabel, sectionOfPath, type FinanceSection } from './routes';
import { financeActions } from './module';
import { catalogPicks, type CatalogItem } from '@/features/catalog/catalog';
import { loadCatalog } from '@/features/catalog/data';

/**
 * "כספים" — Dream Finance. One accounting engine for the register, the document center, the CRM, quotes and expenses.
 * Since 2.52 every screen has its own address (routes.ts: /finance, /finance/documents, …) and the module opens as an
 * app of its own (ModuleShell, from AppShell). This is the layout of all those screens: it loads the business's money
 * settings once, keeps the gates (no account / migration missing / money closed to a super admin), and gives the
 * screens their context.
 * A cashier never gets here (the shell sends them to the register, the database refuses anyway).
 * A super admin sees a business's money only after opening access with a reason (logged in that business's audit log).
 */
export type FinanceTab = FinanceSection;

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
  /** the products themselves (2.54): "באתר" and the editor next to a line; ready = migration 3300 ran */
  products: CatalogItem[]; productsReady: boolean; reloadCatalog: () => Promise<void>;
  /** to another screen of the module (a real address: the back button returns) */
  go: (tab: FinanceTab, params?: Record<string, string>) => void;
  /** the query of the address (?new=305&lead=…); clearParams() once a screen used it, so a refresh does not repeat it */
  params: URLSearchParams; clearParams: () => void;
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

export function FinanceLayout({ children }: { children: ReactNode }) {
  // the address's query is read inside a suspense boundary (Next.js renders the rest while it arrives)
  return <Suspense fallback={<div className="py-10 text-center"><Spinner /></div>}><FinanceProvider>{children}</FinanceProvider></Suspense>;
}

function FinanceProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const section = sectionOfPath(pathname) ?? 'overview';
  const { userId, brand } = useApp();
  const cashier = useApp((s) => s.access === 'register');
  const [state, setState] = useState<{ access: AccessState; settings: Settings; profile: Profile; catalog: CatalogPick[]; products: CatalogItem[]; productsReady: boolean } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const say = useCallback((m: string) => { setFlash(m); setTimeout(() => setFlash(null), 4000); }, []);

  useEffect(() => { if (cashier) router.replace('/register'); }, [cashier, router]);
  // a new screen starts without the previous screen's error
  useEffect(() => { setError(null); }, [pathname]);
  const params = useMemo(() => new URLSearchParams(search?.toString() ?? ''), [search]);
  const go = useCallback((t: FinanceTab, p: Record<string, string> = {}) => { setError(null); router.push(financeHref(t, p)); }, [router]);
  const clearParams = useCallback(() => { router.replace(pathname, { scroll: false }); }, [router, pathname]);

  const load = useCallback(async () => {
    if (!userId) return;
    const a = await accessState();
    if (!a.ok) { setBlocked(a.error); return; }
    const sb = supabase();
    const [st, fp, cat] = await Promise.all([
      sb.from('register_settings').select('*').maybeSingle(),
      a.state.open ? sb.from('business_finance_profile').select('*').maybeSingle() : Promise.resolve({ data: null, error: null }),
      loadCatalog(),
    ]);
    setBlocked(null);
    // the price list (2.54: an item with sizes / colours is picked per variant); a catalog that did not load leaves the lines free
    const c = cat.ok ? cat.data : { items: [], variants: [], ready: true };
    setState({ access: a.state, settings: toSettings(st.data), profile: toProfile(fp.data),
      catalog: catalogPicks(c.items, c.variants), products: c.items, productsReady: c.ready });
  }, [userId]);
  const reloadCatalog = useCallback(async () => {
    const cat = await loadCatalog();
    if (cat.ok) setState((s) => (s ? { ...s, catalog: catalogPicks(cat.data.items, cat.data.variants), products: cat.data.items, productsReady: cat.data.ready } : s));
  }, []);
  useEffect(() => { void load(); }, [load]);
  // the module's "+": only the documents this business may issue
  useModuleActions(state ? financeActions(state.settings.entity) : null);

  const ctx = useMemo<Ctx | null>(() => {
    if (!state || !userId) return null;
    const s = state.settings;
    return {
      userId, settings: s, profile: state.profile, access: state.access, catalog: state.catalog, vat: chargesVat(s.entity), reload: load, say, fail: setError, go, params, clearParams,
      products: state.products, productsReady: state.productsReady, reloadCatalog,
      business: { dealerNumber: s.dealerNumber, companyNumber: s.companyNumber, name: s.legalName || brand.name, street: s.street, houseNo: s.houseNo, city: s.city, zip: s.zip,
        entityType: s.entity, ready: /^[0-9]{9}$/.test(s.dealerNumber) && Boolean(s.legalName || brand.name) },
    };
  }, [state, userId, brand.name, load, say, go, params, clearParams, reloadCatalog]);

  const heading = financeLabel(section);
  if (!isCloudConfigured || !userId) return (<><PageHead title={heading} /><EmptyState icon={<Wallet />} title="הכספים דורשים חשבון מחובר" body="התחברו לחשבון כדי לנהל מסמכים, הכנסות והוצאות." /></>);
  if (cashier) return null;
  if (blocked) return (<><PageHead title={heading} /><Note tone="warn">{blocked === FINANCE_MIGRATION ? FINANCE_MIGRATION : blocked}</Note></>);
  if (!state || !ctx) return <div className="py-10 text-center"><Spinner /></div>;
  if (!state.access.open) return <><PageHead title={heading} /><PrivacyGate access={state.access} onOpened={load} /></>;

  return (
    <FinanceCtx.Provider value={ctx}>
      <PageHead title={heading} sub={state.access.lockedUntil ? `הספרים סגורים עד ${state.access.lockedUntil.split('-').reverse().join('/')}` : undefined} />
      {state.access.superAdmin && !state.access.member && state.access.grantUntil && (
        <p role="status" className="mb-3 rounded-2xl bg-amber-500/15 p-3 text-sm font-semibold text-amber-800 dark:text-amber-200">
          🔓 גישת מנהל-על פתוחה עד {formatIL(state.access.grantUntil, { timeStyle: 'short' })} — כל פעולה נרשמת ביומן של העסק.
          <button type="button" className="ms-2 underline" onClick={async () => { await supabase().rpc('close_finance_access', { p_business: state.access.business }); await load(); }}>סגירת הגישה</button>
        </p>
      )}
      {!ctx.business.ready && section !== 'settings' && (
        <div className="mb-3"><Note tone="warn">כדי להפיק מסמכים צריך למלא את פרטי העסק (מספר עוסק, שם). <button type="button" className="font-semibold underline" onClick={() => go('settings')}>להגדרות</button></Note></div>
      )}
      <Toasts error={error} flash={flash} onCloseError={() => setError(null)} />
      {children}
    </FinanceCtx.Provider>
  );
}

/**
 * The module's messages ("✓ נשמר", or what failed) float above everything — also above an open dialog, where most actions
 * happen (before 2.52.1 they were written under the dialog, out of sight). Portalled to <body>: no ancestor can clip them.
 */
function Toasts({ error, flash, onCloseError }: { error: string | null; flash: string | null; onCloseError: () => void }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => { setHost(document.body); }, []);
  if (!host || (!error && !flash)) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[150] flex flex-col items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),12px)] print:hidden">
      {error && (
        <div role="alert" className="pointer-events-auto flex w-full max-w-xl items-start gap-2 rounded-2xl border border-warn/40 bg-surface p-3 text-sm font-semibold text-warn shadow-lg">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={onCloseError} aria-label="סגירת ההודעה" className="-m-1 min-h-11 shrink-0 rounded-full px-3 text-muted">✕</button>
        </div>
      )}
      {flash && <p role="status" className="pointer-events-auto w-full max-w-xl rounded-2xl border border-emerald-500/40 bg-surface p-3 text-sm font-semibold text-emerald-700 shadow-lg dark:text-emerald-300">✓ {flash}</p>}
    </div>,
    host,
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
