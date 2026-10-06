'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, PageHead, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Switch } from '@/features/catalog/PublishSwitch';
import { checkCheckout, checkTerminal, SELLING_MISSING, sellingMissing, type CheckoutSettings, type TerminalInfo } from './checkout';
import { connectTerminal, disconnectTerminal, terminalInfo, updateStore } from './data';
import { storeHref } from './routes';
import type { StoreRow } from './store';
import { AreaRow, Block, NeedsStore, Notice, TextRow } from './ui';
import { useStoreData } from './useStoreData';

/**
 * "מכירה באתר" (2.56, stage 3 — test only): the payment terminal (PayPlus, its test environment), the ways to get the goods
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
      <PageHead title="מכירה באתר" sub="עגלה ותשלום באתר. בשלב הזה הכול בסביבת בדיקה: אף אחד לא מחויב באמת, ולא נוצרת מכירה או מסמך." />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Notice tone="warn">
        שלב בדיקה: התשלום עובר בסביבת הבדיקה של PayPlus בלבד. הזמנה ששולמה מסומנת "שולם (בדיקה)" — בלי מכירה, בלי הורדת מלאי ובלי מסמך. מכירה אמיתית מתחילה בשלב 4.
      </Notice>

      <Block title="המכירה באתר" id="switch" action={<Pill tone={c.checkoutEnabled ? 'ok' : 'default'}>{c.checkoutEnabled ? 'פעילה (בדיקה)' : 'כבויה'}</Pill>}>
        {missing.length > 0 && !c.checkoutEnabled && (
          <div className="mb-3 text-sm">
            <p className="mb-1 font-semibold">לפני שמפעילים חסר:</p>
            <ul className="list-disc space-y-1 ps-5">{missing.map((m) => <li key={m}>{SELLING_MISSING[m]}</li>)}</ul>
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

      <Terminal terminal={terminal} error={terminalError} onChange={(t) => { setTerminal(t); setTerminalError(''); }} />

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

function Terminal({ terminal, error, onChange }: { terminal: TerminalInfo | null; error: string; onChange: (t: TerminalInfo) => void }) {
  const [f, setF] = useState({ apiKey: '', secretKey: '', pageUid: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const connect = async () => {
    const t = checkTerminal(f);
    if (!t.ok) { setMsg({ tone: 'error', text: t.error }); return; }
    setBusy(true); setMsg(null);
    const r = await connectTerminal(t.keys.api_key, t.keys.secret_key, t.pageUid);
    setBusy(false);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    setF({ apiKey: '', secretKey: '', pageUid: '' });
    onChange(r.data);
    setMsg({ tone: 'ok', text: 'המסוף נשמר. הוא ייבדק בפועל בהזמנת הבדיקה הראשונה.' });
  };
  return (
    <Block title="מסוף סליקה — PayPlus (סביבת בדיקה)" id="terminal" sub="הקונה מזין את הכרטיס בעמוד של PayPlus, לא אצלנו. PayPlus לא מפיק חשבונית — המסמכים יוצאים מהמערכת (שלב 4).">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {!terminal && !error ? <p className="flex items-center gap-2 text-muted"><Spinner /> בודק…</p> : terminal?.connected ? (
        <div className="space-y-3">
          <p className="text-sm">
            <Pill tone="ok">מחובר</Pill>{' '}
            <span className="text-muted">PayPlus · {terminal.mode === 'test' ? 'סביבת בדיקה' : 'אמיתי'} · מפתח שמסתיים ב-<bdi dir="ltr">{terminal.hint}</bdi></span>
          </p>
          <p className="text-xs text-muted">"מחובר" = המפתחות נשמרו. עוד לא נבדק מול PayPlus — זה קורה בהזמנת הבדיקה הראשונה.</p>
          <Button variant="ghost" disabled={busy} onClick={async () => {
            if (!window.confirm('להסיר את המסוף? המכירה באתר תיכבה.')) return;
            setBusy(true); const r = await disconnectTerminal(); setBusy(false);
            if (!r.ok) setMsg({ tone: 'error', text: r.error }); else { onChange(r.data); setMsg({ tone: 'ok', text: 'המסוף הוסר והמכירה באתר כבויה.' }); }
          }}>הסרת המסוף</Button>
        </div>
      ) : (
        <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); void connect(); }} autoComplete="off">
          {terminal && !terminal.ready && <Notice tone="warn">השרת עוד לא מוכן לשמור מפתחות סליקה: צריך להגדיר PAYMENT_SEAL_KEY ב-Vercel (בשני הפרויקטים, אותו ערך).</Notice>}
          <p className="mb-2 text-sm text-muted">ב-PayPlus (חשבון הבדיקה): הגדרות ← API. מעתיקים לכאן את שלושת הערכים.</p>
          <TextRow label="API key" value={f.apiKey} onChange={(v) => setF((x) => ({ ...x, apiKey: v }))} dir="ltr" />
          <TextRow label="Secret key" value={f.secretKey} onChange={(v) => setF((x) => ({ ...x, secretKey: v }))} dir="ltr" type="password" />
          <TextRow label="Payment page UID" value={f.pageUid} onChange={(v) => setF((x) => ({ ...x, pageUid: v }))} dir="ltr" />
          <Button type="submit" variant="primary" disabled={busy || !f.apiKey || !f.secretKey || !f.pageUid}>{busy ? <><Spinner /> שומר…</> : 'חיבור המסוף'}</Button>
        </form>
      )}
    </Block>
  );
}
