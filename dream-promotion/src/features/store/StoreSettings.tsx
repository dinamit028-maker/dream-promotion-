'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { cx } from '@/lib/utils';
import { Button, PageHead, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Switch } from '@/features/catalog/PublishSwitch';
import { checklist, checkDomains, connectDomain, openStore, previewLink, removeDomain, updateStore, type StorePatch } from './data';
import {
  CHECKLIST, cleanGa4, cleanGscCode, DOMAIN_STATUS, normalizeDomain, normalizeWhatsapp, toDomain, validEmail, validPhone,
  type DomainRow, type Missing, type StoreRow,
} from './store';
import { Block, Notice, PicturePicker, TextRow } from './ui';
import { useStoreData } from './useStoreData';

/**
 * "הגדרות ודומיין" (2.55): opening the store, its details and contact, Analytics / Search Console, the domain, and the
 * checklist that lets it go on the air. Nothing here claims a connection the server did not confirm: a domain is "active"
 * only after the storefront served it; Search Console reads "קוד האימות מוצג באתר", not "connected".
 */
export function StoreSettings() {
  const { data, error, loading, reload, setData } = useStoreData();
  const brandName = useApp((s) => s.brand?.name ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);

  if (loading) return <><PageHead title="הגדרות ודומיין" /><p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p></>;
  if (error && !data) return <><PageHead title="הגדרות ודומיין" /><Notice tone="error">{error}</Notice></>;
  const store = data?.store ?? null;

  if (!store) {
    return (
      <>
        <PageHead title="פתיחת חנות" sub="חנות אחת לעסק: אותם מוצרים כמו בקופה, באתר עם דומיין משלכם." />
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <Block title="שם החנות" sub="כך היא תיקרא באתר. אפשר לשנות אחר כך.">
          <TextRow label="שם החנות" value={name || brandName} onChange={setName} max={80} placeholder="למשל FollowMe Collection" />
          <Notice tone="info">החנות נפתחת כטיוטה, עם התבנית "שקיות ממותגות". שום דבר לא עולה לאוויר לפני שהרשימה מושלמת ואתם מאשרים.</Notice>
          <Button variant="primary" disabled={busy || !(name || brandName).trim()} onClick={async () => {
            setBusy(true); setMsg(null);
            const r = await openStore(name || brandName);
            setBusy(false);
            if (!r.ok) setMsg({ tone: 'error', text: r.error }); else await reload();
          }}>{busy ? <><Spinner /> פותח…</> : 'פתיחת החנות'}</Button>
        </Block>
      </>
    );
  }
  return <Settings store={store} domains={data!.domains} reload={reload} setStore={(s) => setData((d) => (d ? { ...d, store: s } : d))}
    setDomains={(domains) => setData((d) => (d ? { ...d, domains } : d))} />;
}

function Settings({ store, domains, reload, setStore, setDomains }: {
  store: StoreRow; domains: DomainRow[]; reload: () => Promise<unknown>; setStore: (s: StoreRow) => void; setDomains: (d: DomainRow[]) => void;
}) {
  const [f, setF] = useState({
    name: store.name, description: store.description, logoUrl: store.logoUrl, phone: store.phone, whatsapp: store.whatsapp,
    email: store.email, address: store.address, ga4: store.ga4Id, gsc: store.gscCode, showStock: store.showStockCount,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [check, setCheck] = useState<{ ready: boolean; missing: Missing[] } | null>(null);
  const refreshCheck = async () => { const r = await checklist(store.id); if (r.ok) setCheck(r.data); };
  useEffect(() => { void refreshCheck(); }, [store.id, store.updatedAt, domains.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const wa = normalizeWhatsapp(f.whatsapp);
    const ga = cleanGa4(f.ga4), gsc = cleanGscCode(f.gsc);
    const problem = !f.name.trim() ? 'לחנות צריך שם.'
      : !wa.ok ? wa.error
      : !validPhone(f.phone.trim()) ? 'מספר טלפון לא תקין.'
      : !validEmail(f.email.trim()) ? 'כתובת מייל לא תקינה.'
      : ga === null ? 'מזהה Google Analytics נראה כך: G-XXXXXXXXXX.'
      : gsc === null ? 'קוד Search Console לא תקין. אפשר להדביק את כל תג ה-meta, או רק את הקוד שבתוכו.'
      : null;
    if (problem || !wa.ok || ga === null || gsc === null) { setMsg({ tone: 'error', text: problem ?? 'בדקו את השדות.' }); return; }
    setSaving(true); setMsg(null);
    const patch: StorePatch = {
      name: f.name.trim(), description: f.description.trim(), logo_url: f.logoUrl, phone: f.phone.trim(), whatsapp: wa.value,
      email: f.email.trim(), address: f.address.trim(), ga4_id: ga, gsc_code: gsc, show_stock_count: f.showStock,
    };
    const r = await updateStore(store.id, patch);
    setSaving(false);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    setStore(r.data); setF((x) => ({ ...x, whatsapp: r.data.whatsapp, ga4: r.data.ga4Id, gsc: r.data.gscCode }));
    setMsg({ tone: 'ok', text: 'נשמר.' });
  };

  const setStatus = async (status: 'published' | 'paused' | 'draft') => {
    setSaving(true); setMsg(null);
    const r = await updateStore(store.id, { status });
    setSaving(false);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); await refreshCheck(); return; }
    setStore(r.data);
    setMsg({ tone: 'ok', text: status === 'published' ? 'החנות באוויר.' : status === 'paused' ? 'החנות הושהתה: הלקוחות רואים "בקרוב".' : 'החנות חזרה לטיוטה.' });
  };

  return (
    <>
      <PageHead title="הגדרות ודומיין" sub={store.status === 'published' ? 'החנות באוויר.' : store.status === 'paused' ? 'החנות מושהית: הלקוחות רואים "בקרוב".' : 'החנות בטיוטה: רק מי שמקבל קישור תצוגה רואה אותה.'}
        action={<PreviewButton />} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <Publish store={store} check={check} busy={saving} onStatus={setStatus} />

      <Block title="פרטי החנות" id="details">
        <TextRow label="שם החנות" value={f.name} onChange={(v) => set('name', v)} max={80} />
        <label className="mb-4 block">
          <span className="mb-2 block text-sm font-semibold text-ink-2">משפט על החנות (לגוגל ולתחתית האתר)</span>
          <textarea className="w-full rounded-md border-[1.5px] border-line bg-surface px-4 py-3 text-[15px]" rows={2} maxLength={320}
            value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="למשל: שקיות ממותגות לעסקים, בהדפסה לפי המידה שלכם." />
        </label>
        <PicturePicker label="לוגו" value={f.logoUrl} onChange={(u) => set('logoUrl', u)} />
      </Block>

      <Block title="יצירת קשר" id="contact" sub="מופיע באתר: בתחתית כל עמוד, ובכפתור הוואטסאפ של כל מוצר.">
        <TextRow label="טלפון" value={f.phone} onChange={(v) => set('phone', v)} type="tel" dir="ltr" max={20} />
        <TextRow label="וואטסאפ" value={f.whatsapp} onChange={(v) => set('whatsapp', v)} type="tel" dir="ltr" placeholder="050-1234567" hint="ישמר בפורמט בינלאומי (9725…). ריק = בלי כפתור וואטסאפ." />
        <TextRow label="מייל" value={f.email} onChange={(v) => set('email', v)} type="email" dir="ltr" max={120} />
        <TextRow label="כתובת (אם יש חנות או איסוף)" value={f.address} onChange={(v) => set('address', v)} max={200} />
        <label className="mb-2 flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink-2">להציג "נשארו X במלאי" (במקום רק "במלאי")</span>
          <Switch on={f.showStock} onClick={() => set('showStock', !f.showStock)} label='להציג "נשארו X במלאי"' />
        </label>
      </Block>

      <Block title="גוגל" id="google" sub="שני הקודים מוצגים באתר — אין כאן חיבור לחשבון גוגל.">
        <TextRow label="Google Analytics — מזהה מדידה" value={f.ga4} onChange={(v) => set('ga4', v)} dir="ltr" placeholder="G-XXXXXXXXXX"
          hint="המדידה נטענת רק אחרי שהגולש מאשר עוגיות." />
        <TextRow label="Search Console — קוד אימות" value={f.gsc} onChange={(v) => set('gsc', v)} dir="ltr" placeholder='<meta name="google-site-verification" content="…">'
          hint='ב-Search Console בוחרים אימות בתג HTML, ומדביקים כאן את התג. אחרי הפרסום: מגישים שם את /sitemap.xml.' />
        {store.gscCode && <p className="text-sm text-muted">קוד האימות מוצג באתר (כשהחנות באוויר).</p>}
      </Block>

      <div className="sticky bottom-20 z-10 mb-6 flex justify-end sm:bottom-4">
        <Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? <><Spinner /> שומר…</> : 'שמירת הפרטים'}</Button>
      </div>

      <Domains domains={domains} onChange={(d) => { setDomains(d); void refreshCheck(); }} reload={reload} />
    </>
  );
}

/** the checklist and the button that puts the store on the air (the database checks the same list) */
function Publish({ store, check, busy, onStatus }: { store: StoreRow; check: { ready: boolean; missing: Missing[] } | null; busy: boolean; onStatus: (s: 'published' | 'paused' | 'draft') => void }) {
  if (store.status === 'published') {
    return (
      <Block title="החנות באוויר" sub="כל שינוי במחיר, בתמונה או במלאי מופיע באתר מיד.">
        <Button variant="ghost" disabled={busy} onClick={() => onStatus('paused')}>השהיית החנות</Button>
      </Block>
    );
  }
  return (
    <Block title="לפני שעולים לאוויר" id="publish" sub="מה שהחוק והלקוחות מצפים לראות באתר. כל סעיף מוביל למקום שבו משלימים אותו.">
      {!check ? <p className="flex items-center gap-2 text-muted"><Spinner /> בודק…</p> : (
        <ul className="mb-4 space-y-2">
          {CHECKLIST.map((c) => {
            const ok = !check.missing.includes(c.code);
            return (
              <li key={c.code} className="flex items-start gap-3">
                <span aria-hidden className={cx('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold', ok ? 'bg-[var(--ok-soft)] text-ok' : 'bg-surface-2 text-muted')}>{ok ? '✓' : '·'}</span>
                <span className="flex-1">
                  <span className="font-semibold">{c.label}</span><span className="sr-only">{ok ? ' — קיים' : ' — חסר'}</span>
                  {!ok && <> — <Link href={c.href} className="text-primary underline underline-offset-2">{c.fix}</Link></>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mb-3 text-xs text-muted">הנוסחים של המדיניות והגילוי ללקוח צריכים בדיקה של עורך דין לפני מכירה אמיתית (NEEDS_LEGAL_VERIFICATION).</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || !check?.ready} onClick={() => onStatus('published')}>העלאת החנות לאוויר</Button>
        {store.status === 'paused' && <Button variant="ghost" disabled={busy} onClick={() => onStatus('draft')}>חזרה לטיוטה</Button>}
      </div>
    </Block>
  );
}

/** "תצוגה מקדימה": the window opens on the tap itself (phones block one opened after a request), then gets the link */
export function PreviewButton({ label = 'תצוגה מקדימה' }: { label?: string }) {
  const [error, setError] = useState('');
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="ghost" onClick={async () => {
        setError('');
        const w = window.open('', '_blank');
        const r = await previewLink();
        if (!r.ok) { w?.close(); setError(r.error); return; }
        if (w) w.location.href = r.data.url; else window.location.href = r.data.url;
      }}>{label}</Button>
      {error && <p role="alert" className="max-w-xs text-xs text-red-700">{error}</p>}
    </div>
  );
}

function Domains({ domains, onChange, reload }: { domains: DomainRow[]; onChange: (d: DomainRow[]) => void; reload: () => Promise<unknown> }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'warn' | 'info'; text: string } | null>(null);
  const [vercel, setVercel] = useState<'connected' | 'not_configured' | null>(null);
  const primary = domains.find((d) => d.isPrimary);
  const apply = (r: { ok: true; data: { domains: any[]; vercel: string } } | { ok: false; error: string }) => {
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    onChange(r.data.domains.map(toDomain));
    setVercel(r.data.vercel === 'connected' ? 'connected' : 'not_configured');
  };
  const records = (d: DomainRow) => (Array.isArray((d.vercel as any).records) ? (d.vercel as any).records : []) as { type: string; name: string; value: string; fromVercel: boolean }[];
  return (
    <Block title="דומיין" id="domain" sub="הכתובת של האתר, למשל followmecollection.com. www מצטרף לבד ומפנה לכתובת הראשית.">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!primary ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
          e.preventDefault();
          const d = normalizeDomain(input);
          if (!d.ok) { setMsg({ tone: 'error', text: d.error }); return; }
          setBusy(true); setMsg(null);
          apply(await connectDomain(d.domain));
          setBusy(false); setInput('');
        }}>
          <label className="min-w-0 flex-1">
            <span className="mb-2 block text-sm font-semibold text-ink-2">הדומיין</span>
            <input className="w-full rounded-md border-[1.5px] border-line bg-surface px-4 py-3 text-[15px]" dir="ltr" value={input} onChange={(e) => setInput(e.target.value)}
              placeholder="followmecollection.com" inputMode="url" autoComplete="off" />
          </label>
          <Button type="submit" variant="primary" disabled={busy || !input.trim()}>{busy ? <><Spinner /> מחבר…</> : 'חיבור'}</Button>
        </form>
      ) : (
        <>
          <ul className="mb-4 space-y-3">
            {domains.map((d) => {
              const st = DOMAIN_STATUS[d.status];
              return (
                <li key={d.id} className="rounded-md border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold" dir="ltr">{d.domain}{d.isPrimary && <span className="ms-2 text-xs text-muted">(ראשי)</span>}</span>
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </div>
                  {d.status === 'active' && d.lastSeenAt && <p className="mt-1 text-xs text-muted">האתר נפתח בכתובת הזו — ה-DNS והאבטחה (SSL) עובדים.</p>}
                  {d.status !== 'active' && records(d).length > 0 && (
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-start text-xs" dir="ltr">
                        <thead><tr className="text-muted"><th className="pe-3 text-start font-semibold">Type</th><th className="pe-3 text-start font-semibold">Name</th><th className="text-start font-semibold">Value</th></tr></thead>
                        <tbody>{records(d).map((r, i) => <tr key={i}><td className="pe-3">{r.type}</td><td className="pe-3">{r.name}</td><td className="break-all font-mono">{r.value}</td></tr>)}</tbody>
                      </table>
                      {records(d).some((r) => !r.fromVercel) && <p className="mt-1 text-xs text-muted" dir="rtl">אלה ערכי ברירת המחדל של Vercel. הערכים המדויקים לפרויקט שלכם מופיעים ב-Vercel, בהגדרות הדומיין.</p>}
                    </div>
                  )}
                  {typeof (d.vercel as any).message === 'string' && (d.vercel as any).message && (
                    <p className={cx('mt-1 text-xs', d.status === 'error' ? 'text-red-700' : 'text-muted')}>Vercel: <bdi>{(d.vercel as any).message}</bdi></p>
                  )}
                  {d.isPrimary && (
                    <button type="button" className="mt-2 text-xs font-semibold text-red-700 underline underline-offset-2" onClick={async () => {
                      if (!window.confirm(`להסיר את ${d.domain}? האתר יפסיק לעבוד בכתובת הזו.`)) return;
                      setBusy(true); apply(await removeDomain(d.id)); setBusy(false);
                    }}>הסרת הדומיין</button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" disabled={busy} onClick={async () => { setBusy(true); setMsg(null); apply(await checkDomains()); await reload(); setBusy(false); }}>
              {busy ? <><Spinner /> בודק…</> : 'בדיקה'}
            </Button>
            {primary.status !== 'active' && <a className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-[15px] font-semibold" href={`https://${primary.domain}`} target="_blank" rel="noopener noreferrer">פתיחת האתר</a>}
          </div>
        </>
      )}
      {(vercel === 'not_configured' || (primary && primary.status !== 'active' && !(primary.vercel as any).added)) && (
        <div className="mt-4 rounded-md bg-surface-2 p-4 text-sm leading-relaxed">
          <p className="mb-2 font-semibold">החיבור ל-Vercel נעשה ביד (אין עדיין חיבור אוטומטי):</p>
          <ol className="list-decimal space-y-1 ps-5">
            <li>ב-Vercel, בפרויקט של החזית: Settings ← Domains ← Add, ומוסיפים את <span dir="ltr">{primary?.domain ?? 'הדומיין'}</span> ואת <span dir="ltr">www.{primary?.domain ?? 'הדומיין'}</span>.</li>
            <li>אצל רשם הדומיין (איפה שקניתם אותו), בהגדרות ה-DNS: מוסיפים את הרשומות ש-Vercel מציג.</li>
            <li>אחרי שה-DNS מתעדכן (לפעמים כמה שעות), פותחים את האתר פעם אחת. אז הדומיין מסומן כאן "פעיל".</li>
          </ol>
        </div>
      )}
    </Block>
  );
}
