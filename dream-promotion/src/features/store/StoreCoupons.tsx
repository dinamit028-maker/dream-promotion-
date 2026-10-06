'use client';
import { useEffect, useState } from 'react';
import { Button, PageHead, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Switch } from '@/features/catalog/PublishSwitch';
import { checkCoupon, COUPON_STATE, couponLabel, couponState, type Coupon, type CouponForm } from './checkout';
import { deleteCoupon, loadCoupons, saveCoupon, setCouponActive } from './data';
import { Block, NeedsStore, Notice, TextRow } from './ui';
import { useStoreData } from './useStoreData';

/**
 * "קופונים" (2.56): a basic coupon — a percent or an amount off the products, until a date, a number of uses, a minimum.
 * The cart and the checkout check it again in the database; how many times it was used is counted there (a paid order).
 */
export function StoreCoupons() {
  const { data, loading, error } = useStoreData();
  const [list, setList] = useState<Coupon[] | null>(null);
  const [listError, setListError] = useState('');
  useEffect(() => { void loadCoupons().then((r) => (r.ok ? setList(r.data) : setListError(r.error))); }, []);
  if (loading) return <><PageHead title="קופונים" /><p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p></>;
  if (error && !data) return <><PageHead title="קופונים" /><Notice tone="error">{error}</Notice></>;
  if (!data?.store) return <><PageHead title="קופונים" /><NeedsStore /></>;
  const storeId = data.store.id;
  return (
    <>
      <PageHead title="קופונים" sub="קוד שהקונה מזין בסל. ההנחה חלה על המוצרים, לא על המשלוח." />
      {listError && <Notice tone="error">{listError}</Notice>}
      <NewCoupon storeId={storeId} onSaved={(c) => setList((l) => [c, ...(l ?? [])])} />
      <Block title="הקופונים">
        {!list ? <p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p> : list.length === 0 ? <p className="text-muted">עוד אין קופונים.</p> : (
          <ul className="divide-y divide-line">
            {list.map((c) => <CouponItem key={c.id} c={c} onChange={(n) => setList((l) => (l ?? []).map((x) => (x.id === n.id ? n : x)))}
              onDeleted={() => setList((l) => (l ?? []).filter((x) => x.id !== c.id))} />)}
          </ul>
        )}
      </Block>
    </>
  );
}

function NewCoupon({ storeId, onSaved }: { storeId: string; onSaved: (c: Coupon) => void }) {
  const empty: CouponForm = { code: '', kind: 'percent', value: '', minSubtotal: '', endsOn: '', maxUses: '' };
  const [f, setF] = useState<CouponForm>(empty);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const set = <K extends keyof CouponForm>(k: K, v: CouponForm[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Block title="קופון חדש">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <form onSubmit={async (e) => {
        e.preventDefault();
        const r = checkCoupon(f);
        if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
        setBusy(true); setMsg(null);
        const s = await saveCoupon(storeId, null, r.row);
        setBusy(false);
        if (!s.ok) { setMsg({ tone: 'error', text: s.error }); return; }
        onSaved(s.data); setF(empty); setMsg({ tone: 'ok', text: `הקופון ${s.data.code} נשמר.` });
      }}>
        <TextRow label="קוד" value={f.code} onChange={(v) => set('code', v.toUpperCase())} dir="ltr" placeholder="WELCOME10" max={30} />
        <fieldset className="mb-3">
          <legend className="mb-2 text-sm font-semibold text-ink-2">סוג ההנחה</legend>
          <div className="flex gap-4">
            {(['percent', 'amount'] as const).map((k) => (
              <label key={k} className="flex min-h-11 items-center gap-2">
                <input type="radio" name="kind" checked={f.kind === k} onChange={() => set('kind', k)} />
                {k === 'percent' ? 'אחוזים' : 'שקלים'}
              </label>
            ))}
          </div>
        </fieldset>
        <TextRow label={f.kind === 'percent' ? 'כמה אחוזים' : 'כמה שקלים'} value={f.value} onChange={(v) => set('value', v)} dir="ltr" placeholder={f.kind === 'percent' ? '10' : '20'} />
        <TextRow label="מסכום (₪, לא חובה)" value={f.minSubtotal} onChange={(v) => set('minSubtotal', v)} dir="ltr" placeholder="100" />
        <TextRow label="בתוקף עד (לא חובה)" value={f.endsOn} onChange={(v) => set('endsOn', v)} type="date" dir="ltr" hint="כולל היום הזה." />
        <TextRow label="מספר שימושים (לא חובה)" value={f.maxUses} onChange={(v) => set('maxUses', v)} dir="ltr" hint="ריק = בלי הגבלה. נספר רק תשלום שאושר." />
        <Button type="submit" variant="primary" disabled={busy || !f.code || !f.value}>{busy ? <><Spinner /> שומר…</> : 'שמירת הקופון'}</Button>
      </form>
    </Block>
  );
}

function CouponItem({ c, onChange, onDeleted }: { c: Coupon; onChange: (c: Coupon) => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const state = couponState(c);
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-bold" dir="ltr">{c.code}</p>
        <p className="text-sm text-muted">
          {couponLabel(c)}{c.minSubtotal > 0 ? ` · מ-₪${c.minSubtotal}` : ''}{c.endsAt ? ` · עד ${new Date(c.endsAt).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })}` : ''}
          {` · שימושים: ${c.usedCount}${c.maxUses != null ? ` מתוך ${c.maxUses}` : ''}`}
        </p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </div>
      <Pill tone={state === 'active' ? 'ok' : state === 'off' ? 'default' : 'warn'}>{COUPON_STATE[state]}</Pill>
      <Switch on={c.active} label={`קופון ${c.code} פעיל`} onClick={async () => {
        if (busy) return;
        setBusy(true); setError('');
        const r = await setCouponActive(c.id, !c.active);
        setBusy(false);
        if (r.ok) onChange(r.data); else setError(r.error);
      }} />
      <button type="button" className="min-h-11 text-sm font-semibold text-red-700 underline underline-offset-2" disabled={busy} onClick={async () => {
        if (!window.confirm(`למחוק את הקופון ${c.code}? הזמנות שכבר השתמשו בו לא משתנות.`)) return;
        setBusy(true); const r = await deleteCoupon(c.id); setBusy(false);
        if (r.ok) onDeleted(); else setError(r.error);
      }}>מחיקה</button>
    </li>
  );
}
