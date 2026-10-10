'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Chip } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { ProductEditorDialog } from '@/features/catalog/ProductEditor';
import { ContactSheet } from '@/features/crm/ContactSheet';
import { useFinance } from './FinanceScreen';
import { logEvent } from './api';
import { LOAD_FAILED, LoadFailed, Note, Pill, Stat, download, ils, todayIL } from './ui';
import {
  PACKAGES_MIGRATION, STATE_HE, packageLine, packageState, packageWarnings, packagesCsv, packagesReport, termsText,
  type CatalogPackage, type ClientPackage, type PackageState,
} from './packages';
import { PACKAGES_CHANGED, loadCatalogPackages, loadPackages, loadTreatmentTypes, type TreatmentType } from './packages-data';
import { PackageView } from './PackageView';
import { SellPackageDialog } from './SellPackage';

/**
 * "חבילות" (docs/FINANCE ADDITIONS HE.md, T1): the packages sold and what is left of them, the report — open packages,
 * treatments left, what was paid in advance and not used yet — and the packages of the catalog. A sale opens here or from
 * the client card (?sell=1&lead=…); a package opens from the card's link (?open=<id>).
 * The report is information for the owner, not an accounting determination.
 */
type Filter = 'open' | 'used_up' | 'expired' | 'cancelled' | 'all';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open', label: 'פעילות' }, { id: 'expired', label: 'פג תוקף' }, { id: 'used_up', label: 'נוצלו' }, { id: 'cancelled', label: 'בוטלו' }, { id: 'all', label: 'הכל' },
];
const TONE: Record<PackageState, 'ok' | 'warn' | 'bad' | 'default'> = { active: 'ok', used_up: 'default', expired: 'warn', cancelled: 'bad' };

export function Packages() {
  const { userId, settings, vat, business, profile, params, clearParams, say } = useFinance();
  const today = todayIL();
  const [list, setList] = useState<ClientPackage[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogPackage[]>([]);
  const [types, setTypes] = useState<TreatmentType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [sell, setSell] = useState<{ leadId: string | null } | null>(null);
  const [open, setOpen] = useState<ClientPackage | null>(null);
  const [edit, setEdit] = useState<{ id: string | null } | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    const [p, c, t] = await Promise.all([loadPackages(), loadCatalogPackages(), loadTreatmentTypes()]);
    if (!p.ok) { setError(p.error); setList([]); return; }
    setError(null); setList(p.data); setTypes(t);
    if (c.ok) setCatalog(c.data);
  }, []);
  useEffect(() => { void load(); }, [load, attempt]);
  useEffect(() => {
    const again = () => void load();
    window.addEventListener(PACKAGES_CHANGED, again);
    return () => window.removeEventListener(PACKAGES_CHANGED, again);
  }, [load]);

  // ?sell=1&lead=… (the client card) · ?open=<id> (the card's "לפרטים")
  useEffect(() => {
    if (params.get('sell')) { setSell({ leadId: params.get('lead') }); clearParams(); return; }
    const id = params.get('open');
    if (id && list) { const p = list.find((x) => x.id === id); if (p) setOpen(p); clearParams(); }
  }, [params, list]); // eslint-disable-line react-hooks/exhaustive-deps

  const report = useMemo(() => packagesReport(list ?? [], today), [list, today]);
  const shown = useMemo(() => (list ?? []).filter((p) => {
    const st = packageState(p, today);
    return filter === 'all' || (filter === 'open' ? st === 'active' : st === filter);
  }), [list, filter, today]);
  const typeName = (id: string | null) => types.find((t) => t.id === id)?.name ?? null;
  const basics = { userId, entity: settings.entity, vatRate: settings.vatRate, vat, ready: business.ready, paymentTerms: profile.paymentTerms };

  function exportCsv() {
    download(`packages-${today}.csv`, packagesCsv(list ?? [], today));
    void logEvent('export.csv', 'client_packages', '', { rows: (list ?? []).length });
  }

  if (error === PACKAGES_MIGRATION) return <Note tone="warn">{PACKAGES_MIGRATION}</Note>;
  if (list === null) return <div className="py-8 text-center"><Spinner /></div>;
  if (error) return <LoadFailed message={error || LOAD_FAILED} onRetry={() => setAttempt((n) => n + 1)} />;
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="חבילות פעילות" value={report.open} onClick={() => setFilter('open')} />
        <Stat label="טיפולים שנותרו בהן" value={report.remainingSessions} />
        <Stat label="שווי הטיפולים שנותרו" value={ils(report.remainingValue)} hint="מחיר × נותרו ÷ טיפולים" />
        <Stat label="שולם מראש ועוד לא נוצל" value={ils(report.prepaidUnused)} hint={report.owed > 0 ? `ועוד ${ils(report.owed)} לגבייה` : undefined} />
      </div>
      {report.expired > 0 && (
        <Note tone="warn">ב-{report.expired} {report.expired === 1 ? 'חבילה שפג תוקפה' : 'חבילות שפג תוקפן'} {report.expiredSessions === 1 ? 'נשאר טיפול אחד' : `נשארו ${report.expiredSessions} טיפולים`} (שווי {ils(report.expiredValue)}). <button type="button" className="font-semibold underline" onClick={() => setFilter('expired')}>להצגה</button></Note>
      )}
      <p className="text-xs text-muted">מידע לבעלים — לא קביעה חשבונאית. ההכנסה נרשמת במסמך של כל חבילה (פעם אחת); איך לרשום הכנסה מראש בדוחות — שאלה לרואה החשבון.</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setSell({ leadId: null })}>+ מכירת חבילה</Button>
        <Button variant="ghost" disabled={!list.length} onClick={exportCsv}>ייצוא CSV</Button>
      </div>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0" role="group" aria-label="סינון חבילות">
        {FILTERS.map((f) => <Chip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)} className="shrink-0">{f.label}</Chip>)}
      </div>

      {!shown.length ? (
        <Note>{list.length ? 'אין חבילות במצב הזה.' : 'עוד לא נמכרו חבילות. מוכרים מכאן או מכרטיס הלקוח ("💰 כספים" ← "מכירת חבילה").'}</Note>
      ) : (
        <div className="grid gap-1.5">
          {shown.map((p) => {
            const st = packageState(p, today);
            const warn = packageWarnings(p, today);
            return (
              <button key={p.id} type="button" onClick={() => setOpen(p)} className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-start text-sm hover:border-primary">
                <span className="min-w-0 flex-1">
                  <strong className="block truncate">{p.customerName || 'לקוח/ה'} · {p.name}</strong>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    {packageLine(p, today)}
                    {st !== 'active' && <Pill tone={TONE[st]}>{STATE_HE[st]}</Pill>}
                    {warn.map((w) => <Pill key={w.kind} tone="warn">{w.text}</Pill>)}
                    {p.price > 0 && !p.documentId && <Pill tone="bad">המסמך לא הופק</Pill>}
                  </span>
                </span>
                <span className="shrink-0 text-end tabular-nums">
                  <strong className="block">{ils(p.price)}</strong>
                  {p.price > 0 && <span className="text-xs text-muted">שולם {ils(p.paid)}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <section aria-labelledby="pk-catalog" className="mt-2 grid gap-2 rounded-2xl border border-line p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="pk-catalog" className="font-bold">החבילות בקטלוג</h3>
          <Button size="sm" variant="ghost" onClick={() => setEdit({ id: null })}>+ חבילה חדשה</Button>
        </div>
        <p className="text-xs text-muted">חבילה היא פריט בקטלוג האחד (קופה, כספים, חנות) מסוג &quot;חבילה&quot;, עם מספר טיפולים, סוג טיפול ותוקף. שינוי כאן לא משנה חבילה שכבר נמכרה.</p>
        {!catalog.length ? <p className="text-sm text-muted">אין עדיין חבילות בקטלוג.</p> : (
          <ul className="grid gap-1.5">
            {catalog.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setEdit({ id: c.id })} className="flex w-full min-w-0 items-center gap-3 rounded-xl bg-surface-2 px-3 py-2 text-start text-sm hover:text-primary">
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate">{c.name}{!c.active ? ' (מוסתר)' : ''}</strong>
                    <span className="text-xs text-muted">{termsText(c, typeName(c.typeId))}</span>
                    {!c.sessions && <span className="block text-xs text-amber-700 dark:text-amber-300">חסר מספר טיפולים — לא נמכרת כחבילה עד שמגדירים</span>}
                  </span>
                  <strong className="tabular-nums">{ils(c.price)}</strong>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sell && <SellPackageDialog leadId={sell.leadId} basics={basics} onClose={() => setSell(null)}
        onDone={(p) => { setSell(null); say(`נמכרה ${p.name} ל${p.customerName || 'לקוח/ה'}`); void load(); setOpen(p); }} />}
      {open && <PackageView pkg={open} onClose={() => setOpen(null)} onChanged={() => void load()} onOpenCard={(id) => setCard(id)} />}
      <ProductEditorDialog open={Boolean(edit)} itemId={edit?.id ?? null} initial={edit && !edit.id ? { kind: 'package' } : undefined}
        onClose={() => setEdit(null)} onSaved={() => void load()} onDeleted={() => { setEdit(null); void load(); }} />
      <ContactSheet leadId={card} onClose={() => setCard(null)} />
    </div>
  );
}
