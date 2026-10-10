'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, PageHead, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Switch } from '@/features/catalog/PublishSwitch';
import { checkCheckout, SELLING_MISSING, sellingMissing, type CheckoutSettings, type TerminalInfo } from './checkout';
import { connectEmailDomain, loadEmailDomain, terminalInfo, updateStore, verifyEmailDomain, type EmailDomain } from './data';
import { PaymentTerminal } from './PaymentTerminal';
import { EMAIL_DOMAIN_HE } from './commerce';
import { storeHref } from './routes';
import type { StoreRow } from './store';
import { AreaRow, Block, NeedsStore, Notice, TextRow } from './ui';
import { useStoreData } from './useStoreData';

/**
 * "מכירה באתר" (2.56; 2.57: a live terminal behind the platform's switch, the emails' domain): the payment terminal (PayPlus), the ways to get the goods
 * (pickup, delivery at a fixed price, free above an amount), how long stock is held while paying, and the switch itself.
 * The keys go to the server and are sealed there; this screen never sees them again — only "מחובר" and 4 characters.
 */
export function StoreSelling() {
  const { data, error, loading, setData } = useStoreData();
  if (loading) return <><PageHead title="מכירה באתר" /><p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p></>;
  if (error && !data) return <><PageHead title="מכירה באתר" /><Notice tone="error">{error}</Notice></>;
  if (!data?.store) return <><PageHead title="מכירה באתר" /><NeedsStore /></>;
  return <Selling store={data.store} setStore={(s) => setData((d) => (d ? { ...d, store: s } : d))} />;
}

type Msg = { tone: 'ok' | 'error' | 'warn' | 'info'; text: string } | null;

function Selling({ store, setStore }: { store: StoreRow; setStore: (s: StoreRow) => void }) {
  const c = store.checkout;
  const [terminal, setTerminal] = useState<TerminalInfo | null>(null);
  const [terminalError, setTerminalError] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState(() => formOf(c));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => { void terminalInfo().then((r) => (r.ok ? setTerminal(r.data) : setTerminalError(r.error))); }, []);

  const missing = sellingMissing(c, Boolean(terminal?.connected));
  const saveShipping = async () => {
    const r = checkCheckout(f);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    setBusy(true); setMsg(null);
    const u = await updateStore(store.id, r.patch);
    setBusy(false);
    if (!u.ok) { setMsg({ tone: 'error', text: u.error }); return; }
    setStore(u.data); setF(formOf(u.data.checkout));
    setMsg({ tone: 'ok', text: 'נשמר.' });
  };
  const toggle = async () => {
    setBusy(true); setMsg(null);
    const u = await updateStore(store.id, { checkout_enabled: !c.checkoutEnabled });
    setBusy(false);
    if (!u.ok) { setMsg({ tone: 'error', text: u.error }); return; }
    setStore(u.data);
    setMsg({ tone: 'ok', text: u.data.checkout.checkoutEnabled ? 'המכירה באתר פעילה (בדיקה): באתר מופיעים "הוספה לסל" והסל.' : 'המכירה באתר כבויה: באתר נשאר רק כפתור הוואטסאפ.' });
  };

  return (
    <>
      <PageHead title="מכירה באתר" sub="עגלה ותשלום באתר. הזמנה אמיתית נרשמת כמכירה: המלאי יורד, מופק מסמך והלקוח נכנס ללקוחות." />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {terminal?.liveOpen ? (terminal.mode !== 'live' && <Notice tone="warn">המסוף מחובר לסביבת הבדיקה: כל הזמנה היא „שולם (בדיקה)“ — בלי מכירה, בלי מלאי ובלי מסמך.</Notice>) : (
        <Notice tone="warn">
          מכירה אמיתית עוד סגורה במערכת: היא נפתחת רק אחרי אישור נפרד (גיבוי, רו״ח ורשות המסים, עורך דין). עד אז התשלום עובר בסביבת הבדיקה של PayPlus, וכל הזמנה מסומנת "שולם (בדיקה)" — בלי מכירה, בלי הורדת מלאי ובלי מסמך.
        </Notice>
      )}

      <Block title="המכירה באתר" id="switch" action={<Pill tone={c.checkoutEnabled ? 'ok' : 'default'}>{c.checkoutEnabled ? (terminal?.mode === 'live' && terminal.liveOpen ? 'פעילה' : 'פעילה (בדיקה)') : 'כבויה'}</Pill>}>
        {missing.length > 0 && !c.checkoutEnabled && (
          <div className="mb-3 text-sm">
            <p className="mb-1 font-semibold">לפני שמפעילים חסר:</p>
            <ul className="list-disc stack-y-1 ps-5">{missing.map((m) => <li key={m}>{SELLING_MISSING[m]}</li>)}</ul>
          </div>
        )}
        <label className="flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink-2">"הוספה לסל" ותשלום באתר</span>
          <Switch on={c.checkoutEnabled} onClick={() => void toggle()} disabled={busy || (!c.checkoutEnabled && missing.length > 0)}
            label='"הוספה לסל" ותשלום באתר' />
        </label>
        {c.checkoutEnabled && (
          <p className="mt-2 text-sm text-muted">
            אפשר לנסות הזמנה בעצמכם מהתצוגה המקדימה, גם לפני שהחנות באוויר. ההזמנות מופיעות ב<Link href={storeHref('orders')} className="text-primary underline underline-offset-2">הזמנות</Link>.
          </p>
        )}
      </Block>

      <PaymentTerminal terminal={terminal} error={terminalError} onChange={(t) => { setTerminal(t); setTerminalError(''); }} />
      <EmailDomainBlock />

      <Block title="איך מקבלים את ההזמנה" id="shipping" sub="לפחות אחת משתי הדרכים. המחיר מחושב בשרת, לא בדפדפן של הקונה.">
        <label className="mb-2 flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink-2">איסוף עצמי (חינם)</span>
          <Switch on={f.pickupEnabled} onClick={() => set('pickupEnabled', !f.pickupEnabled)} label="איסוף עצמי" />
        </label>
        {f.pickupEnabled && (
          <AreaRow label="איפה ומתי אוספים" value={f.pickupNote} onChange={(v) => set('pickupNote', v)} rows={2} max={200} placeholder="למשל: הרצל 10, תל אביב. א׳–ה׳ 10:00–18:00" />
        )}
        <label className="mb-2 flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink-2">משלוח עד הבית</span>
          <Switch on={f.deliveryEnabled} onClick={() => set('deliveryEnabled', !f.deliveryEnabled)} label="משלוח עד הבית" />
        </label>
        {f.deliveryEnabled && (
          <>
            <TextRow label="מחיר משלוח (₪)" value={f.deliveryPrice} onChange={(v) => set('deliveryPrice', v)} dir="ltr" placeholder="30" />
            <TextRow label="משלוח חינם מעל (₪, לא חובה)" value={f.freeDeliveryOver} onChange={(v) => set('freeDeliveryOver', v)} dir="ltr" placeholder="300"
              hint="הסכום נבדק אחרי ההנחה של הקופון." />
            <AreaRow label="הסבר על המשלוח (לא חובה)" value={f.deliveryNote} onChange={(v) => set('deliveryNote', v)} rows={2} max={200} placeholder="למשל: עד 5 ימי עסקים, לכל הארץ חוץ מאילת." />
          </>
        )}
        <TextRow label="כמה דקות המוצרים נשמרים לקונה בזמן התשלום" value={f.reserveMinutes} onChange={(v) => set('reserveMinutes', v)} dir="ltr"
          hint="בזמן הזה אף אחד אחר לא יכול לקנות את אותן יחידות — לא באתר ולא בקופה. בין 5 ל-60." />
        <Button variant="primary" disabled={busy} onClick={() => void saveShipping()}>{busy ? <><Spinner /> שומר…</> : 'שמירה'}</Button>
      </Block>

      <Block title="קופונים" id="coupons">
        <p className="text-sm text-muted">קוד הנחה באחוזים או בשקלים, עם תאריך סיום ומספר שימושים. <Link href={storeHref('coupons')} className="text-primary underline underline-offset-2">לניהול הקופונים</Link></p>
      </Block>
    </>
  );
}

const formOf = (c: CheckoutSettings) => ({
  reserveMinutes: String(c.reserveMinutes), pickupEnabled: c.pickupEnabled, pickupNote: c.pickupNote, deliveryEnabled: c.deliveryEnabled,
  deliveryPrice: c.deliveryPrice ? String(c.deliveryPrice) : '', freeDeliveryOver: c.freeDeliveryOver != null ? String(c.freeDeliveryOver) : '', deliveryNote: c.deliveryNote,
});

/**
 * The customers' emails (confirmation, shipped, refund) leave from the store's own domain once Resend verified it; until
 * then from the platform's sending address, if one is set — or they wait. "מאומת" only from Resend's own answer.
 */
function EmailDomainBlock() {
  const [d, setD] = useState<EmailDomain | null | undefined>(undefined);
  const [err, setErr] = useState('');
  const [domain, setDomain] = useState('');
  const [fromName, setFromName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const reload = () => loadEmailDomain().then((r) => { if (r.ok) { setD(r.data); setDomain(r.data?.domain ?? ''); setFromName(r.data?.fromName ?? ''); } else setErr(r.error); });
  useEffect(() => { void reload(); }, []);
  const connect = async () => {
    setBusy(true); setMsg(null);
    const r = await connectEmailDomain(domain, fromName);
    setBusy(false);
    if (!r.ok) setMsg({ tone: 'error', text: r.error }); else { setMsg({ tone: 'ok', text: 'נשמר. מוסיפים את הרשומות שלמטה ב-DNS של הדומיין, ואז „בדיקה“.' }); void reload(); }
  };
  const verify = async () => {
    setBusy(true); setMsg(null);
    const r = await verifyEmailDomain();
    setBusy(false);
    if (!r.ok) setMsg({ tone: 'error', text: r.error }); else { setMsg({ tone: r.data.status === 'verified' ? 'ok' : 'warn', text: EMAIL_DOMAIN_HE[r.data.status as keyof typeof EMAIL_DOMAIN_HE] ?? r.data.status }); void reload(); }
  };
  return (
    <Block title="מיילים ללקוחות" id="email" sub="אישור הזמנה, „נשלח“ והחזר נשלחים במייל מהדומיין של החנות. בלי פרסומות בהם.">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
      {d === undefined && !err ? <p className="flex items-center gap-2 text-muted"><Spinner /> בודק…</p> : <>
        {d && <p className="mb-3 text-sm"><Pill tone={d.status === 'verified' ? 'ok' : 'warn'}>{EMAIL_DOMAIN_HE[d.status]}</Pill> <bdi dir="ltr">orders@{d.domain}</bdi></p>}
        <form className="stack-y-1" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
          <TextRow label="הדומיין שממנו יוצאים המיילים" value={domain} onChange={setDomain} dir="ltr" />
          <TextRow label="שם השולח (לא חובה — אחרת שם החנות)" value={fromName} onChange={setFromName} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy || !domain.trim()}>{busy ? <><Spinner /> שומר…</> : d ? 'שמירה' : 'חיבור הדומיין'}</Button>
            {d && d.status !== 'verified' && <Button type="button" variant="ghost" disabled={busy} onClick={() => void verify()}>בדיקה</Button>}
          </div>
        </form>
        {d && d.status !== 'verified' && d.records.length > 0 && (
          <div className="mt-3 overflow-x-auto text-xs">
            <p className="mb-1 font-semibold">רשומות DNS להוספה:</p>
            <table className="w-full border-collapse" dir="ltr">
              <thead><tr><th className="border border-line p-1 text-start">Type</th><th className="border border-line p-1 text-start">Name</th><th className="border border-line p-1 text-start">Value</th></tr></thead>
              <tbody>{d.records.map((x, i) => <tr key={i}><td className="border border-line p-1">{x.type}{x.priority != null ? ` ${x.priority}` : ''}</td><td className="border border-line p-1 break-all">{x.name}</td><td className="border border-line p-1 break-all">{x.value}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </>}
    </Block>
  );
}
