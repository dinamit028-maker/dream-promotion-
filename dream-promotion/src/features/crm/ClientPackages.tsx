'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { israelParts } from '@/lib/il-time';
import { ils } from '@/features/register/money';
import { financeHref } from '@/features/finance/routes';
import { packageLine, packageState, packageWarnings, type ClientPackage } from '@/features/finance/packages';
import { PACKAGES_CHANGED, loadPackages } from '@/features/finance/packages-data';

/**
 * The customer's packages on their card (docs/FINANCE_ADDITIONS_HE.md, T1): "נותרו 4 מתוך 6 · בתוקף עד…", a warning when one
 * treatment is left or the validity is about to end, and what is still to pay. Money data: row-level security shows it to
 * whoever sees the business's money (never a cashier); nothing is shown when the customer has no package, or before
 * migration 20261010004200 is in the database. Selling one: "💰 כספים" ← "מכירת חבילה".
 */
export function ClientPackages({ leadId }: { leadId: string }) {
  const [list, setList] = useState<ClientPackage[] | null>(null);
  const [all, setAll] = useState(false);
  const load = useCallback(async () => {
    const r = await loadPackages(leadId);
    setList(r.ok ? r.data : []);
  }, [leadId]);
  useEffect(() => { setList(null); setAll(false); void load(); }, [load]);
  useEffect(() => {
    const again = (e: Event) => { if ((e as CustomEvent<string>).detail === leadId) void load(); };
    window.addEventListener(PACKAGES_CHANGED, again);
    return () => window.removeEventListener(PACKAGES_CHANGED, again);
  }, [leadId, load]);
  if (!list?.length) return null;

  const today = israelParts(Date.now()).date;
  const live = list.filter((p) => ['active', 'expired'].includes(packageState(p, today)));
  const shown = all ? list : live;
  const rest = list.length - live.length;
  return (
    <div className="mb-4 rounded-2xl border border-line p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-sm font-bold">📦 חבילות</p>
        <Link href={financeHref('packages')} className="text-xs font-semibold text-primary">לכל החבילות ←</Link>
      </div>
      {!shown.length ? <p className="text-xs text-muted">אין חבילה פעילה.</p> : (
        <ul className="grid gap-1.5">
          {shown.map((p) => {
            const warn = packageWarnings(p, today);
            const owed = p.docTotal != null && !p.docCancelled && (p.docType === 305 || p.docType === 300)
              ? Math.max(0, Math.round((p.docTotal - p.credited - p.paid) * 100) / 100) : 0;
            return (
              <li key={p.id}>
                <Link href={financeHref('packages', { open: p.id })} className="block rounded-xl bg-surface-2 px-3 py-2 text-sm hover:text-primary">
                  <strong>{p.name}</strong>
                  <span className="block text-xs text-ink-2">{packageLine(p, today)}</span>
                  {warn.map((w) => <span key={w.kind} className="block text-xs font-semibold text-amber-700 dark:text-amber-300">⚠️ {w.text}</span>)}
                  {owed > 0 && <span className="block text-xs text-muted">שולם {ils(p.paid)} מתוך {ils(p.price)} · נשאר לתשלום {ils(owed)}</span>}
                  {p.price > 0 && !p.documentId && p.status === 'active' && <span className="block text-xs text-(--danger)">המסמך של החבילה לא הופק — לפרטים</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {rest > 0 && (
        <button type="button" className="mt-1.5 text-xs font-semibold text-primary" onClick={() => setAll((a) => !a)}>
          {all ? 'רק החבילות הפעילות' : `גם ${rest === 1 ? 'חבילה אחת שנוצלה או בוטלה' : `${rest} חבילות שנוצלו או בוטלו`}`}
        </button>
      )}
    </div>
  );
}
