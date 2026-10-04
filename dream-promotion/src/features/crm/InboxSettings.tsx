'use client';
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '@/lib/services/http';
import { Button } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { useApp } from '@/lib/store';
import { cx } from '@/lib/utils';

/**
 * Customers → settings → "תגובות והודעות": the business's Facebook Pages and Instagram accounts, a switch
 * each. Switched-on accounts are read every 10 minutes (or "סנכרון עכשיו"): every person who comments or
 * writes becomes one card in the "💬 תגובות" column of the leads board.
 */
type Page = { id: string; provider: string; name: string; avatar: string | null; connected: boolean; enabled: boolean;
  lastSyncedAt: string | null; lastError: string };

export function InboxSettings() {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/meta/inbox', { headers: await authHeaders() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      setPages(j.accounts); setError(null);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(p: Page) {
    setBusy(p.id); setNotice(null);
    try {
      const r = await fetch('/api/meta/inbox', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ accountId: p.id, enabled: !p.enabled }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      await load();
    } catch (e: any) { setNotice({ ok: false, text: `לא נשמר: ${e.message}` }); }
    finally { setBusy(null); }
  }

  async function syncNow() {
    setBusy('sync'); setNotice(null);
    try {
      const r = await fetch('/api/meta/inbox', { method: 'POST', headers: await authHeaders() });
      // a very long first read can outlast the server's minute — it continues on the next run by itself
      const j = await r.json().catch(() => { throw new Error('הסנכרון לקח יותר מדקה. הוא ממשיך לבד ברקע — נסו שוב בעוד כמה דקות.'); });
      if (!r.ok) throw new Error(j.message || j.code);
      const failed = (j.results ?? []).filter((x: any) => x.error);
      setNotice(failed.length
        ? { ok: false, text: failed.map((x: any) => `${x.account}: ${x.error}`).join(' · ') }
        : { ok: true, text: j.accounts ? `הסנכרון הסתיים: ${j.stored} תגובות והודעות חדשות${j.contacts ? `, ${j.contacts} אנשים חדשים בעמודת "תגובות"` : ''}.` : 'אין חשבון שהקריאה שלו פעילה.' });
      // the new contacts appear in the list right away
      const { userId, businessId, hydrate } = useApp.getState();
      if (j.contacts || j.stored) { if (userId) await hydrate(userId, businessId); }
      await load();
    } catch (e: any) { setNotice({ ok: false, text: e.message }); }
    finally { setBusy(null); }
  }

  if (error) return <p className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>;
  if (!pages) return <div className="py-6 text-center"><Spinner /></div>;
  const anyOn = pages.some((p) => p.enabled);

  return (
    <div className="grid gap-3">
      <div>
        <h3 className="text-[17px] font-bold">תגובות והודעות</h3>
        <p className="text-sm text-muted">
          תגובות על פוסטים, הודעות מסנג׳ר והודעות אינסטגרם נכנסות לעמודה "💬 תגובות" בלוח, כל 10 דקות.
          כל אדם מופיע פעם אחת, וכל מה שכתב נשמר אצלו. עמוד פייסבוק מביא גם את ההודעות של האינסטגרם המחובר אליו.
        </p>
      </div>
      {notice && <p className={cx('rounded-2xl p-3 text-sm', notice.ok ? 'bg-emerald-500/15' : 'bg-warn/10 text-warn')}>{notice.text}</p>}
      {!pages.length && <p className="rounded-2xl bg-surface-2 p-3 text-sm text-muted">לעסק הזה עוד אין עמוד או חשבון אינסטגרם משויך. מנהל המערכת משייך אותם במסך הניהול.</p>}

      <ul className="grid gap-2">
        {pages.map((p) => {
          const problem = p.lastError || (!p.connected ? 'החשבון נותק מהחיבור ל-Meta' : '');
          return (
            <li key={p.id} className="rounded-2xl bg-surface-2 p-3">
              <div className="flex items-center gap-3">
                {p.avatar ? <img src={p.avatar} alt="" className="h-9 w-9 rounded-full bg-line" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                  : <span className="h-9 w-9 rounded-full bg-line" />}
                <span className="min-w-0 flex-1">
                  <strong className="block truncate">{p.provider === 'instagram' ? '📷 ' : '👍 '}{p.name || 'חשבון'}</strong>
                  <span className="block text-xs text-muted">
                    {p.provider === 'instagram' ? 'תגובות באינסטגרם' : 'תגובות בפייסבוק · מסנג׳ר · הודעות אינסטגרם'}
                    {' · '}{p.lastSyncedAt ? `סונכרן ${formatIL(p.lastSyncedAt)}` : p.enabled ? 'עוד לא סונכרן' : 'כבוי'}
                  </span>
                </span>
                <button type="button" role="switch" aria-checked={p.enabled} aria-label={`תגובות והודעות מ-${p.name}`}
                  disabled={busy === p.id} onClick={() => toggle(p)}
                  className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors', p.enabled ? 'bg-primary' : 'bg-line')}>
                  <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all', p.enabled ? 'start-[22px]' : 'start-0.5')} />
                </button>
              </div>
              {problem && <p role="alert" className="mt-2 rounded-xl bg-red-500/10 p-2 text-sm font-semibold text-red-700 dark:text-red-300">⚠️ {problem}</p>}
            </li>
          );
        })}
      </ul>

      {pages.length > 0 && (
        <Button variant="ghost" onClick={syncNow} disabled={busy === 'sync' || !anyOn}>
          {busy === 'sync' ? <><Spinner />מסנכרן…</> : 'סנכרון עכשיו'}
        </Button>
      )}
    </div>
  );
}
