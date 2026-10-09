'use client';
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '@/lib/services/http';
import { Button } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { useApp } from '@/lib/store';
import { cx } from '@/lib/utils';
import { RECONNECT_FOR_LEADS } from './meta-leads';

/**
 * Customers → settings → "ייבוא לידים מ-Meta": the Facebook Pages of the business being worked in, a
 * switch per Page. Only switched-on Pages are imported (every 10 minutes, or "סנכרון עכשיו"); every
 * lead lands in this business with the tag "ליד ממומן" and the form's answers as a note.
 */
type Page = { id: string; name: string; avatar: string | null; connected: boolean; enabled: boolean; leadsPermission: boolean | null;
  lastSyncedAt: string | null; lastError: string; importedTotal: number };

export function MetaLeadsSettings() {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/meta/leads', { headers: await authHeaders() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      setPages(j.pages); setError(null);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(p: Page) {
    setBusy(p.id); setNotice(null);
    try {
      const r = await fetch('/api/meta/leads', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
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
      const r = await fetch('/api/meta/leads', { method: 'POST', headers: await authHeaders() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      const failed = (j.results ?? []).filter((x: any) => x.error);
      setNotice(failed.length
        ? { ok: false, text: failed.map((x: any) => `${x.page}: ${x.error}`).join(' · ') }
        : { ok: true, text: j.pages ? `הסנכרון הסתיים: ${j.imported} לידים חדשים${j.noted ? `, ${j.noted} נוספו ללקוחות קיימים` : ''}.` : 'אין עמוד שהייבוא שלו פעיל.' });
      // the new contacts appear in the list right away
      const { userId, businessId, hydrate } = useApp.getState();
      if (j.imported || j.noted) { if (userId) await hydrate(userId, businessId); }
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
        <h3 className="text-[17px] font-bold">ייבוא לידים מ-Meta</h3>
        <p className="text-sm text-muted">
          לידים מטפסי מודעות בפייסבוק ובאינסטגרם נכנסים לכאן לבד, כל 10 דקות — עם התגית "ליד ממומן" וכל התשובות מהטופס.
          לקוח שכבר קיים (אותו טלפון) לא נכפל: הפנייה נוספת לכרטיס שלו.
        </p>
      </div>
      {notice && <p className={cx('rounded-2xl p-3 text-sm', notice.ok ? 'bg-emerald-500/15' : 'bg-warn/10 text-warn')}>{notice.text}</p>}
      {!pages.length && <p className="rounded-2xl bg-surface-2 p-3 text-sm text-muted">לעסק הזה עוד אין עמוד פייסבוק משויך. מנהל המערכת משייך עמודים במסך הניהול.</p>}

      <ul className="grid gap-2">
        {pages.map((p) => {
          const problem = p.lastError || (p.leadsPermission === false ? RECONNECT_FOR_LEADS : '') || (!p.connected ? 'העמוד נותק מהחיבור ל-Meta' : '');
          return (
            <li key={p.id} className="rounded-2xl bg-surface-2 p-3">
              <div className="flex items-center gap-3">
                {p.avatar ? <img src={p.avatar} alt="" className="h-9 w-9 rounded-full bg-line" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                  : <span className="h-9 w-9 rounded-full bg-line" />}
                <span className="min-w-0 flex-1">
                  <strong className="block truncate">{p.name || 'עמוד פייסבוק'}</strong>
                  <span className="block text-xs text-muted">
                    {p.lastSyncedAt ? `סונכרן ${formatIL(p.lastSyncedAt)}` : p.enabled ? 'עוד לא סונכרן' : 'הייבוא כבוי'}
                    {p.importedTotal ? ` · ${p.importedTotal} לידים יובאו` : ''}
                  </span>
                </span>
                <button type="button" role="switch" aria-checked={p.enabled} aria-label={`ייבוא לידים מ-${p.name}`}
                  disabled={busy === p.id} onClick={() => toggle(p)}
                  className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors', p.enabled ? 'bg-primary' : 'bg-line')}>
                  <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all', p.enabled ? 'inset-s-[22px]' : 'inset-s-0.5')} />
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
