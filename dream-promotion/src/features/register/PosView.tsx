'use client';
import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';
import { matches, phoneDigits, waLink } from '@/features/crm/crm';
import type { Lead } from '@/types';
import { computeSale, customerSnapshot, ils, methodLabel, remaining, topSellers, type Line, type Method, type Pay, type Sale } from './money';

/**
 * The register, touch-first (UX redesign — same sales logic, CRM link, VAT and documents underneath).
 * Desktop / physical POS: CART | BUTTONS. Phone: buttons + a sticky cart bar that opens a bottom sheet.
 * A normal sale: tap an item → "לתשלום" → tap a payment method.
 */
export type PosItem = { id: string; name: string; price: number; kind: 'service' | 'product' | 'package' | 'other'; active: boolean; favorite: boolean; favOrder: number; imageUrl: string };
export type TodayAppt = { id: string; name: string; phone: string; leadId: string | null; serviceName: string; start: string; price: number | null };
export type Customer = { name: string; phone: string; leadId: string | null; appointmentId: string | null };
export interface CheckoutInput {
  lines: Line[]; discount: { kind: 'sum' | 'percent'; value: number }; customer: Customer; note: string;
  employee: { id: string; name: string } | null; paidNow: boolean; method: Method; payments: Pay[];
  /** cash: what the customer handed over (the change is computed from it) */
  cashReceived?: number;
}
export interface CheckoutResult { ok: boolean; sale?: Sale; docLabel?: string; docUrl?: string; error?: string }

const CATS = [
  { id: 'fav', label: '❤️ מועדפים' }, { id: 'top', label: '🔥 הכי נמכרים' }, { id: 'service', label: '✨ טיפולים' },
  { id: 'product', label: '🛍️ מוצרים' }, { id: 'package', label: '🎁 חבילות' }, { id: 'other', label: '••• אחר' },
] as const;
type Cat = (typeof CATS)[number]['id'] | 'all';
const PAY_BUTTONS: { id: Exclude<Method, 'split' | 'link'>; label: string; icon: string }[] = [
  { id: 'card', label: 'אשראי', icon: '💳' }, { id: 'cash', label: 'מזומן', icon: '💵' }, { id: 'transfer', label: 'העברה', icon: '🏦' },
  { id: 'bit', label: 'Bit / PayBox', icon: '📱' }, { id: 'other', label: 'אחר', icon: '➕' },
];
const EMPTY: Customer = { name: '', phone: '', leadId: null, appointmentId: null };
/** quick cash buttons: exact, the next round amounts, common notes */
export function cashSuggestions(total: number) {
  const up = (step: number) => Math.ceil(total / step) * step;
  return [...new Set([total, up(10), up(50), up(100), up(200), 200, 500].filter((v) => v >= total))].sort((a, b) => a - b).slice(0, 6);
}

export function PosView({ items, sales, leads, employees, todayAppts, vat, payLinkReady, onCheckout, onShowDoc, prefill, onGoCatalog }: {
  items: PosItem[]; sales: Sale[]; leads: Lead[]; employees: { id: string; name: string }[]; todayAppts: TodayAppt[];
  vat: { type: 'exempt' | 'licensed'; rate: number }; payLinkReady: boolean;
  onCheckout: (c: CheckoutInput) => Promise<CheckoutResult>; onShowDoc: () => void;
  prefill?: { customer: Customer; line: Line | null } | null; onGoCatalog?: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Customer>(EMPTY);
  const [discount, setDiscount] = useState<{ kind: 'sum' | 'percent'; value: number }>({ kind: 'sum', value: 0 });
  const [note, setNote] = useState('');
  const [extras, setExtras] = useState<{ discount: boolean; note: boolean }>({ discount: false, note: false });
  const [employeeId, setEmployeeId] = useState('');
  const [cat, setCat] = useState<Cat>('fav');
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [picker, setPicker] = useState(false);
  const [keypad, setKeypad] = useState(false);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState<CheckoutResult & { customer: string; phone: string; change: number | null } | null>(null);
  const [waPhone, setWaPhone] = useState('');

  useEffect(() => { try { setQuick(localStorage.getItem('dp-pos-quick') === '1'); setEmployeeId(localStorage.getItem('dp-pos-employee') ?? ''); } catch { /* private mode */ } }, []);
  useEffect(() => { if (!items.some((i) => i.favorite && i.active)) setCat('all'); }, [items]);
  useEffect(() => { if (prefill) { setCustomer(prefill.customer); if (prefill.line) setLines([prefill.line]); } }, [prefill]);
  const toggleQuick = () => { const v = !quick; setQuick(v); try { localStorage.setItem('dp-pos-quick', v ? '1' : '0'); } catch { /* ignore */ } };
  const pickEmployee = (id: string) => { setEmployeeId(id); try { localStorage.setItem('dp-pos-employee', id); } catch { /* ignore */ } };

  const t = computeSale(lines, discount, vat);
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const top = useMemo(() => topSellers(sales), [sales]);
  const active = items.filter((i) => i.active);
  const shown = useMemo(() => {
    const s = q.trim();
    if (s) return active.filter((i) => i.name.includes(s) || i.name.toLowerCase().includes(s.toLowerCase()));
    if (cat === 'fav') return active.filter((i) => i.favorite).sort((a, b) => a.favOrder - b.favOrder);
    if (cat === 'top') return top.map((n) => active.find((i) => i.name === n)).filter(Boolean) as PosItem[];
    if (cat === 'all') return active;
    return active.filter((i) => i.kind === cat);
  }, [active, cat, q, top]);
  const peopleHits = q.trim().length >= 2 ? leads.filter((l) => matches(l, q)).slice(0, 4) : [];

  const add = (name: string, price: number, qty = 1) => setLines((ls) => {
    const i = ls.findIndex((l) => l.name === name && l.price === price);
    return i >= 0 ? ls.map((l, k) => (k === i ? { ...l, qty: l.qty + qty } : l)) : [...ls, { name, price, qty }];
  });
  const setQty = (i: number, d: number) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));
  const chooseLead = (l: Lead | null) => { setCustomer(l ? { name: l.name, phone: l.phone, leadId: l.id, appointmentId: null } : EMPTY); setPicker(false); setQ(''); };
  const fromAppt = (a: TodayAppt) => {
    setCustomer({ name: a.name, phone: a.phone, leadId: a.leadId, appointmentId: a.id });
    const item = active.find((i) => i.name === a.serviceName);
    add(a.serviceName || 'טיפול', item?.price ?? a.price ?? 0);
  };
  const snap = customer.leadId ? customerSnapshot(customer.leadId, sales) : null;
  const lead = customer.leadId ? leads.find((l) => l.id === customer.leadId) : null;
  const apptToday = customer.leadId ? todayAppts.find((a) => a.leadId === customer.leadId) : null;
  const reset = () => { setWaPhone(''); setLines([]); setCustomer(EMPTY); setDiscount({ kind: 'sum', value: 0 }); setNote(''); setExtras({ discount: false, note: false }); setDone(null); setSheet(false); };
  const employee = employees.find((e) => e.id === employeeId) ?? null;

  async function finish(c: Pick<CheckoutInput, 'paidNow' | 'method' | 'payments' | 'cashReceived'>) {
    const r = await onCheckout({ lines, discount, customer, note, employee, ...c });
    if (r.ok) {
      // the sold items leave the cart immediately — nothing can be charged twice behind the confirmation
      const who = customer.name || 'לקוח מזדמן'; const phone = customer.phone;
      setLines([]); setCustomer(EMPTY); setDiscount({ kind: 'sum', value: 0 }); setNote(''); setExtras({ discount: false, note: false });
      setPaying(false); setSheet(false); setDone({ ...r, customer: who, phone, change: c.cashReceived != null ? Math.round((c.cashReceived - (r.sale?.total ?? 0)) * 100) / 100 : null });
    }
    return r;
  }

  const cart = (
    <div className="flex min-h-0 flex-col">
      {/* customer */}
      <div className="mb-3 rounded-2xl bg-surface-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => setPicker(true)} className="min-w-0 text-start">
            <span className="block text-xs text-muted">לקוח/ה</span>
            <strong className="block truncate">{customer.name || 'לקוח מזדמן'}</strong>
            {customer.phone && <span className="text-xs text-muted" dir="ltr">{customer.phone}</span>}
          </button>
          <span className="flex shrink-0 gap-1.5">
            {lead?.tags?.slice(0, 2).map((tg) => <span key={tg} className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-bold">{tg}</span>)}
            <Button size="sm" variant="ghost" onClick={() => setPicker(true)}>{customer.name ? 'החלפה' : 'בחר לקוח'}</Button>
          </span>
        </div>
        {snap && (snap.lastPurchase || apptToday) && (
          <div className="mt-2 border-t border-line pt-2 text-xs text-ink-2">
            {snap.lastPurchase && <p>רכישה אחרונה: {snap.lastPurchase.items.map((l) => l.name).join(' + ')} · {formatIL(snap.lastPurchase.paidAt ?? snap.lastPurchase.createdAt, { dateStyle: 'short' })}</p>}
            {apptToday && <p>תור היום: {apptToday.serviceName} · {formatIL(apptToday.start, { hour: '2-digit', minute: '2-digit' })}</p>}
            {snap.lastPurchase && <button type="button" className="mt-1 font-semibold text-primary" onClick={() => snap.lastPurchase!.items.forEach((l) => add(l.name, l.price, l.qty))}>↺ חזור על רכישה אחרונה</button>}
          </div>
        )}
      </div>

      {/* lines */}
      <ul className="grid gap-1.5">
        {lines.map((l, i) => (
          <li key={`${l.name}-${l.price}`} className="flex items-center gap-2 rounded-xl px-1 py-1 text-sm">
            <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{l.name}</span><span className="text-xs text-muted">{ils(l.price)}</span></span>
            <button type="button" className="h-9 w-9 rounded-full border border-line text-lg" onClick={() => setQty(i, -1)} aria-label={`פחות ${l.name}`}>−</button>
            <span className="w-6 text-center font-bold tabular-nums">{l.qty}</span>
            <button type="button" className="h-9 w-9 rounded-full border border-line text-lg" onClick={() => setQty(i, 1)} aria-label={`עוד ${l.name}`}>+</button>
            <span className="w-16 text-end font-semibold tabular-nums">{ils(l.price * l.qty)}</span>
            <button type="button" className="h-9 w-7 text-muted" onClick={() => setQty(i, -l.qty)} aria-label={`הסרת ${l.name}`}>✕</button>
          </li>
        ))}
        {!lines.length && <li className="py-6 text-center text-sm text-muted">הקישו על שירות או מוצר</li>}
      </ul>

      {lines.length > 0 && <>
        <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
          <button type="button" className={cx('rounded-full border px-3 py-1.5', extras.discount ? 'border-primary' : 'border-line')} onClick={() => setExtras({ ...extras, discount: !extras.discount })}>הנחה</button>
          <button type="button" className={cx('rounded-full border px-3 py-1.5', extras.note ? 'border-primary' : 'border-line')} onClick={() => setExtras({ ...extras, note: !extras.note })}>הערה</button>
          <button type="button" className="rounded-full border border-line px-3 py-1.5" onClick={reset}>עסקה חדשה</button>
        </div>
        {extras.discount && (
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-2 text-sm">
            <Input type="number" inputMode="decimal" value={discount.value || ''} onChange={(e) => setDiscount({ ...discount, value: Number(e.target.value) })} className="h-10 py-1" placeholder="סכום ההנחה" aria-label="הנחה" />
            <Select value={discount.kind} onChange={(e) => setDiscount({ ...discount, kind: e.target.value as 'sum' | 'percent' })} className="h-10 py-1" aria-label="סוג הנחה"><option value="sum">₪</option><option value="percent">%</option></Select>
          </div>
        )}
        {extras.note && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="הערה לעסקה" className="mt-2 h-10 py-1" aria-label="הערה" />}
        <div className="mt-3 border-t border-line pt-3 text-sm">
          <p className="flex justify-between text-muted"><span>סכום ביניים</span><span className="tabular-nums">{ils(t.subtotal)}</span></p>
          {t.discount > 0 && <p className="flex justify-between text-muted"><span>הנחה</span><span className="tabular-nums">−{ils(t.discount)}</span></p>}
          <p className="flex justify-between text-muted"><span>{vat.type === 'licensed' ? `מתוכו מע״מ ${vat.rate}%` : 'עוסק פטור'}</span><span className="tabular-nums">{vat.type === 'licensed' ? ils(t.vatAmount) : '—'}</span></p>
          <p className="mt-1 flex items-baseline justify-between"><span className="font-bold">סה״כ</span><span className="text-4xl font-black tabular-nums">{ils(t.total)}</span></p>
        </div>
      </>}
      <Button variant="primary" size="lg" className="mt-3 h-14 w-full text-lg" disabled={!lines.length || t.total <= 0} onClick={() => setPaying(true)}>
        לתשלום — {ils(t.total)}
      </Button>
    </div>
  );

  return (
    <div className="pb-28 lg:pb-0">
      {/* top bar: seller + quick actions */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {employees.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">מוכר/מטפל:</span>
            <Select value={employeeId} onChange={(e) => pickEmployee(e.target.value)} className="h-10 w-auto py-1" aria-label="מוכר/מטפל">
              <option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          </label>
        )}
        <span className="flex-1" />
        <button type="button" onClick={() => setKeypad(true)} className="rounded-full border border-line px-4 py-2 text-sm font-semibold">₪ סכום חופשי</button>
        <button type="button" onClick={toggleQuick} aria-pressed={quick} className={cx('rounded-full border px-4 py-2 text-sm font-semibold', quick ? 'border-primary bg-primary-soft' : 'border-line')}>⚡ כפתורים גדולים</button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(340px,400px)_1fr]">
        {/* CART — always visible on desktop / tablet landscape / physical POS */}
        <aside className="hidden lg:block"><div className="sticky top-4 rounded-3xl border border-line bg-surface p-4">{cart}</div></aside>

        {/* BUTTONS */}
        <section className="min-w-0">
          {!active.length && (
            <div className="mb-4 rounded-3xl border border-dashed border-line p-6 text-center">
              <p className="text-lg font-bold">המחירון עוד ריק</p>
              <p className="mt-1 text-sm text-ink-2">מוסיפים טיפולים ומוצרים פעם אחת — ומאז מוכרים בלחיצה. בינתיים אפשר למכור ב&quot;סכום חופשי&quot;.</p>
              {onGoCatalog && <Button variant="primary" className="mt-3" onClick={onGoCatalog}>הוספת פריטים למחירון</Button>}
            </div>
          )}
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש שירות, מוצר או לקוח…" className="mb-3 h-12" aria-label="חיפוש" />
          {peopleHits.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {peopleHits.map((l) => <button key={l.id} type="button" onClick={() => chooseLead(l)} className="rounded-full bg-primary-soft px-3 py-1.5 text-sm">👤 {l.name}</button>)}
            </div>
          )}
          {todayAppts.length > 0 && !q && (
            <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
              {todayAppts.map((a) => (
                <div key={a.id} className="min-w-[200px] shrink-0 rounded-2xl border border-line bg-surface p-3 text-sm">
                  <span className="block text-xs text-muted">התור של {a.name.split(' ')[0]} היום · {formatIL(a.start, { hour: '2-digit', minute: '2-digit' })}</span>
                  <strong className="block truncate">{a.serviceName}</strong>
                  <button type="button" onClick={() => fromAppt(a)} className="mt-1 font-semibold text-primary">+ הוסף לקופה</button>
                </div>
              ))}
            </div>
          )}
          {!q && (
            <div className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {CATS.filter((c) => c.id !== 'fav' || active.some((i) => i.favorite)).map((c) => (
                <button key={c.id} type="button" onClick={() => setCat(c.id)} className={cx('shrink-0 rounded-full px-4 py-2 text-sm font-semibold', cat === c.id ? 'bg-primary text-white' : 'bg-surface-2')}>{c.label}</button>
              ))}
              <button type="button" onClick={() => setCat('all')} className={cx('shrink-0 rounded-full px-4 py-2 text-sm font-semibold', cat === 'all' ? 'bg-primary text-white' : 'bg-surface-2')}>הכל</button>
            </div>
          )}
          <div className={cx('grid gap-2', quick ? 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5')}>
            {shown.map((i) => {
              const inCart = lines.find((l) => l.name === i.name && l.price === i.price)?.qty ?? 0;
              return (
                <button key={i.id} type="button" onClick={() => add(i.name, i.price)}
                  className={cx('relative flex flex-col justify-between rounded-2xl border bg-surface text-start shadow-sm transition-transform active:scale-[.97]',
                    inCart ? 'border-primary' : 'border-line', quick ? 'min-h-[120px] p-4' : 'min-h-[92px] p-3')}>
                  {i.imageUrl && !quick && <img src={i.imageUrl} alt="" className="mb-2 h-16 w-full rounded-xl object-cover" />}
                  <span className={cx('font-bold leading-tight', quick ? 'text-lg' : 'text-sm')}>{i.name}</span>
                  <span className={cx('mt-1 tabular-nums text-ink-2', quick ? 'text-lg font-semibold' : 'text-sm')}>{ils(i.price)}</span>
                  {inCart > 0 && <span className="absolute end-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1 text-xs font-bold text-white">{inCart}</span>}
                </button>
              );
            })}
          </div>
          {!shown.length && active.length > 0 && <p className="py-8 text-center text-sm text-muted">{q ? 'לא נמצא. אפשר להוסיף "סכום חופשי".' : cat === 'top' ? 'עוד אין מספיק מכירות.' : 'אין פריטים בקטגוריה הזו — מוסיפים במחירון.'}</p>}
        </section>
      </div>

      {/* PHONE / small tablet: sticky cart bar → bottom sheet */}
      <button type="button" onClick={() => setSheet(true)}
        className="fixed inset-x-3 z-40 flex items-center justify-between rounded-2xl bg-primary px-4 py-3 text-white shadow-lg lg:hidden"
        style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }} aria-label="פתיחת הסל">
        <span className="font-semibold">🛒 {count} פריטים</span><span className="text-lg font-black tabular-nums">{ils(t.total)}</span><span className="font-semibold">לתשלום ←</span>
      </button>
      {sheet && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="הסל">
          <button type="button" className="absolute inset-0 bg-black/40" onClick={() => setSheet(false)} aria-label="סגירה" />
          <div className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-3xl bg-surface p-4" style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}>
            <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-line" />{cart}
          </div>
        </div>
      )}

      <CustomerPicker open={picker} leads={leads} onClose={() => setPicker(false)} onPick={chooseLead} onNew={(c) => { setCustomer({ ...c, leadId: null, appointmentId: null }); setPicker(false); }} />
      <Keypad open={keypad} onClose={() => setKeypad(false)} onAdd={(price, name) => { add(name || 'סכום חופשי', price); setKeypad(false); }} />
      <PayPanel open={paying} total={t.total} payLinkReady={payLinkReady && Boolean(phoneDigits(customer.phone))} onClose={() => setPaying(false)} onPay={finish} />

      <Modal open={Boolean(done)} onClose={reset}>
        {done && (
          <div className="text-center">
            <p className="text-5xl text-emerald-500">✓</p>
            <h3 className="mt-2 font-display text-2xl font-extrabold">{done.sale?.status === 'pending' ? 'נשלחה בקשת תשלום' : 'העסקה נשמרה'}</h3>
            <p className="mt-2">{done.customer}</p>
            <p className="text-3xl font-black tabular-nums">{ils(done.sale?.total ?? 0)}</p>
            <p className="text-sm text-ink-2">{done.sale?.method === 'split' ? done.sale.payments?.map((p) => `${methodLabel(p.method)} ${ils(p.amount)}`).join(' · ') : methodLabel(done.sale?.method ?? 'other')}</p>
            {done.change != null && done.change > 0 && (
              <p className="mt-3 rounded-2xl bg-amber-500/15 p-3 text-2xl font-black text-amber-700 dark:text-amber-300">עודף: {ils(done.change)}</p>
            )}
            {done.docLabel && <p className="mt-2 text-sm font-semibold">{done.docLabel}</p>}
            {done.docUrl && (
              <div className="mt-3 rounded-2xl bg-surface-2 p-3 text-start">
                <p className="mb-2 text-sm font-semibold">שליחת החשבונית בוואטסאפ</p>
                <div className="flex gap-2">
                  <Input value={waPhone || done.phone} onChange={(e) => setWaPhone(e.target.value)} placeholder="טלפון הלקוח" inputMode="tel" dir="ltr" className="h-11 min-w-0 flex-1" aria-label="טלפון לשליחת החשבונית" />
                  <Button variant="primary" disabled={phoneDigits(waPhone || done.phone).length < 9} onClick={() => {
                    const url = waLink(waPhone || done.phone, `שלום${done.customer && done.customer !== 'לקוח מזדמן' ? ` ${done.customer.split(' ')[0]}` : ''}, תודה על הקנייה! ${done.docLabel?.replace('הופקה ', '') ?? 'המסמך'}: ${done.docUrl}`);
                    if (url) window.open(url, '_blank', 'noopener');
                  }}>💬 שליחה</Button>
                </div>
              </div>
            )}
            <div className="mt-5 grid gap-2">
              <Button variant="primary" size="lg" className="h-14 text-lg" onClick={reset}>עסקה חדשה</Button>
              {done.docLabel && <Button variant="ghost" onClick={() => { reset(); onShowDoc(); }}>צפייה במסמך</Button>}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function CustomerPicker({ open, leads, onClose, onPick, onNew }: { open: boolean; leads: Lead[]; onClose: () => void; onPick: (l: Lead | null) => void; onNew: (c: { name: string; phone: string }) => void }) {
  const [q, setQ] = useState(''); const [fresh, setFresh] = useState<{ name: string; phone: string } | null>(null);
  useEffect(() => { if (open) { setQ(''); setFresh(null); } }, [open]);
  const hits = leads.filter((l) => matches(l, q)).slice(0, 30);
  return (
    <Modal open={open} onClose={onClose}>
      <h3 className="mb-3 font-display text-xl font-extrabold">לקוח/ה</h3>
      {fresh ? (
        <div className="grid gap-2">
          <Input value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} placeholder="שם" autoFocus aria-label="שם לקוח חדש" />
          <Input value={fresh.phone} onChange={(e) => setFresh({ ...fresh, phone: e.target.value })} placeholder="טלפון" inputMode="tel" dir="ltr" aria-label="טלפון לקוח חדש" />
          <Button variant="primary" disabled={!fresh.name.trim()} onClick={() => onNew({ name: fresh.name.trim(), phone: fresh.phone.trim() })}>שמירה</Button>
        </div>
      ) : <>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Button variant="ghost" onClick={() => onPick(null)}>לקוח מזדמן</Button>
          <Button variant="ghost" onClick={() => setFresh({ name: '', phone: '' })}>+ לקוח חדש</Button>
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם או טלפון" autoFocus aria-label="חיפוש לקוח" />
        <div className="mt-2 grid max-h-[50vh] gap-1.5 overflow-y-auto">
          {hits.map((l) => (
            <button key={l.id} type="button" onClick={() => onPick(l)} className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2.5 text-start">
              <span><strong className="block">{l.name}</strong><span className="text-xs text-muted" dir="ltr">{l.phone}</span></span>
              {l.tags?.[0] && <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-bold">{l.tags[0]}</span>}
            </button>
          ))}
        </div>
      </>}
    </Modal>
  );
}

function Keypad({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (price: number, name: string) => void }) {
  const [v, setV] = useState(''); const [name, setName] = useState('');
  useEffect(() => { if (open) { setV(''); setName(''); } }, [open]);
  const press = (k: string) => setV((x) => (k === '⌫' ? x.slice(0, -1) : k === '.' ? (x.includes('.') ? x : (x || '0') + '.') : (x.split('.')[1]?.length === 2 ? x : (x === '0' ? k : x + k)).slice(0, 9)));
  return (
    <Modal open={open} onClose={onClose}>
      <h3 className="mb-2 font-display text-xl font-extrabold">סכום חופשי</h3>
      <p className="mb-3 rounded-2xl bg-surface-2 py-4 text-center text-5xl font-black tabular-nums" dir="ltr" aria-live="polite">₪ {v || '0'}</p>
      <div className="grid grid-cols-3 gap-2" dir="ltr">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map((k) => (
          <button key={k} type="button" onClick={() => press(k)} className="h-14 rounded-2xl bg-surface-2 text-2xl font-bold active:scale-95" aria-label={k === '⌫' ? 'מחיקה' : k}>{k}</button>
        ))}
      </div>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="תיאור (לא חובה) — למשל: טיפול מיוחד" className="mt-3" aria-label="תיאור" />
      <Button variant="primary" size="lg" className="mt-3 h-14 w-full text-lg" disabled={!(Number(v) > 0)} onClick={() => onAdd(Number(v), name.trim())}>הוסף לסל</Button>
    </Modal>
  );
}

function PayPanel({ open, total, payLinkReady, onClose, onPay }: {
  open: boolean; total: number; payLinkReady: boolean; onClose: () => void;
  onPay: (c: { paidNow: boolean; method: Method; payments: Pay[]; cashReceived?: number }) => Promise<CheckoutResult>;
}) {
  const [split, setSplit] = useState<Pay[] | null>(null);
  const [cash, setCash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setSplit(null); setCash(null); setErr(null); } }, [open]);
  const received = Number(cash || 0);
  const change = Math.round((received - total) * 100) / 100;
  const left = split ? remaining(total, split) : 0;
  async function go(c: { paidNow: boolean; method: Method; payments: Pay[]; cashReceived?: number }) {
    setBusy(true); setErr(null);
    const r = await onPay(c);
    setBusy(false); if (!r.ok) setErr(r.error ?? 'לא נשמר. נסו שוב.');
  }
  return (
    <Modal open={open} onClose={onClose}>
      <p className="text-center text-sm text-muted">לתשלום</p>
      <p className="mb-4 text-center text-5xl font-black tabular-nums">{ils(total)}</p>
      {cash !== null ? (
        <div>
          <p className="mb-2 text-center font-bold">כמה קיבלת?</p>
          <div className="mb-2 grid grid-cols-3 gap-2">
            {cashSuggestions(total).map((v) => (
              <button key={v} type="button" onClick={() => setCash(String(v))} className={cx('h-14 rounded-2xl border text-lg font-bold tabular-nums', received === v ? 'border-primary bg-primary-soft' : 'border-line bg-surface')}>
                {v === total ? 'בדיוק' : ils(v)}
              </button>
            ))}
          </div>
          <Input type="number" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="סכום אחר" className="h-14 text-center text-2xl font-bold" aria-label="סכום שהתקבל" />
          <p className={cx('my-3 rounded-2xl p-4 text-center text-3xl font-black tabular-nums', change >= 0 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-surface-2 text-muted')}>
            {cash === '' ? 'הזינו סכום' : change >= 0 ? `עודף: ${ils(change)}` : `חסר: ${ils(-change)}`}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setCash(null)}>חזרה</Button>
            <Button variant="primary" disabled={busy || cash === '' || change < 0} onClick={() => go({ paidNow: true, method: 'cash', payments: [], cashReceived: received })}>אישור</Button>
          </div>
        </div>
      ) : !split ? (
        <div className="grid grid-cols-2 gap-2">
          {PAY_BUTTONS.map((m) => (
            <button key={m.id} type="button" disabled={busy} onClick={() => (m.id === 'cash' ? setCash('') : go({ paidNow: true, method: m.id, payments: [] }))}
              className="flex h-20 flex-col items-center justify-center rounded-2xl border border-line bg-surface text-lg font-bold active:scale-[.97] disabled:opacity-50">
              <span className="text-2xl" aria-hidden>{m.icon}</span>{m.label}
            </button>
          ))}
          <button type="button" disabled={busy} onClick={() => setSplit([{ method: 'card', amount: 0 }, { method: 'cash', amount: 0 }])}
            className="flex h-20 flex-col items-center justify-center rounded-2xl border border-line bg-surface text-lg font-bold">
            <span className="text-2xl" aria-hidden>🔀</span>פיצול תשלום
          </button>
          {payLinkReady && (
            <button type="button" disabled={busy} onClick={() => go({ paidNow: false, method: 'link', payments: [] })}
              className="col-span-2 rounded-2xl bg-primary-soft py-3 text-sm font-semibold">🔗 שליחת בקשת תשלום בוואטסאפ (ממתין לתשלום)</button>
          )}
        </div>
      ) : (
        <div>
          {split.map((p, i) => (
            <div key={i} className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
              <Select value={p.method} onChange={(e) => setSplit(split.map((x, k) => (k === i ? { ...x, method: e.target.value as Pay['method'] } : x)))} className="h-12" aria-label={`אמצעי ${i + 1}`}>
                {PAY_BUTTONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </Select>
              <Input type="number" inputMode="decimal" value={p.amount || ''} onChange={(e) => setSplit(split.map((x, k) => (k === i ? { ...x, amount: Number(e.target.value) } : x)))} className="h-12 text-center text-xl font-bold tabular-nums" aria-label={`סכום ${i + 1}`} />
              <button type="button" className="text-xs text-primary" onClick={() => setSplit(split.map((x, k) => (k === i ? { ...x, amount: Math.round((x.amount + left) * 100) / 100 } : x)))}>היתרה</button>
            </div>
          ))}
          <button type="button" className="mb-3 text-sm text-primary" onClick={() => setSplit([...split, { method: 'other', amount: 0 }])}>+ אמצעי נוסף</button>
          <p className={cx('mb-3 rounded-2xl p-3 text-center text-xl font-black tabular-nums', left === 0 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>
            {left === 0 ? 'נותר: ₪0 ✓' : left > 0 ? `נותר: ${ils(left)}` : `עודף בתשלום: ${ils(-left)}`}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setSplit(null)}>חזרה</Button>
            <Button variant="primary" disabled={busy || left !== 0 || split.some((p) => p.amount < 0)} onClick={() => go({ paidNow: true, method: 'split', payments: split.filter((p) => p.amount > 0) })}>אישור</Button>
          </div>
        </div>
      )}
      {err && <p className="mt-3 text-center text-sm text-warn">{err}</p>}
    </Modal>
  );
}
