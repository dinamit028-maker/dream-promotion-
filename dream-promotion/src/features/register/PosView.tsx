'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select, SmallSelect } from '@/components/ui/primitives';
import { CloseButton, Modal } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';
import { matches, phoneDigits, waLink } from '@/features/crm/crm';
import type { Lead } from '@/types';
import { computeSale, customerSnapshot, ils, methodLabel, remaining, topSellers, type ItemKind, type Line, type Method, type Pay, type Sale } from './money';
import { MAX_HELD, holdCart, loadHeld, removeHeld, resumeHeld, saveHeld, type Cart, type HeldSale } from './held';
import { stockLevel, stockText } from './stock';
import { cartKey, findByCode, lineName, posPrice, variantLabel, variantLevel, variantsOf, type CatalogVariant } from '@/features/catalog/catalog';
import { EMPTY_BILLING, billingError, dealerDigits, type Billing } from './billing';

/**
 * The register, touch-first (UX redesign — same sales logic, CRM link, VAT and documents underneath).
 * Desktop / physical POS: CART | BUTTONS. Phone: buttons + a sticky cart bar that opens a bottom sheet.
 * A normal sale: tap an item → "לתשלום" → tap a payment method.
 */
export type PosItem = {
  id: string; name: string; price: number; kind: ItemKind; active: boolean; favorite: boolean; favOrder: number; imageUrl: string;
  /** stock (2.50): only items with trackStock count; lowStock = the alert level */
  trackStock: boolean; stockQty: number; lowStock: number;
  /** the one catalog (2.54): sizes / colours to choose from, and the codes a scanner types */
  hasVariants?: boolean; sku?: string; barcode?: string;
};
export type TodayAppt = { id: string; name: string; phone: string; leadId: string | null; serviceName: string; start: string; price: number | null };
export type Customer = { name: string; phone: string; leadId: string | null; appointmentId: string | null };
export interface CheckoutInput {
  lines: Line[]; discount: { kind: 'sum' | 'percent'; value: number }; customer: Customer; note: string;
  employee: { id: string; name: string } | null; paidNow: boolean; method: Method; payments: Pay[];
  /** cash: what the customer handed over (the change is computed from it) */
  cashReceived?: number;
  /** an invoice to a business (name, dealer / company number, address) — null for a private customer */
  billing?: Billing | null;
  /** the sale's id, chosen once per payment: a retry after a lost answer finds the sale instead of saving a second one */
  saleId?: string;
}
/** payUrl: the WhatsApp payment request, opened by a tap on the result screen (a window opened after the save is blocked by phones) */
export interface CheckoutResult { ok: boolean; sale?: Sale; docLabel?: string; docUrl?: string; payUrl?: string; error?: string; lowStock?: string[] }

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
/** the device's storage, or null where it is blocked (private mode, some in-app browsers) */
const deviceStore = () => { try { return window.localStorage; } catch { return null; } };
export const heldCountLabel = (n: number) => (n === 1 ? 'עסקה מושהית אחת' : `${n} עסקאות מושהות`);
/** quick cash buttons: exact, the next round amounts, common notes */
export function cashSuggestions(total: number) {
  const up = (step: number) => Math.ceil(total / step) * step;
  return [...new Set([total, up(10), up(50), up(100), up(200), 200, 500].filter((v) => v >= total))].sort((a, b) => a - b).slice(0, 6);
}

export function PosView({ userId, items, variants = [], sales, leads, employees, todayAppts, vat, payLinkReady, onCheckout, onShowDoc, prefill, onGoCatalog, wide }: {
  userId: string; items: PosItem[]; sales: Sale[]; leads: Lead[]; employees: { id: string; name: string }[]; todayAppts: TodayAppt[];
  /** the variants of the price list (2.54): an item with variants asks which one */
  variants?: CatalogVariant[];
  vat: { type: 'exempt' | 'licensed'; rate: number }; payLinkReady: boolean;
  onCheckout: (c: CheckoutInput) => Promise<CheckoutResult>; onShowDoc?: () => void;
  prefill?: { customer: Customer; line: Line | null } | null; onGoCatalog?: () => void;
  /** the whole screen is the register (full-screen mode): more buttons per row */
  wide?: boolean;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Customer>(EMPTY);
  const [discount, setDiscount] = useState<{ kind: 'sum' | 'percent'; value: number }>({ kind: 'sum', value: 0 });
  const [note, setNote] = useState('');
  const [extras, setExtras] = useState<{ discount: boolean; note: boolean }>({ discount: false, note: false });
  const [billing, setBilling] = useState<Billing | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [cat, setCat] = useState<Cat>('fav');
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState(false);
  const [sheet, setSheet] = useState(false);
  // the cart sheet closes with Escape too (a keyboard on a tablet at the counter), not only by tapping outside
  useEffect(() => {
    if (!sheet) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheet(false); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [sheet]);
  const [picker, setPicker] = useState(false);
  // an item with sizes / colours: which one (2.54)
  const [pick, setPick] = useState<PosItem | null>(null);
  const [keypad, setKeypad] = useState(false);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState<CheckoutResult & { customer: string; phone: string; change: number | null } | null>(null);
  const [waPhone, setWaPhone] = useState('');
  const [held, setHeld] = useState<HeldSale[]>([]);
  const [heldOpen, setHeldOpen] = useState(false);
  const [askResume, setAskResume] = useState<string | null>(null);
  const [heldMsg, setHeldMsg] = useState<string | null>(null);
  useEffect(() => { setHeld(loadHeld(deviceStore(), userId)); }, [userId]);

  useEffect(() => { try { setQuick(localStorage.getItem('dp-pos-quick') === '1'); setEmployeeId(localStorage.getItem('dp-pos-employee') ?? ''); } catch { /* private mode */ } }, []);
  useEffect(() => { if (!items.some((i) => i.favorite && i.active)) setCat('all'); }, [items]);
  useEffect(() => { if (prefill) { setCustomer(prefill.customer); if (prefill.line) setLines([prefill.line]); } }, [prefill]);
  const toggleQuick = () => { const v = !quick; setQuick(v); try { localStorage.setItem('dp-pos-quick', v ? '1' : '0'); } catch { /* ignore */ } };
  const pickEmployee = (id: string) => { setEmployeeId(id); try { localStorage.setItem('dp-pos-employee', id); } catch { /* ignore */ } };

  const t = computeSale(lines, discount, vat);
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const top = useMemo(() => topSellers(sales), [sales]);
  const active = items.filter((i) => i.active);
  const codes = useMemo(() => active.map((i) => ({ id: i.id, sku: i.sku ?? '', barcode: i.barcode ?? '', active: true })), [active]);
  const shown = useMemo(() => {
    const s = q.trim();
    // a name — or a code (a barcode / SKU of the item or of one of its variants)
    const code = s ? findByCode(s, codes, variants) : null;
    if (s) return active.filter((i) => i.name.includes(s) || i.name.toLowerCase().includes(s.toLowerCase()) || code?.item.id === i.id);
    if (cat === 'fav') return active.filter((i) => i.favorite).sort((a, b) => a.favOrder - b.favOrder);
    if (cat === 'top') return top.map((n) => active.find((i) => i.name === n)).filter(Boolean) as PosItem[];
    if (cat === 'all') return active;
    return active.filter((i) => i.kind === cat);
  }, [active, cat, q, top, codes, variants]);
  const peopleHits = q.trim().length >= 2 ? leads.filter((l) => matches(l, q)).slice(0, 4) : [];

  /**
   * a line in the cart; a price-list item brings its id and kind (stock, commissions) — and its variant (2.54).
   * Two taps on the same product and variant are one line (cartKey); a free amount is matched by its name and price.
   */
  const add = (name: string, price: number, qty = 1, meta?: { itemId?: string; kind?: ItemKind; variantId?: string }) => setLines((ls) => {
    // a free amount named like an item without variants is that item (as before 2.54)
    const known = meta?.itemId ? meta : (() => { const it = items.find((x) => x.name === name && x.price === price && !x.hasVariants); return it ? { itemId: it.id, kind: it.kind } : meta; })();
    const line: Line = { name, price, qty, ...(known?.itemId ? { itemId: known.itemId } : {}), ...(known?.itemId && known.variantId ? { variantId: known.variantId } : {}),
      ...(known?.kind ? { kind: known.kind } : {}) };
    const key = cartKey(line);
    const i = ls.findIndex((l) => cartKey(l) === key);
    if (i >= 0) return ls.map((l, k) => (k === i ? { ...l, qty: l.qty + qty } : l));
    return [...ls, line];
  });
  const addVariant = (i: PosItem, v: CatalogVariant) => add(lineName(i.name, v), posPrice(i, v), 1, { itemId: i.id, kind: i.kind, variantId: v.id });
  /** a tile: an item with active variants asks which one; any other item goes in as it is */
  const addItem = (i: PosItem) => {
    if (i.hasVariants && variantsOf(variants, i.id).some((v) => v.active)) return setPick(i);
    add(i.name, i.price, 1, { itemId: i.id, kind: i.kind });
  };
  /** a scanner types the code and Enter: the product (and its variant) goes into the cart at once */
  const scan = () => {
    const hit = findByCode(q, codes, variants);
    if (!hit) return false;
    const item = active.find((i) => i.id === hit.item.id);
    if (!item) return false;
    if (hit.variant) addVariant(item, hit.variant); else addItem(item);
    setQ('');
    return true;
  };
  const setQty = (i: number, d: number) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));
  /** a business customer's invoice details come back by themselves next time */
  const billingOf = (l: Lead | null | undefined): Billing | null => (l?.billingDealer ? { name: l.billingName || l.name, dealer: l.billingDealer, street: l.billingStreet ?? '', city: l.billingCity ?? '' } : null);
  const chooseLead = (l: Lead | null) => { setCustomer(l ? { name: l.name, phone: l.phone, leadId: l.id, appointmentId: null } : EMPTY); setBilling(billingOf(l)); setPicker(false); setQ(''); };
  const fromAppt = (a: TodayAppt) => {
    setCustomer({ name: a.name, phone: a.phone, leadId: a.leadId, appointmentId: a.id });
    setBilling(billingOf(leads.find((l) => l.id === a.leadId)));
    const item = active.find((i) => i.name === a.serviceName);
    add(a.serviceName || 'טיפול', item?.price ?? a.price ?? 0, 1, item ? { itemId: item.id, kind: item.kind } : { kind: 'service' });
  };
  const snap = customer.leadId ? customerSnapshot(customer.leadId, sales) : null;
  const lead = customer.leadId ? leads.find((l) => l.id === customer.leadId) : null;
  const apptToday = customer.leadId ? todayAppts.find((a) => a.leadId === customer.leadId) : null;
  const reset = () => { setWaPhone(''); setLines([]); setCustomer(EMPTY); setDiscount({ kind: 'sum', value: 0 }); setNote(''); setExtras({ discount: false, note: false }); setBilling(null); setDone(null); setSheet(false); };
  const billErr = billing ? billingError(billing) : null;
  const employee = employees.find((e) => e.id === employeeId) ?? null;

  // ---- held sales: park this cart for later, serve the next customer, resume it as it was ----
  const say = (m: string) => { setHeldMsg(m); setTimeout(() => setHeldMsg(null), 3000); };
  const currentCart = (): Cart => ({ lines, customer, discount, note, employeeId, ...(billing ? { billing } : {}) });
  const clearCart = () => { setLines([]); setCustomer(EMPTY); setDiscount({ kind: 'sum', value: 0 }); setNote(''); setExtras({ discount: false, note: false }); setBilling(null); setSheet(false); };
  const keepHeld = (list: HeldSale[]) => { setHeld(list); if (!saveHeld(deviceStore(), userId, list)) say('המכשיר לא מאפשר שמירה — העסקאות המושהות יימחקו ברענון הדף.'); };
  function hold() {
    const r = holdCart(held, currentCart());
    if (!r.ok) return say(r.error === 'full' ? `אפשר להשהות עד ${MAX_HELD} עסקאות. המשיכו או מחקו אחת מהמושהות.` : 'הסל ריק.');
    keepHeld(r.list); clearCart(); say('⏸ העסקה הושהתה — אפשר להתחיל עסקה חדשה');
  }
  function resume(id: string, keepCurrent: boolean) {
    const r = resumeHeld(held, id, keepCurrent ? currentCart() : null);
    setAskResume(null); setHeldOpen(false);
    if (!r) return;
    keepHeld(r.list);
    const c = r.cart;
    setLines(c.lines); setCustomer(c.customer); setDiscount(c.discount); setNote(c.note); setExtras({ discount: c.discount.value > 0, note: Boolean(c.note) });
    setBilling(c.billing ?? null);
    if (c.employeeId && employees.some((e) => e.id === c.employeeId)) setEmployeeId(c.employeeId);
    say(keepCurrent ? 'העסקה הקודמת הושהתה, והעסקה המושהית חזרה לסל' : 'העסקה חזרה לסל');
  }
  const askToResume = (id: string) => (lines.length ? setAskResume(id) : resume(id, false));

  // one id per sale being paid — kept across retries, a new one after the sale went through
  const saleId = useRef(crypto.randomUUID());
  async function finish(c: Pick<CheckoutInput, 'paidNow' | 'method' | 'payments' | 'cashReceived'>) {
    if (billing && billErr) return { ok: false, error: billErr };
    const r = await onCheckout({ lines, discount, customer, note, employee, billing, ...c, saleId: saleId.current });
    if (r.ok) {
      saleId.current = crypto.randomUUID();
      // the sold items leave the cart immediately — nothing can be charged twice behind the confirmation
      const who = customer.name || 'לקוח מזדמן'; const phone = customer.phone;
      setLines([]); setCustomer(EMPTY); setDiscount({ kind: 'sum', value: 0 }); setNote(''); setExtras({ discount: false, note: false }); setBilling(null);
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
            {snap.lastPurchase && <button type="button" className="mt-1 font-semibold text-primary" onClick={() => snap.lastPurchase!.items.forEach((l) => add(l.name, l.price, l.qty, { itemId: l.itemId, kind: l.kind, variantId: l.variantId }))}>↺ חזור על רכישה אחרונה</button>}
          </div>
        )}
      </div>

      {/* lines */}
      <ul className="grid gap-1.5">
        {lines.map((l, i) => (
          <li key={`${cartKey(l)}-${i}`} className="flex items-center gap-2 rounded-xl px-1 py-1 text-sm">
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
          <button type="button" className={cx('rounded-full border px-3 py-1.5', billing ? 'border-primary' : 'border-line')} aria-pressed={Boolean(billing)}
            onClick={() => setBilling(billing ? null : { ...EMPTY_BILLING, name: customer.name })}>🧾 חשבונית לעסק</button>
          <button type="button" className="rounded-full border border-line px-3 py-1.5" onClick={hold} aria-label="השהיית העסקה">⏸ השהיה</button>
          <button type="button" className="rounded-full border border-line px-3 py-1.5" onClick={reset}>עסקה חדשה</button>
        </div>
        {extras.discount && (
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-2 text-sm">
            <Input type="number" inputMode="decimal" value={discount.value || ''} onChange={(e) => setDiscount({ ...discount, value: Number(e.target.value) })} className="h-10 py-1" placeholder="סכום ההנחה" aria-label="הנחה" />
            <Select value={discount.kind} onChange={(e) => setDiscount({ ...discount, kind: e.target.value as 'sum' | 'percent' })} className="h-10 py-1" aria-label="סוג הנחה"><option value="sum">₪</option><option value="percent">%</option></Select>
          </div>
        )}
        {extras.note && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="הערה לעסקה" className="mt-2 h-10 py-1" aria-label="הערה" />}
        {billing && (
          <div className="mt-2 grid gap-2 rounded-2xl bg-surface-2 p-2.5 text-sm">
            <p className="text-xs font-semibold text-ink-2">חשבונית לעסק — יופיע במסמך</p>
            <Input value={billing.name} onChange={(e) => setBilling({ ...billing, name: e.target.value })} placeholder="שם העסק לחשבונית" className="h-10 py-1" aria-label="שם העסק לחשבונית" />
            <Input value={billing.dealer} onChange={(e) => setBilling({ ...billing, dealer: dealerDigits(e.target.value) })} placeholder="ע.מ / ח.פ (9 ספרות)" inputMode="numeric" dir="ltr" className="h-10 py-1" aria-label="מספר עוסק או ח.פ" />
            <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
              <Input value={billing.street} onChange={(e) => setBilling({ ...billing, street: e.target.value })} placeholder="רחוב ומספר" className="h-10 py-1" aria-label="כתובת: רחוב ומספר" />
              <Input value={billing.city} onChange={(e) => setBilling({ ...billing, city: e.target.value })} placeholder="עיר" className="h-10 py-1" aria-label="כתובת: עיר" />
            </div>
            {billErr && (billing.dealer || billing.name) && <p className="text-xs text-warn">{billErr}</p>}
          </div>
        )}
        <div className="mt-3 border-t border-line pt-3 text-sm">
          <p className="flex justify-between text-muted"><span>סכום ביניים</span><span className="tabular-nums">{ils(t.subtotal)}</span></p>
          {t.discount > 0 && <p className="flex justify-between text-muted"><span>הנחה</span><span className="tabular-nums">−{ils(t.discount)}</span></p>}
          <p className="flex justify-between text-muted"><span>{vat.type === 'licensed' ? `מתוכו מע״מ ${vat.rate}%` : 'עוסק פטור'}</span><span className="tabular-nums">{vat.type === 'licensed' ? ils(t.vatAmount) : '—'}</span></p>
          <p className="mt-1 flex items-baseline justify-between"><span className="font-bold">סה״כ</span><span className="text-4xl font-black tabular-nums">{ils(t.total)}</span></p>
        </div>
      </>}
      <Button variant="primary" size="lg" className="mt-3 h-14 w-full text-lg" disabled={!lines.length || t.total <= 0 || Boolean(billing && billErr)} onClick={() => setPaying(true)}>
        לתשלום — {ils(t.total)}
      </Button>
    </div>
  );

  return (
    <div className="pb-28 lg:pb-0">
      {held.length > 0 && (
        <button type="button" onClick={() => setHeldOpen(true)}
          className="mb-3 flex w-full items-center justify-between gap-2 rounded-2xl bg-amber-500/15 px-4 py-3 text-start font-bold text-amber-800 dark:text-amber-200">
          <span>⏸ {heldCountLabel(held.length)}</span><span className="text-sm font-semibold">פתיחה ←</span>
        </button>
      )}
      {heldMsg && <p role="status" className="mb-3 rounded-2xl bg-surface-2 p-3 text-sm font-semibold">{heldMsg}</p>}
      {/* top bar: seller + quick actions */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {employees.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">מוכר/מטפל:</span>
            <SmallSelect value={employeeId} onChange={(e) => pickEmployee(e.target.value)} className="w-auto min-w-[8rem]" aria-label="מוכר/מטפל">
              <option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </SmallSelect>
          </label>
        )}
        <span className="flex-1" />
        <button type="button" onClick={() => setKeypad(true)} className="rounded-full border border-line px-4 py-2 text-sm font-semibold">₪ סכום חופשי</button>
        <button type="button" onClick={toggleQuick} aria-pressed={quick} className={cx('rounded-full border px-4 py-2 text-sm font-semibold', quick ? 'border-primary bg-primary-soft' : 'border-line')}>⚡ כפתורים גדולים</button>
      </div>

      <div className={cx('grid gap-4', wide ? 'lg:grid-cols-[minmax(360px,440px)_1fr]' : 'lg:grid-cols-[minmax(340px,400px)_1fr]')}>
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
          <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q.trim() && scan()) e.preventDefault(); }}
            placeholder="חיפוש שירות, מוצר, ברקוד או לקוח…" className="mb-3 h-12" aria-label="חיפוש" />
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
          <div className={cx('grid gap-2', quick
            ? cx('grid-cols-2 sm:grid-cols-3 xl:grid-cols-4', wide && '2xl:grid-cols-5 min-[1800px]:grid-cols-6')
            : cx('grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5', wide && '2xl:grid-cols-6 min-[1800px]:grid-cols-7'))}>
            {shown.map((i) => {
              // every line of this item (all its sizes / colours together); a free amount with its name counts too, as before
              const inCart = lines.filter((l) => l.itemId === i.id || (!l.itemId && l.name === i.name && l.price === i.price)).reduce((a, l) => a + l.qty, 0);
              const level = stockLevel(i);
              return (
                <button key={i.id} type="button" onClick={() => addItem(i)}
                  className={cx('relative flex flex-col justify-between rounded-2xl border bg-surface text-start shadow-sm transition-transform active:scale-[.97]',
                    inCart ? 'border-primary' : 'border-line', quick ? 'min-h-[120px] p-4' : 'min-h-[92px] p-3')}>
                  {i.imageUrl && !quick && <img src={i.imageUrl} alt="" className="mb-2 h-16 w-full rounded-xl object-cover" />}
                  <span className={cx('font-bold leading-tight', quick ? 'text-lg' : 'text-sm')}>{i.name}</span>
                  <span className={cx('mt-1 tabular-nums text-ink-2', quick ? 'text-lg font-semibold' : 'text-sm')}>{ils(i.price)}</span>
                  {inCart > 0 && <span className="absolute end-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1 text-xs font-bold text-white">{inCart}</span>}
                  {level !== 'ok' && <span className={cx('mt-1 self-start rounded-full px-2 py-0.5 text-[11px] font-bold', level === 'out' ? 'bg-red-500/15 text-red-700 dark:text-red-300' : 'bg-amber-500/15 text-amber-800 dark:text-amber-200')}>{stockText(i)}</span>}
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
          <div className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto overscroll-contain rounded-t-3xl bg-surface p-4" style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}>
            <div className="mb-2 flex items-center justify-between">
              <span className="h-1.5 w-12 rounded-full bg-line" aria-hidden />
              <CloseButton onClick={() => setSheet(false)} />
            </div>
            {cart}
          </div>
        </div>
      )}

      <CustomerPicker open={picker} leads={leads} onClose={() => setPicker(false)} onPick={chooseLead} onNew={(c) => { setCustomer({ ...c, leadId: null, appointmentId: null }); setPicker(false); }} />
      <Modal open={Boolean(pick)} onClose={() => setPick(null)}>
        {pick && <>
          <h3 className="mb-1 font-display text-xl font-extrabold">{pick.name}</h3>
          <p className="mb-3 text-sm text-muted">בחירת מידה / צבע</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label={`וריאנטים של ${pick.name}`}>
            {variantsOf(variants, pick.id).filter((v) => v.active).map((v) => {
              const lvl = variantLevel(pick, v);
              const n = lines.filter((l) => l.itemId === pick.id && l.variantId === v.id).reduce((a, l) => a + l.qty, 0);
              return (
                <button key={v.id} type="button" onClick={() => { addVariant(pick, v); setPick(null); }}
                  className={cx('relative flex min-h-[72px] flex-col justify-between rounded-2xl border bg-surface p-3 text-start', n ? 'border-primary' : 'border-line')}>
                  <strong className="leading-tight">{variantLabel(v) || pick.name}</strong>
                  <span className="text-sm tabular-nums text-ink-2">{ils(posPrice(pick, v))}</span>
                  {lvl && lvl !== 'ok' && <span className={cx('mt-1 self-start rounded-full px-2 py-0.5 text-[11px] font-bold', lvl === 'out' ? 'bg-red-500/15 text-red-700 dark:text-red-300' : 'bg-amber-500/15 text-amber-800 dark:text-amber-200')}>
                    {v.stockQty <= 0 ? 'אזל מהמלאי' : `נשארו ${v.stockQty}`}</span>}
                  {n > 0 && <span className="absolute end-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1 text-xs font-bold text-white">{n}</span>}
                </button>
              );
            })}
          </div>
          <Button variant="ghost" className="mt-4" onClick={() => setPick(null)}>סגירה</Button>
        </>}
      </Modal>
      <Keypad open={keypad} onClose={() => setKeypad(false)} onAdd={(price, name) => { add(name || 'סכום חופשי', price, 1, { kind: 'other' }); setKeypad(false); }} />
      <PayPanel open={paying} total={t.total} payLinkReady={payLinkReady && Boolean(phoneDigits(customer.phone))} onClose={() => setPaying(false)} onPay={finish} />

      <Modal open={heldOpen} onClose={() => setHeldOpen(false)}>
        <h3 className="mb-3 font-display text-xl font-extrabold">⏸ עסקאות מושהות</h3>
        {!held.length ? <p className="text-sm text-muted">אין עסקאות מושהות.</p> : (
          <ul className="grid gap-2">
            {held.map((h) => (
              <li key={h.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-2xl bg-surface-2 p-3 text-sm">
                <span className="min-w-0 flex-1">
                  <strong className="block truncate">{h.customer.name || 'לקוח מזדמן'} · <span className="tabular-nums">{ils(computeSale(h.lines, h.discount, vat).total)}</span></strong>
                  <span className="block truncate text-xs text-muted">{formatIL(h.heldAt, { hour: '2-digit', minute: '2-digit' })} · {h.lines.map((l) => `${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(' + ')}</span>
                </span>
                <Button size="sm" variant="primary" onClick={() => askToResume(h.id)}>המשך</Button>
                <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`למחוק את העסקה המושהית של ${h.customer.name || 'לקוח מזדמן'}?`)) keepHeld(removeHeld(held, h.id)); }}>מחיקה</Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">העסקאות המושהות נשמרות רק במכשיר הזה (עד {MAX_HELD}).</p>
      </Modal>

      <Modal open={askResume !== null} onClose={() => setAskResume(null)}>
        <h3 className="mb-2 font-display text-xl font-extrabold">יש כבר פריטים בסל</h3>
        <p className="mb-4 text-sm text-ink-2">להשהות גם את העסקה הנוכחית ({ils(t.total)}), כדי שלא תלך לאיבוד?</p>
        <div className="grid gap-2">
          <Button variant="primary" size="lg" onClick={() => askResume && resume(askResume, true)}>כן, להשהות גם אותה</Button>
          <Button variant="ghost" onClick={() => askResume && resume(askResume, false)}>לא, לוותר על העסקה הנוכחית</Button>
          <Button variant="ghost" onClick={() => setAskResume(null)}>ביטול</Button>
        </div>
      </Modal>

      <Modal open={Boolean(done)} onClose={reset}>
        {done && (
          <div className="text-center">
            <p className="text-5xl text-emerald-500">✓</p>
            <h3 className="mt-2 font-display text-2xl font-extrabold">{done.sale?.status === 'pending' ? 'העסקה נשמרה — ממתינה לתשלום' : 'העסקה נשמרה'}</h3>
            <p className="mt-2">{done.customer}</p>
            <p className="text-3xl font-black tabular-nums">{ils(done.sale?.total ?? 0)}</p>
            <p className="text-sm text-ink-2">{done.sale?.method === 'split' ? done.sale.payments?.map((p) => `${methodLabel(p.method)} ${ils(p.amount)}`).join(' · ') : methodLabel(done.sale?.method ?? 'other')}</p>
            {done.change != null && done.change > 0 && (
              <p className="mt-3 rounded-2xl bg-amber-500/15 p-3 text-2xl font-black text-amber-700 dark:text-amber-300">עודף: {ils(done.change)}</p>
            )}
            {done.docLabel && <p className="mt-2 text-sm font-semibold">{done.docLabel}</p>}
            {done.payUrl && (
              <Button variant="primary" className="mt-3 w-full" onClick={() => { window.open(done.payUrl, '_blank', 'noopener'); }}>💬 שליחת בקשת התשלום בוואטסאפ</Button>
            )}
            {done.lowStock && done.lowStock.length > 0 && (
              <p className="mt-2 rounded-2xl bg-amber-500/15 p-2 text-sm font-semibold text-amber-800 dark:text-amber-200">⚠️ מלאי נמוך: {done.lowStock.join(' · ')}</p>
            )}
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
              {done.docLabel && onShowDoc && <Button variant="ghost" onClick={() => { reset(); onShowDoc(); }}>צפייה במסמך</Button>}
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
