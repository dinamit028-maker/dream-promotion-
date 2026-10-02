'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase, isCloudConfigured } from '@/lib/supabase/client';
import { Button, Card, Chip, Field, Input, PageHead, Select } from '@/components/ui/primitives';
import { EmptyState, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL, israelParts } from '@/lib/il-time';
import { CashRegister } from '@/components/ui/Icon';
import { phoneDigits, waLink } from '@/features/crm/crm';
import { METHODS, computeSale, ils, methodLabel, payRequestText, saleDay, salesCsv, summarize, type Line, type Method, type Sale } from './money';

/** Toolbox stage 3, part 1: price list, sell, record payments, reports. Records — not tax documents. */
type Item = { id: string; name: string; price: number; kind: 'service' | 'product'; active: boolean; sort: number };
type Settings = { businessType: 'exempt' | 'licensed'; vatRate: number; payLink: string };
const DEFAULTS: Settings = { businessType: 'licensed', vatRate: 18, payLink: '' };
const toSale = (r: any): Sale => ({
  id: r.id, leadId: r.lead_id, appointmentId: r.appointment_id, customerName: r.customer_name ?? '', customerPhone: r.customer_phone ?? '',
  items: r.items ?? [], subtotal: Number(r.subtotal), discount: Number(r.discount), total: Number(r.total), vatRate: Number(r.vat_rate), vatAmount: Number(r.vat_amount),
  method: r.method, status: r.status, note: r.note ?? '', paidAt: r.paid_at, createdAt: r.created_at,
});
const errText = (e: any) => /relation .* does not exist|schema cache/i.test(String(e?.message)) ? 'צריך להריץ את מיגרציית הקופה ב-Supabase (20261003001200).'
  : /pay_link_check/.test(String(e?.message)) ? 'קישור התשלום חייב להתחיל ב-https://' : 'משהו השתבש. נסו שוב.';

export function RegisterScreen() {
  const { userId, brand, leads, addLead, addActivity, updateLead } = useApp();
  const [tab, setTab] = useState<'sell' | 'sales' | 'catalog' | 'settings'>('sell');
  const [items, setItems] = useState<Item[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 3000); };

  // the sale being built
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState({ name: '', phone: '', leadId: '' as string | null, appointmentId: null as string | null });
  const [discount, setDiscount] = useState<{ kind: 'sum' | 'percent'; value: number }>({ kind: 'sum', value: 0 });
  const [method, setMethod] = useState<Method>('cash');
  const [paidNow, setPaidNow] = useState(true);
  const [note, setNote] = useState('');
  const [custom, setCustom] = useState({ name: '', price: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const sb = supabase();
      const since = new Date(Date.now() - 100 * 864e5).toISOString();
      const [st, it, sa] = await Promise.all([
        sb.from('register_settings').select('*').eq('user_id', userId).maybeSingle(),
        sb.from('catalog_items').select('*').eq('user_id', userId).order('sort').order('created_at'),
        sb.from('sales').select('*').eq('user_id', userId).or(`created_at.gte.${since},status.eq.pending`).order('created_at', { ascending: false }).limit(2000),
      ]);
      for (const r of [st, it, sa]) if (r.error) throw r.error;
      if (st.data) setSettings({ businessType: st.data.business_type, vatRate: Number(st.data.vat_rate), payLink: st.data.pay_link ?? '' });
      setItems((it.data ?? []).map((r: any) => ({ ...r, price: Number(r.price) })));
      setSales((sa.data ?? []).map(toSale));
      setError(null);
    } catch (e) { setError(errText(e)); }
    finally { setLoading(false); }
  }, [userId]);
  useEffect(() => { void load(); }, [load]);

  // arriving from an appointment ("💳 חיוב"): customer + service prefilled
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.get('name') && !q.get('item')) return;
    setCustomer({ name: q.get('name') ?? '', phone: q.get('phone') ?? '', leadId: q.get('lead'), appointmentId: q.get('appt') });
    if (q.get('item')) setLines([{ name: q.get('item')!, price: Number(q.get('price') || 0), qty: 1 }]);
    window.history.replaceState(null, '', '/register');
  }, []);

  const vat = { type: settings.businessType, rate: settings.vatRate };
  const t = computeSale(lines, discount, vat);
  const addLine = (name: string, price: number) => setLines((ls) => {
    const i = ls.findIndex((l) => l.name === name && l.price === price);
    return i >= 0 ? ls.map((l, k) => (k === i ? { ...l, qty: l.qty + 1 } : l)) : [...ls, { name, price, qty: 1 }];
  });
  const resetSale = () => { setLines([]); setCustomer({ name: '', phone: '', leadId: null, appointmentId: null }); setDiscount({ kind: 'sum', value: 0 }); setNote(''); setPaidNow(true); setMethod('cash'); };

  function crmPurchase(leadId: string, s: { total: number; items: Line[]; method: Method }) {
    addActivity(leadId, 'purchase', `${s.items.map((l) => l.name).join(' + ')} · ${ils(s.total)} · ${methodLabel(s.method)}`);
    const l = leads.find((x) => x.id === leadId);
    updateLead(leadId, { value: (l?.value ?? 0) + s.total, status: 'נסגר' });
  }

  async function saveSale() {
    if (!userId || !lines.length || t.total <= 0) return;
    setSaving(true);
    let leadId = customer.leadId || leads.find((l) => customer.phone && phoneDigits(l.phone) === phoneDigits(customer.phone))?.id || null;
    if (!leadId && customer.name.trim()) leadId = addLead({ name: customer.name.trim(), phone: customer.phone.trim(), source: 'קופה', date: israelParts(Date.now()).date, status: paidNow ? 'נסגר' : 'מעוניין', value: 0 });
    const now = new Date().toISOString();
    const m: Method = paidNow ? method : 'link';
    const { data, error: e } = await supabase().from('sales').insert({
      user_id: userId, lead_id: leadId, appointment_id: customer.appointmentId, customer_name: customer.name.trim(), customer_phone: customer.phone.trim(),
      items: lines.filter((l) => l.qty > 0), subtotal: t.subtotal, discount: t.discount, total: t.total, vat_rate: t.vatRate, vat_amount: t.vatAmount,
      method: m, status: paidNow ? 'paid' : 'pending', note, paid_at: paidNow ? now : null,
    }).select('*').single();
    setSaving(false);
    if (e) { setError(errText(e)); return; }
    const sale = toSale(data);
    setSales((all) => [sale, ...all]);
    if (leadId && paidNow) crmPurchase(leadId, sale);
    if (!paidNow) {
      if (leadId) addActivity(leadId, 'note', `נשלחה בקשת תשלום: ${ils(sale.total)}`);
      requestPayment(sale);
    }
    say(paidNow ? `נרשמה מכירה: ${ils(sale.total)}` : `נרשם לגבייה: ${ils(sale.total)}`);
    resetSale();
  }

  function requestPayment(s: Sale) {
    const url = settings.payLink && waLink(s.customerPhone, payRequestText({ name: s.customerName, total: s.total, items: s.items.map((l) => l.name).join(', '), business: brand.name, link: settings.payLink }));
    if (url) window.open(url, '_blank', 'noopener');
  }
  async function markPaid(s: Sale, m: Method) {
    const paid_at = new Date().toISOString();
    const { error: e } = await supabase().from('sales').update({ status: 'paid', method: m, paid_at }).eq('id', s.id);
    if (e) { setError(errText(e)); return; }
    setSales((all) => all.map((x) => (x.id === s.id ? { ...x, status: 'paid', method: m, paidAt: paid_at } : x)));
    if (s.leadId) crmPurchase(s.leadId, { ...s, method: m });
    say('סומן כשולם');
  }
  async function cancelSale(s: Sale) {
    if (!window.confirm('לבטל את הרישום? (אם התקבל כסף — החזר עושים בחברת הסליקה)')) return;
    const { error: e } = await supabase().from('sales').update({ status: 'cancelled' }).eq('id', s.id);
    if (e) { setError(errText(e)); return; }
    setSales((all) => all.map((x) => (x.id === s.id ? { ...x, status: 'cancelled' } : x)));
    if (s.leadId) addActivity(s.leadId, 'note', `בוטלה מכירה: ${ils(s.total)}`);
  }

  if (!isCloudConfigured || !userId) return (<><PageHead title="קופה" /><EmptyState icon={<CashRegister />} title="הקופה דורשת חשבון מחובר" body="התחברו לחשבון כדי לרשום מכירות." /></>);

  const pending = sales.filter((s) => s.status === 'pending');
  return (
    <>
      <PageHead title="קופה" sub={`היום: ${ils(summarize(sales, israelParts(Date.now()).date, israelParts(Date.now()).date).total)}${pending.length ? ` · ${pending.length} ממתינים לתשלום` : ''}`} />
      <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1">
        {([['sell', 'מכירה'], ['sales', 'מכירות ודוחות'], ['catalog', 'מחירון'], ['settings', 'הגדרות']] as const).map(([k, l]) => <Chip key={k} on={tab === k} onClick={() => setTab(k)}>{l}{k === 'sales' && pending.length ? ` (${pending.length})` : ''}</Chip>)}
      </div>
      {error && <p className="mb-4 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}
      {flash && <p className="mb-4 rounded-2xl bg-emerald-500/15 p-3 text-sm font-semibold text-emerald-700 dark:text-emerald-300">✓ {flash}</p>}
      {loading && <div className="py-8 text-center"><Spinner /></div>}

      {!loading && tab === 'sell' && (
        <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
          <div className="min-w-0">
            {items.filter((i) => i.active).length ? (
              <div className="mb-4 flex flex-wrap gap-2">
                {items.filter((i) => i.active).map((i) => (
                  <button key={i.id} type="button" onClick={() => addLine(i.name, i.price)} className="rounded-2xl border border-line bg-surface px-3 py-2 text-start hover:border-primary">
                    <span className="block text-sm font-semibold">{i.name}</span><span className="text-xs text-muted">{ils(i.price)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <button type="button" onClick={() => setTab('catalog')} className="mb-4 w-full rounded-2xl bg-primary-soft p-3 text-start text-sm"><strong>אין עדיין מחירון.</strong> הוסיפו טיפולים ומוצרים כדי למכור בלחיצה ←</button>
            )}
            <div className="mb-4 flex flex-wrap gap-2">
              <Input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="פריט חופשי" className="h-10 min-w-0 flex-1 basis-40" />
              <Input type="number" inputMode="decimal" value={custom.price} onChange={(e) => setCustom({ ...custom, price: e.target.value })} placeholder="₪" className="h-10 w-24" />
              <Button variant="ghost" onClick={() => { if (custom.name.trim() && Number(custom.price) > 0) { addLine(custom.name.trim(), Number(custom.price)); setCustom({ name: '', price: '' }); } }}>הוספה</Button>
            </div>
            <Field label="לקוח/ה (לא חובה)">
              <Input list="crm-names-register" value={customer.name} placeholder="שם — או בחירה מהלקוחות" onChange={(e) => {
                const name = e.target.value; const l = leads.find((x) => x.name === name);
                setCustomer({ ...customer, name, phone: l?.phone ?? customer.phone, leadId: l?.id ?? null });
              }} />
              <datalist id="crm-names-register">{leads.slice(0, 300).map((l) => <option key={l.id} value={l.name} />)}</datalist>
            </Field>
            <Field label="טלפון"><Input value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} inputMode="tel" dir="ltr" /></Field>
          </div>

          <Card className="h-fit p-4">
            <p className="mb-2 font-bold">החשבון</p>
            {!lines.length && <p className="py-4 text-center text-sm text-muted">בחרו פריטים מהמחירון</p>}
            <ul className="grid gap-1.5">
              {lines.map((l, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  <button type="button" className="h-7 w-7 rounded-full border border-line" onClick={() => setLines(lines.map((x, k) => (k === i ? { ...x, qty: x.qty - 1 } : x)).filter((x) => x.qty > 0))} aria-label="פחות">−</button>
                  <span className="w-5 text-center tabular-nums">{l.qty}</span>
                  <button type="button" className="h-7 w-7 rounded-full border border-line" onClick={() => setLines(lines.map((x, k) => (k === i ? { ...x, qty: x.qty + 1 } : x)))} aria-label="עוד">+</button>
                  <span className="w-20 text-end tabular-nums">{ils(l.price * l.qty)}</span>
                </li>
              ))}
            </ul>
            {lines.length > 0 && <>
              <div className="mt-3 flex items-center gap-2 text-sm">
                <span>הנחה</span>
                <Input type="number" inputMode="decimal" value={discount.value || ''} onChange={(e) => setDiscount({ ...discount, value: Number(e.target.value) })} className="h-8 w-20 py-1" aria-label="הנחה" />
                <Select value={discount.kind} onChange={(e) => setDiscount({ ...discount, kind: e.target.value as 'sum' | 'percent' })} className="h-8 w-20 py-1" aria-label="סוג הנחה">
                  <option value="sum">₪</option><option value="percent">%</option>
                </Select>
              </div>
              <div className="mt-3 border-t border-line pt-3">
                {t.discount > 0 && <p className="flex justify-between text-sm text-muted"><span>הנחה</span><span>−{ils(t.discount)}</span></p>}
                <p className="flex justify-between text-2xl font-black"><span>סה״כ</span><span className="tabular-nums">{ils(t.total)}</span></p>
                <p className="text-xs text-muted">{settings.businessType === 'licensed' ? `כולל מע״מ ${settings.vatRate}%: ${ils(t.vatAmount)}` : 'עוסק פטור — ללא מע״מ'}</p>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="מצב תשלום">
                <Chip on={paidNow} onClick={() => setPaidNow(true)}>שולם עכשיו</Chip>
                <Chip on={!paidNow} onClick={() => setPaidNow(false)}>בקשת תשלום</Chip>
              </div>
              {paidNow ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {METHODS.filter((m) => m.id !== 'link').map((m) => <Chip key={m.id} on={method === m.id} onClick={() => setMethod(m.id)}>{m.icon} {m.label}</Chip>)}
                </div>
              ) : (
                <p className="mt-2 text-xs text-ink-2">
                  {!settings.payLink ? <>הגדירו קישור תשלום (PayPlus / ClickPay / Bit) ב<button type="button" className="text-primary underline" onClick={() => setTab('settings')}>הגדרות</button>, ואז הוואטסאפ ייפתח עם בקשת תשלום.</>
                    : !waLink(customer.phone) ? 'הוסיפו טלפון של הלקוח/ה כדי לשלוח בוואטסאפ.'
                    : 'ייפתח וואטסאפ עם הסכום והקישור. כשהכסף מגיע — סמנו "שולם" ב"מכירות".'}
                </p>
              )}
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="הערה (לא חובה)" className="mt-3 h-9 py-1" />
              <Button variant="primary" size="lg" className="mt-3 w-full" onClick={saveSale} disabled={saving || t.total <= 0}>
                {saving ? 'שומר…' : paidNow ? `רישום מכירה · ${ils(t.total)}` : `שליחת בקשה · ${ils(t.total)}`}
              </Button>
              <button type="button" className="mt-2 w-full text-xs text-muted" onClick={resetSale}>ניקוי</button>
            </>}
          </Card>
        </div>
      )}

      {!loading && tab === 'sales' && <SalesTab sales={sales} onPaid={markPaid} onCancel={cancelSale} onRemind={requestPayment} canRemind={Boolean(settings.payLink)} />}

      {!loading && tab === 'catalog' && <CatalogTab userId={userId} items={items} reload={load} onError={(e) => setError(errText(e))} />}

      {!loading && tab === 'settings' && (
        <Card className="p-4">
          <Field label="סוג העסק">
            <div className="flex gap-2">
              <Chip on={settings.businessType === 'licensed'} onClick={() => setSettings({ ...settings, businessType: 'licensed' })}>עוסק מורשה (מע״מ)</Chip>
              <Chip on={settings.businessType === 'exempt'} onClick={() => setSettings({ ...settings, businessType: 'exempt' })}>עוסק פטור</Chip>
            </div>
          </Field>
          {settings.businessType === 'licensed' && <Field label="שיעור מע״מ %"><Input type="number" value={settings.vatRate} onChange={(e) => setSettings({ ...settings, vatRate: Number(e.target.value) })} className="w-28" /></Field>}
          <Field label="קישור תשלום לשליחה ללקוחות (לא חובה)">
            <Input value={settings.payLink} onChange={(e) => setSettings({ ...settings, payLink: e.target.value.trim() })} placeholder="https://… (דף תשלום של PayPlus / ClickPay / Bit לעסקים)" dir="ltr" />
          </Field>
          <Button variant="primary" onClick={async () => {
            const { error: e } = await supabase().from('register_settings').upsert({ user_id: userId, business_type: settings.businessType, vat_rate: settings.vatRate, pay_link: settings.payLink });
            if (e) setError(errText(e)); else { setError(null); say('ההגדרות נשמרו'); }
          }}>שמירה</Button>
          <p className="mt-4 rounded-2xl bg-surface-2 p-3 text-xs text-ink-2">
            הקופה רושמת מכירות ומפיקה דוחות. היא <strong>לא מפיקה חשבוניות מס או קבלות</strong> — את אלה ממשיכים להפיק במערכת החשבוניות שלכם (בשלב הבא נחבר אותה כך שזה יקרה אוטומטית).
          </p>
        </Card>
      )}
    </>
  );
}

function SalesTab({ sales, onPaid, onCancel, onRemind, canRemind }: { sales: Sale[]; onPaid: (s: Sale, m: Method) => void; onCancel: (s: Sale) => void; onRemind: (s: Sale) => void; canRemind: boolean }) {
  const today = israelParts(Date.now()).date;
  const thisMonth = today.slice(0, 7);
  const prev = israelParts(new Date(`${thisMonth}-01T12:00:00Z`).getTime() - 864e5).date.slice(0, 7);
  const [period, setPeriod] = useState<'today' | 'month' | 'prev'>('today');
  const range = period === 'today' ? [today, today] : period === 'month' ? [`${thisMonth}-01`, `${thisMonth}-31`] : [`${prev}-01`, `${prev}-31`];
  const sum = useMemo(() => summarize(sales, range[0], range[1]), [sales, range[0], range[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = sales.filter((s) => saleDay(s) >= range[0] && saleDay(s) <= range[1]);
  const pending = sales.filter((s) => s.status === 'pending');
  const [payMethod, setPayMethod] = useState<Method>('link');
  function exportCsv() {
    const blob = new Blob([salesCsv(sales, range[0], range[1])], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `מכירות-${range[0]}${range[1] !== range[0] ? `-${range[1]}` : ''}.csv`; a.click();
  }
  return (
    <>
      {pending.length > 0 && (
        <Card className="mb-4 p-3">
          <p className="mb-2 font-bold">ממתינים לתשלום · {ils(pending.reduce((a, s) => a + s.total, 0))}</p>
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">שולם ב:
            {METHODS.map((m) => <Chip key={m.id} on={payMethod === m.id} onClick={() => setPayMethod(m.id)}>{m.label}</Chip>)}
          </div>
          <div className="grid grid-cols-1 gap-2">
            {pending.map((s) => (
              <div key={s.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate"><strong>{s.customerName || 'ללא שם'}</strong> · {ils(s.total)} · {formatIL(s.createdAt, { dateStyle: 'short' })}</span>
                <Button size="sm" variant="primary" onClick={() => onPaid(s, payMethod)}>שולם ✓</Button>
                {canRemind && waLink(s.customerPhone) && <Button size="sm" variant="ghost" onClick={() => onRemind(s)}>💬 תזכורת</Button>}
                <Button size="sm" variant="ghost" onClick={() => onCancel(s)}>ביטול</Button>
              </div>
            ))}
          </div>
        </Card>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {([['today', 'היום'], ['month', 'החודש'], ['prev', 'חודש קודם']] as const).map(([k, l]) => <Chip key={k} on={period === k} onClick={() => setPeriod(k)}>{l}</Chip>)}
        <Button size="sm" variant="ghost" onClick={exportCsv}>ייצוא לאקסל</Button>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card className="p-3"><span className="block text-xs text-muted">הכנסות</span><strong className="text-xl tabular-nums">{ils(sum.total)}</strong></Card>
        <Card className="p-3"><span className="block text-xs text-muted">מכירות</span><strong className="text-xl tabular-nums">{sum.count}</strong></Card>
        <Card className="p-3"><span className="block text-xs text-muted">מתוכו מע״מ</span><strong className="text-xl tabular-nums">{ils(sum.vat)}</strong></Card>
        <Card className="p-3"><span className="block text-xs text-muted">ממתין</span><strong className="text-xl tabular-nums">{ils(sum.pendingTotal)}</strong></Card>
      </div>
      {sum.byMethod.length > 0 && (
        <p className="mb-4 text-sm text-ink-2">{sum.byMethod.map((m) => `${methodLabel(m.method)} ${ils(m.total)} (${m.count})`).join(' · ')}</p>
      )}
      <div className="grid grid-cols-1 gap-2">
        {list.map((s) => (
          <div key={s.id} className={cx('flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-sm', s.status === 'cancelled' && 'opacity-50')}>
            <span className="min-w-0 flex-1">
              <strong className="block truncate">{s.customerName || 'ללא שם'} · {s.items.map((l) => l.name).join(' + ')}</strong>
              <span className="text-xs text-muted">{formatIL(s.paidAt ?? s.createdAt, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric' })} · {methodLabel(s.method)} · {s.status === 'paid' ? 'שולם' : s.status === 'pending' ? 'ממתין' : 'בוטל'}</span>
            </span>
            <strong className="tabular-nums">{ils(s.total)}</strong>
            {s.status === 'paid' && <button type="button" className="text-xs text-muted" onClick={() => onCancel(s)} aria-label="ביטול">✕</button>}
          </div>
        ))}
        {!list.length && <p className="py-6 text-center text-sm text-muted">אין מכירות בתקופה הזו.</p>}
      </div>
    </>
  );
}

function CatalogTab({ userId, items, reload, onError }: { userId: string; items: Item[]; reload: () => void; onError: (e: unknown) => void }) {
  const [d, setD] = useState({ name: '', price: '', kind: 'service' as 'service' | 'product' });
  const run = async (p: PromiseLike<{ error: any }>) => { const { error } = await p; if (error) onError(error); else reload(); };
  async function importServices() {
    const { data, error } = await supabase().from('booking_services').select('name, price').eq('user_id', userId).eq('active', true);
    if (error) return onError(error);
    const fresh = (data ?? []).filter((s: any) => s.price != null && !items.some((i) => i.name === s.name));
    if (!fresh.length) return;
    await run(supabase().from('catalog_items').insert(fresh.map((s: any, k: number) => ({ user_id: userId, name: s.name, price: Number(s.price), kind: 'service', sort: items.length + k }))));
  }
  return (
    <div className="grid gap-3">
      {items.map((i) => (
        <Card key={i.id} className="flex min-w-0 flex-wrap items-center gap-2 p-3">
          <span className="min-w-0 flex-1"><strong className={cx('block truncate', !i.active && 'text-muted line-through')}>{i.name}</strong><span className="text-xs text-muted">{ils(i.price)} · {i.kind === 'service' ? 'שירות' : 'מוצר'}</span></span>
          <Button size="sm" variant="ghost" onClick={() => run(supabase().from('catalog_items').update({ active: !i.active }).eq('id', i.id))}>{i.active ? 'הסתרה' : 'הצגה'}</Button>
          <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`למחוק את "${i.name}"? מכירות קודמות לא ישתנו.`)) void run(supabase().from('catalog_items').delete().eq('id', i.id)); }}>מחיקה</Button>
        </Card>
      ))}
      <Card className="p-3">
        <p className="mb-2 text-sm font-semibold">פריט חדש</p>
        <div className="grid gap-2 sm:grid-cols-[1fr_120px_130px_auto]">
          <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="למשל: הסרת שיער — רגליים" />
          <Input type="number" inputMode="decimal" value={d.price} onChange={(e) => setD({ ...d, price: e.target.value })} placeholder="מחיר ₪" />
          <Select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as 'service' | 'product' })}><option value="service">שירות</option><option value="product">מוצר</option></Select>
          <Button variant="primary" disabled={!d.name.trim() || !(Number(d.price) >= 0) || d.price === ''} onClick={async () => {
            await run(supabase().from('catalog_items').insert({ user_id: userId, name: d.name.trim(), price: Number(d.price), kind: d.kind, sort: items.length }));
            setD({ name: '', price: '', kind: d.kind });
          }}>הוספה</Button>
        </div>
        <button type="button" className="mt-3 text-sm font-semibold text-primary" onClick={importServices}>ייבוא השירותים מזימון התורים (עם מחיר)</button>
      </Card>
    </div>
  );
}
