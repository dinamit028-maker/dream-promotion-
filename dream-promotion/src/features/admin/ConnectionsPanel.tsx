'use client';
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '@/lib/services/http';
import { Button, Card, Pill, SmallSelect } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { cx } from '@/lib/utils';
import { missingBanner } from '@/lib/server/meta-sync';
import { RECONNECT_FOR_LEADS } from '@/features/crm/meta-leads';

/**
 * Admin → "חיבורים": the ONE Meta connection (every permission in one approval) and every page /
 * Instagram / TikTok account, each assigned to one business. Nothing is deleted here: a page that
 * fell out of the latest approval is shown as "נותק" until the next connection brings it back.
 */
type Asset = { id: string; provider: 'facebook' | 'instagram' | 'tiktok'; externalId: string; name: string | null; avatar: string | null;
  businessId: string | null; status: 'active' | 'missing'; missingSince: string | null };
type Data = {
  configured: boolean;
  connections: { id: string; fbUserName: string; scopes: string[]; expiresAt: string | null; lastSyncedAt: string | null }[];
  assets: Asset[]; businesses: { id: string; name: string; status: string }[];
};
const PROVIDER: Record<Asset['provider'], string> = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
const REASONS: Record<string, string> = {
  access_denied: 'החיבור בוטל בפייסבוק.', user_denied: 'החיבור בוטל בפייסבוק.', expired: 'עבר יותר מדי זמן. נסו שוב.',
  no_pages: 'לא חזר אף עמוד. בחלון של פייסבוק בחרו "כל הדפים הנוכחיים והעתידיים".', admin_only: 'רק מנהל-על יכול לחבר את Meta.',
};

export function ConnectionsPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/meta', { headers: await authHeaders() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      setData(j); setError(null);
    } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('meta') === 'connected') {
      const added = Number(q.get('added') || 0); const missing = (q.get('missing') || '').split('|').filter(Boolean);
      setNotice({ ok: !missing.length, text: ['החיבור ל-Meta עודכן.', added ? `${added} נכסים חדשים מחכים לשיוך לעסק.` : '',
        missing.length ? `${missing.length} נכסים לא חזרו באישור וסומנו כמנותקים: ${missing.join(', ')}.` : ''].filter(Boolean).join(' ') });
    }
    if (q.get('meta') === 'error') { const r = q.get('reason') || ''; setNotice({ ok: false, text: `החיבור ל-Meta לא הושלם. ${REASONS[r] ?? r}` }); }
    if (q.get('meta')) history.replaceState(null, '', '/admin?tab=connections');
    void load();
  }, [load]);

  async function connect() {
    setBusy('connect'); setNotice(null);
    try {
      const r = await fetch('/api/meta/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: '{}' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.code === 'not_configured' ? 'מפתחות Meta עוד לא הוגדרו בשרת (META_APP_ID, META_APP_SECRET, META_CONFIG_FULL ב-Vercel).' : j.message || j.code);
      window.location.href = j.url;
    } catch (e: any) { setBusy(null); setNotice({ ok: false, text: e.message }); }
  }
  async function assign(a: Asset, businessId: string) {
    setBusy(a.id);
    try {
      const r = await fetch('/api/admin/meta', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ accountId: a.id, businessId: businessId || null }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      await load();
    } catch (e: any) { setNotice({ ok: false, text: `השיוך לא נשמר: ${e.message}` }); }
    finally { setBusy(null); }
  }

  if (error) return <p className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>;
  if (!data) return <div className="py-8 text-center"><Spinner /></div>;
  const missing = data.assets.filter((a) => a.status === 'missing');
  const unassigned = data.assets.filter((a) => !a.businessId && a.status === 'active');
  const groups: [string, Asset[]][] = [
    ['לא משויך', unassigned],
    ...data.businesses.map((b) => [b.name, data.assets.filter((a) => a.businessId === b.id)] as [string, Asset[]]),
    ['מנותקים בלי עסק', data.assets.filter((a) => !a.businessId && a.status === 'missing')],
  ];

  return (
    <div className="grid gap-4">
      {notice && <p className={cx('rounded-2xl p-3 text-sm', notice.ok ? 'bg-emerald-500/15' : 'bg-warn/10 text-warn')}>{notice.text}</p>}
      {missing.map((a) => (
        <p key={a.id} role="alert" className="rounded-2xl bg-red-500/10 p-3 text-sm font-semibold text-red-700 dark:text-red-300">⚠️ {missingBanner(a.name)}</p>
      ))}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-[17px]">חיבור Meta (Facebook + Instagram)</strong>
          {data.connections.length ? <Pill tone="ok">מחובר</Pill> : <Pill tone="warn">לא מחובר</Pill>}
        </div>
        {data.connections.map((c) => (
          <p key={c.id} className="mt-2 text-sm text-ink-2">
            משתמש פייסבוק: <strong>{c.fbUserName || '—'}</strong>
            {c.lastSyncedAt && ` · סונכרן ${formatIL(c.lastSyncedAt)}`}
            {c.expiresAt && ` · החיבור בתוקף עד ${formatIL(c.expiresAt, { dateStyle: 'short' })}`}
            {!c.scopes?.includes('leads_retrieval') && (
              <span className="mt-1 block font-semibold text-warn">
                ⚠️ {RECONNECT_FOR_LEADS} — הוסיפו לתצורה ב-Meta את leads_retrieval ו-pages_manage_ads, ואז "חיבור מחדש".
              </span>
            )}
          </p>
        ))}
        <p className="my-2 text-sm text-muted">
          חיבור אחד לכל העסקים. בחלון של פייסבוק בחרו <strong>"כל הדפים הנוכחיים והעתידיים"</strong> — כל העמודים וחשבונות האינסטגרם יגיעו לכאן,
          ומשייכים כל אחד לעסק. חיבור מחדש לא מוחק כלום.
        </p>
        <Button variant={data.connections.length ? 'ghost' : 'primary'} onClick={connect} disabled={busy === 'connect' || !data.configured}>
          {busy === 'connect' ? <><Spinner />מעביר לפייסבוק…</> : data.connections.length ? 'חיבור מחדש / רענון העמודים' : 'חיבור ל-Meta'}
        </Button>
        {!data.configured && <p className="mt-2 text-xs text-muted">ממתין למפתחות Meta בשרת.</p>}
      </Card>

      <Card>
        <strong className="text-[17px]">שיוך נכסים לעסקים</strong>
        <p className="mb-3 text-sm text-muted">כל עמוד, אינסטגרם או TikTok שייך לעסק אחד בלבד. נכס "לא משויך" לא מופיע באף עסק עד שמשייכים אותו.</p>
        {!data.assets.length && <p className="text-sm text-muted">עדיין אין נכסים.</p>}
        {groups.filter(([, list]) => list.length).map(([title, list]) => (
          <div key={title} className="mb-4">
            <p className="mb-1.5 text-sm font-bold">{title} <span className="font-normal text-muted">({list.length})</span></p>
            <ul className="grid gap-1.5">
              {list.map((a) => (
                <li key={a.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl bg-surface-2 p-2 text-sm">
                  {a.avatar ? <img src={a.avatar} alt="" className="h-8 w-8 rounded-full bg-line" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} /> : <span className="h-8 w-8 rounded-full bg-line" />}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-muted">{PROVIDER[a.provider] ?? a.provider} · </span>{a.name}
                    {a.status === 'missing' && <span className="block text-xs text-red-600">נותק{a.missingSince ? ` מ-${formatIL(a.missingSince, { dateStyle: 'short' })}` : ''}</span>}
                  </span>
                  <SmallSelect value={a.businessId ?? ''} onChange={(e) => assign(a, e.target.value)} disabled={busy === a.id} className="w-full sm:w-48" aria-label={`עסק עבור ${a.name ?? ''}`}>
                    <option value="">לא משויך</option>
                    {data.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </SmallSelect>
                  {busy === a.id && <Spinner />}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {unassigned.length > 0 && <p className="text-xs text-muted">{unassigned.length} נכסים מחכים לשיוך.</p>}
      </Card>
    </div>
  );
}
