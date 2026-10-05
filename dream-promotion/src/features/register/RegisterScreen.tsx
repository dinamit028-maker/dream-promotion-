'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase, isCloudConfigured } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import { Button, Card, Chip, Field, Input, PageHead, Select, SmallSelect } from '@/components/ui/primitives';
import { EmptyState, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL, israelParts } from '@/lib/il-time';
import { CashRegister, CornersIn, CornersOut } from '@/components/ui/Icon';
import { phoneDigits, waLink } from '@/features/crm/crm';
import { DocumentsTab, docInsertRow, printDocRow, toDoc, type DocRow } from '@/features/documents/DocumentsTab';
import { DOC_LABEL, creditFor, creditForRefund, creditedTotals, docFromSale } from '@/features/documents/documents';
import { enablePush, needsHomeScreen, notifySale, pushKeyReady, pushSupported, sendTest } from './notifications';
import { ShiftTab } from './ShiftTab';
import { PosView, type CheckoutInput, type CheckoutResult, type PosItem, type TodayAppt } from './PosView';
import { RefundPanel, refundSlipHtml } from './RefundPanel';
import { CommissionsTab } from './CommissionsTab';
import { israelToIso } from '@/lib/il-time';
import { METHODS, computeSale, ils, methodLabel, payRequestText, saleDay, salesCsv, summarize, type Line, type Method, type Refund, type Sale } from './money';
import { refundLeft, refundSummary, toRefund, type RefundPlan } from './refunds';
import { MOVE_HE, applyStock, lowStockList, planAdjust, stockLevel, stockText } from './stock';
import { billingColumns } from './billing';
import { issueDocumentRow } from '@/features/finance/api';

/** Toolbox stage 3: sell, record payments, refunds, reports, close of day, commissions, documents, price list & stock. */
type Item = PosItem & { sort: number };
const KIND_HE: Record<Item['kind'], string> = { service: 'טיפול/שירות', product: 'מוצר', package: 'חבילה', other: 'אחר' };
type Settings = { businessType: 'exempt' | 'licensed'; vatRate: number; payLink: string;
  dealerNumber: string; companyNumber: string; legalName: string; street: string; houseNo: string; city: string; zip: string };
const DEFAULTS: Settings = { businessType: 'licensed', vatRate: 18, payLink: '', dealerNumber: '', companyNumber: '', legalName: '', street: '', houseNo: '', city: '', zip: '' };
const toSale = (r: any): Sale => ({
  id: r.id, leadId: r.lead_id, appointmentId: r.appointment_id, customerName: r.customer_name ?? '', customerPhone: r.customer_phone ?? '',
  items: r.items ?? [], subtotal: Number(r.subtotal), discount: Number(r.discount), total: Number(r.total), vatRate: Number(r.vat_rate), vatAmount: Number(r.vat_amount),
  method: r.method, status: r.status, note: r.note ?? '', paidAt: r.paid_at, createdAt: r.created_at,
  payments: r.payments ?? [], employeeId: r.employee_id ?? null, employeeName: r.employee_name ?? '',
  billingName: r.billing_name ?? '', customerDealer: r.customer_dealer ?? '', customerStreet: r.customer_street ?? '', customerCity: r.customer_city ?? '',
  cashReceived: r.cash_received == null ? null : Number(r.cash_received), changeGiven: r.change_given == null ? null : Number(r.change_given),
} as Sale & { cashReceived: number | null; changeGiven: number | null });
const toItem = (r: any): Item => ({ id: r.id, name: r.name, price: Number(r.price), kind: r.kind, active: r.active, sort: r.sort ?? 0,
  favorite: Boolean(r.favorite), favOrder: r.fav_order ?? 0, imageUrl: r.image_url ?? '',
  trackStock: Boolean(r.track_stock), stockQty: Number(r.stock_qty ?? 0), lowStock: Number(r.low_stock ?? 2) });
const MIGRATION_250 = 'צריך להריץ את מיגרציה 20261004003000 (קופה 2.50) ב-Supabase.';
const errText = (e: any) => /relation .* does not exist|schema cache/i.test(String(e?.message)) ? (/billing_|customer_dealer|refund|stock|access/.test(String(e?.message)) ? MIGRATION_250 : 'צריך להריץ את מיגרציית הקופה ב-Supabase (20261003001200).')
  : /pay_link_check/.test(String(e?.message)) ? 'קישור התשלום חייב להתחיל ב-https://'
  : /row-level security|permission denied|42501/.test(String(e?.message) + String(e?.code)) ? 'אין הרשאה לפעולה הזו.' : 'משהו השתבש. נסו שוב.';
const refundErrText = (e: any) => { const m = String(e?.message ?? ''); return /refund_exceeds_paid/.test(m) ? 'הסכום גדול ממה שנשאר להחזיר על העסקה (אולי נרשם החזר ממכשיר אחר).'
  : /only a paid sale/.test(m) ? 'אפשר להחזיר רק על עסקה ששולמה.' : /sale_refunds|schema cache/.test(m) ? MIGRATION_250 : errText(e); };
const printHtml = (html: string) => { const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); } };

export function RegisterScreen() {
  const { userId, brand, leads, addLeadNow, addActivity, updateLead } = useApp();
  const cashier = useApp((s) => s.access === 'register');
  const kiosk = useApp((s) => s.kiosk);
  const setKiosk = useApp((s) => s.setKiosk);
  type Tab = 'sell' | 'sales' | 'shift' | 'commissions' | 'catalog' | 'docs' | 'settings';
  const [tab, setTab] = useState<Tab>('sell');
  const [items, setItems] = useState<Item[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([]);
  const [todayAppts, setTodayAppts] = useState<TodayAppt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 3500); };
  useEffect(() => { if (cashier) setTab('sell'); }, [cashier]);

  const [openSale, setOpenSale] = useState<Sale | null>(null);
  const [olderDone, setOlderDone] = useState(false);
  async function loadOlder() {
    if (!userId) return;
    const oldest = sales.reduce((a, s) => (s.createdAt < a ? s.createdAt : a), new Date().toISOString());
    const { data } = await supabase().from('sales').select('*').lt('created_at', oldest).order('created_at', { ascending: false }).limit(300);
    const more = (data ?? []).map(toSale);
    if (more.length < 300) setOlderDone(true);
    setSales((all) => [...all, ...more.filter((m) => !all.some((x) => x.id === m.id))]);
  }
  const [prefill, setPrefill] = useState<{ customer: { name: string; phone: string; leadId: string | null; appointmentId: string | null }; line: Line | null } | null>(null);
  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const sb = supabase();
      const since = new Date(Date.now() - 100 * 864e5).toISOString();
      const [st, it, sa] = await Promise.all([
        sb.from('register_settings').select('*').maybeSingle(),
        sb.from('catalog_items').select('*').order('sort').order('created_at'),
        sb.from('sales').select('*').or(`created_at.gte.${since},status.eq.pending`).order('created_at', { ascending: false }).limit(2000),
      ]);
      for (const r of [st, it, sa]) if (r.error) throw r.error;
      if (st.data) setSettings({ businessType: st.data.business_type, vatRate: Number(st.data.vat_rate), payLink: st.data.pay_link ?? '',
        dealerNumber: st.data.dealer_number ?? '', companyNumber: st.data.company_number ?? '', legalName: st.data.legal_name ?? '',
        street: st.data.street ?? '', houseNo: st.data.house_no ?? '', city: st.data.city ?? '', zip: st.data.zip ?? '' });
      setItems((it.data ?? []).map(toItem));
      // for the POS: who sells (names only — pos_employees(); before 2.50 the table itself) and today's appointments
      const dayStart = israelToIso(israelParts(Date.now()).date, '00:00');
      const [emps, appts, svcs, rf] = await Promise.all([
        sb.rpc('pos_employees'),
        sb.from('appointments').select('id, name, phone, lead_id, service_id, service_name, start_at, status')
          .gte('start_at', dayStart).lt('start_at', new Date(new Date(dayStart).getTime() + 864e5).toISOString()).order('start_at'),
        sb.from('booking_services').select('id, price'),
        cashier ? Promise.resolve({ data: [], error: null }) : sb.from('sale_refunds').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(2000),
      ]);
      const empList = emps.error ? (await sb.from('employees').select('id, name').eq('active', true).order('created_at')).data ?? [] : emps.data ?? [];
      setEmployees(empList as any);
      const price = new Map(((svcs.data ?? []) as any[]).map((x) => [x.id, x.price == null ? null : Number(x.price)]));
      setTodayAppts(appts.error ? [] : ((appts.data ?? []) as any[]).filter((a) => a.status !== 'cancelled' && a.status !== 'no_show')
        .map((a) => ({ id: a.id, name: a.name, phone: a.phone ?? '', leadId: a.lead_id, serviceName: a.service_name ?? '', start: a.start_at, price: price.get(a.service_id) ?? null })));
      setSales((sa.data ?? []).map(toSale));
      setRefunds(rf.error ? [] : ((rf.data ?? []) as any[]).map(toRefund)); // before the migration there are no refunds
      setError(null);
    } catch (e) { setError(errText(e)); }
    finally { setLoading(false); }
  }, [userId, cashier]);
  useEffect(() => { void load(); }, [load]);

  // arriving from an appointment ("💳 חיוב"): customer + service prefilled
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.get('name') && !q.get('item')) return;
    setPrefill({ customer: { name: q.get('name') ?? '', phone: q.get('phone') ?? '', leadId: q.get('lead'), appointmentId: q.get('appt') },
      line: q.get('item') ? { name: q.get('item')!, price: Number(q.get('price') || 0), qty: 1 } : null });
    window.history.replaceState(null, '', '/register');
  }, []);

  // full screen: the register alone, on the whole screen (Esc / the button leave it)
  useEffect(() => {
    const h = () => { if (!document.fullscreenElement && useApp.getState().kiosk && (window as any).__dpFsEntered) { (window as any).__dpFsEntered = false; setKiosk(false); } };
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, [setKiosk]);
  async function toggleKiosk() {
    if (kiosk) { setKiosk(false); if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); return; }
    setKiosk(true);
    try { await document.documentElement.requestFullscreen?.(); (window as any).__dpFsEntered = Boolean(document.fullscreenElement); } catch { /* iPad / in-app browsers: the menus are hidden anyway */ }
  }

  const vat = { type: settings.businessType, rate: settings.vatRate };
  const business = {
    dealerNumber: settings.dealerNumber, companyNumber: settings.companyNumber, name: settings.legalName || brand.name,
    street: settings.street, houseNo: settings.houseNo, city: settings.city, zip: settings.zip,
    ready: /^[0-9]{9}$/.test(settings.dealerNumber) && Boolean(settings.legalName || brand.name),
  };
  const licensed = settings.businessType === 'licensed';
  async function issueDocumentFull(s: Sale, leadId: string | null): Promise<{ label: string; token: string } | null> {
    if (!business.ready || !userId) return null;
    const d = docFromSale(s, { licensed, docDate: israelParts(Date.now()).date });
    // one document per sale, whatever happens (a double tap, a retry after a lost answer): the key "sale:<id>" (2.51)
    const out = await issueDocumentRow({ ...docInsertRow(userId, d, { saleId: s.id, leadId, vatRate: d.lines[0]?.vatRate ?? 0 }), idempotency_key: `sale:${s.id}`, source: 'pos' });
    if (!out.ok) { setError(`המכירה נשמרה, אבל המסמך לא הופק (${out.error}) אפשר להפיק אותו ב"כספים ← הכנסות".`); return null; }
    return { label: `הופקה ${DOC_LABEL[out.doc.docType]} מס׳ ${out.doc.docNumber}`, token: out.doc.shareToken ?? '' };
  }
  /** every paid sale gets its legal document (numbered by the database, never editable) */
  async function issueDocument(s: Sale, leadId: string | null): Promise<string> {
    const d = await issueDocumentFull(s, leadId);
    return d ? ` · ${d.label}` : '';
  }
  function crmPurchase(leadId: string, s: { total: number; items: Line[]; method: Method }) {
    addActivity(leadId, 'purchase', `${s.items.map((l) => l.name).join(' + ')} · ${ils(s.total)} · ${methodLabel(s.method)}`);
    const l = useApp.getState().leads.find((x) => x.id === leadId);
    updateLead(leadId, { value: (l?.value ?? 0) + s.total, status: 'נסגר' });
  }

  async function checkout(c: CheckoutInput): Promise<CheckoutResult> {
    if (!userId) return { ok: false, error: 'אין חיבור' };
    const tt = computeSale(c.lines, c.discount, vat);
    if (!c.lines.length || tt.total <= 0) return { ok: false, error: 'הסל ריק' };
    let leadId = c.customer.leadId || leads.find((l) => c.customer.phone && phoneDigits(l.phone) === phoneDigits(c.customer.phone))?.id || null;
    // a new customer is saved first — the sale points to it
    if (!leadId && c.customer.name.trim()) leadId = await addLeadNow({ name: c.customer.name.trim(), phone: c.customer.phone.trim(), source: 'קופה', date: israelParts(Date.now()).date, status: c.paidNow ? 'נסגר' : 'מעוניין', value: 0 });
    const now = new Date().toISOString();
    const { data, error: e } = await supabase().from('sales').insert({
      user_id: userId, lead_id: leadId, appointment_id: c.customer.appointmentId, customer_name: c.customer.name.trim(), customer_phone: c.customer.phone.trim(),
      items: c.lines.filter((l) => l.qty > 0), subtotal: tt.subtotal, discount: tt.discount, total: tt.total, vat_rate: tt.vatRate, vat_amount: tt.vatAmount,
      method: c.paidNow ? c.method : 'link', payments: c.method === 'split' ? c.payments : [], status: c.paidNow ? 'paid' : 'pending', note: c.note, paid_at: c.paidNow ? now : null,
      employee_id: c.employee?.id ?? null, employee_name: c.employee?.name ?? '',
      ...(c.cashReceived != null ? { cash_received: c.cashReceived, change_given: Math.round((c.cashReceived - tt.total) * 100) / 100 } : {}),
      ...(c.billing ? billingColumns(c.billing) : {}),
    }).select('*').single();
    if (e) return { ok: false, error: errText(e) };
    const sale = toSale(data);
    setSales((all) => [sale, ...all]);
    // the database moved the stock (trigger); the screen follows at once
    const after = applyStock(items, sale.items);
    setItems(after);
    const touched = new Set(sale.items.map((l) => l.itemId).filter(Boolean));
    const low = lowStockList(after.filter((i) => touched.has(i.id))).map((i) => `${i.name} (${stockText(i)})`);
    if (leadId && c.billing) {
      const b = billingColumns(c.billing);
      updateLead(leadId, { billingName: b.billing_name, billingDealer: b.customer_dealer, billingStreet: b.customer_street, billingCity: b.customer_city });
    }
    if (leadId && c.paidNow) crmPurchase(leadId, sale);
    if (!c.paidNow) { if (leadId) addActivity(leadId, 'note', `נשלחה בקשת תשלום: ${ils(sale.total)}`); requestPayment(sale); }
    const doc = c.paidNow ? await issueDocumentFull(sale, leadId) : null;
    void notifySale(sale.id); // the managers' phones — never blocks the sale
    return { ok: true, sale, docLabel: doc?.label, docUrl: doc?.token ? `${window.location.origin}/d/${doc.token}` : undefined, lowStock: low };
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
    say(`סומן כשולם${await issueDocument({ ...s, method: m, status: 'paid', paidAt: paid_at }, s.leadId)}`);
    void notifySale(s.id);
  }
  /** cancel a record: an unpaid request, or a paid sale entered by mistake (its tax invoice gets a full credit invoice) */
  async function cancelSale(s: Sale) {
    const paid = s.status === 'paid';
    if (paid && refunds.some((r) => r.saleId === s.id)) { setError('על העסקה כבר נרשם החזר — ממשיכים ב"החזר כספי", לא בביטול.'); return; }
    if (!window.confirm(paid
      ? 'לבטל את הרישום? רק אם העסקה נרשמה בטעות ולא התקבל כסף. אם הופקה חשבונית מס — תופק עליה חשבונית זיכוי. (אם התקבל כסף — "החזר כספי")'
      : 'לבטל את בקשת התשלום?')) return;
    const { error: e } = await supabase().from('sales').update({ status: 'cancelled' }).eq('id', s.id);
    if (e) { setError(errText(e)); return; }
    setSales((all) => all.map((x) => (x.id === s.id ? { ...x, status: 'cancelled' } : x)));
    setItems((all) => applyStock(all, s.items, -1)); // the database put the units back
    if (s.leadId) addActivity(s.leadId, 'note', `בוטלה ${paid ? 'מכירה' : 'בקשת תשלום'}: ${ils(s.total)}`);
    let note = '';
    if (paid && userId) {
      const { data } = await supabase().from('documents').select('*').eq('sale_id', s.id).order('issued_at');
      const docs = (data ?? []).map(toDoc);
      const orig = docs.find((d) => d.docType === 320 || d.docType === 305);
      if (licensed && orig && !docs.some((d) => d.docType === 330)) {
        const c = creditFor(orig, israelParts(Date.now()).date);
        const ins = await issueDocumentRow({ ...docInsertRow(userId, c, { saleId: s.id, leadId: s.leadId, vatRate: c.lines[0]?.vatRate ?? 0 }), idempotency_key: `cancel:${s.id}` });
        note = !ins.ok ? ' · חשבונית הזיכוי לא הופקה — אפשר להפיק ב"מסמכים"' : ` · הופקה חשבונית מס זיכוי מס׳ ${ins.doc.docNumber}`;
      }
      // an exempt dealer's receipt of a sale entered by mistake is cancelled (the receipt stays, marked "בוטל" — 2.51)
      const receipt = docs.find((d) => d.docType === 400);
      if (!licensed && receipt) {
        const { error: ce } = await supabase().from('document_cancellations').insert({ document_id: receipt.id, user_id: userId, reason: 'המכירה בוטלה בקופה (נרשמה בטעות)' });
        note = ce ? (/schema cache|does not exist|PGRST20/.test(ce.message) ? '' : ' · הקבלה לא בוטלה — אפשר לבטל אותה ב"כספים ← מסמכים"') : ` · קבלה מס׳ ${receipt.docNumber} סומנה כמבוטלת`;
      }
    }
    say(`הרישום בוטל${note}`); setOpenSale(null);
  }

  /** "החזר כספי": the refund is recorded (checked by the database), then its credit invoice and the customer's history */
  async function refund(sale: Sale, plan: RefundPlan): Promise<{ ok: boolean; error?: string; message?: string }> {
    if (!userId) return { ok: false, error: 'אין חיבור' };
    const { data, error: e } = await supabase().from('sale_refunds').insert({
      user_id: userId, sale_id: sale.id, amount: plan.amount, vat_amount: plan.vatAmount, method: plan.method,
      items: plan.items, restock: plan.restock, reason: plan.reason, employee_name: plan.employeeName,
    }).select('*').single();
    if (e) return { ok: false, error: refundErrText(e) };
    const r = toRefund(data);
    setRefunds((all) => [r, ...all]);
    if (r.restock) setItems((all) => applyStock(all, r.items, -1));
    let message = `ההחזר נרשם: ${ils(r.amount)} ב${methodLabel(r.method)}`;
    if (business.ready && licensed) {
      const { data } = await supabase().from('documents').select('*').eq('sale_id', sale.id).order('issued_at');
      const docs = (data ?? []).map(toDoc);
      const orig = docs.find((d) => d.docType === 320 || d.docType === 305) ?? null;
      // never credit a document beyond its total (it may have been credited by hand in "מסמכים")
      const creditedA = Math.round((creditedTotals(docs).get(orig ? `${orig.docType}:${orig.docNumber}` : '') ?? 0) * 100);
      if (orig && creditedA + Math.round(r.amount * 100) > Math.round(orig.total * 100)) {
        message += ' · החשבונית כבר זוכתה — לא הופקה חשבונית זיכוי נוספת';
      } else if (orig) {
        const c = creditForRefund(orig, r, sale, israelParts(Date.now()).date);
        const ins = await issueDocumentRow({ ...docInsertRow(userId, c, { saleId: sale.id, leadId: sale.leadId, vatRate: c.lines[0]?.vatRate ?? 0 }), refund_id: r.id, idempotency_key: `refund:${r.id}` });
        message += !ins.ok ? ' · חשבונית הזיכוי לא הופקה — אפשר להפיק ב"מסמכים"' : ` · הופקה חשבונית מס זיכוי מס׳ ${ins.doc.docNumber}`;
      }
    }
    if (sale.leadId) {
      addActivity(sale.leadId, 'note', `↩️ ${refundSummary({ ...r, methodLabel: methodLabel(r.method) })}${r.reason ? ` · ${r.reason}` : ''}`);
      const l = useApp.getState().leads.find((x) => x.id === sale.leadId);
      if (l) updateLead(l.id, { value: Math.max(0, Math.round(((l.value ?? 0) - r.amount) * 100) / 100) });
    }
    say(message);
    return { ok: true, message };
  }

  if (!isCloudConfigured || !userId) return (<><PageHead title="קופה" /><EmptyState icon={<CashRegister />} title="הקופה דורשת חשבון מחובר" body="התחברו לחשבון כדי לרשום מכירות." /></>);

  const pending = sales.filter((s) => s.status === 'pending');
  const today = israelParts(Date.now()).date;
  const low = lowStockList(items.filter((i) => i.active));
  const tabs: [Tab, string][] = cashier ? [['sell', 'מכירה']]
    : [['sell', 'מכירה'], ['sales', 'מכירות ודוחות'], ['shift', 'סגירת יום'], ['commissions', 'עמלות'], ['docs', 'מסמכים'], ['catalog', 'מחירון ומלאי'], ['settings', 'הגדרות']];
  const fullBtn = (
    <Button variant="ghost" size="sm" onClick={() => void toggleKiosk()} aria-pressed={kiosk}>
      {kiosk ? <><CornersIn size={18} aria-hidden />יציאה ממסך מלא</> : <><CornersOut size={18} aria-hidden />מסך מלא</>}
    </Button>
  );
  return (
    <>
      {kiosk ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <strong className="font-display text-xl font-extrabold">{brand.name || 'קופה'}</strong>{fullBtn}
        </div>
      ) : (
        <PageHead title="קופה" sub={cashier ? 'מכירה' : `היום: ${ils(summarize(sales, today, today, refunds).net)}${pending.length ? ` · ${pending.length} ממתינים לתשלום` : ''}`} action={fullBtn} />
      )}
      {tabs.length > 1 && (
        <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1">
          {tabs.map(([k, l]) => <Chip key={k} on={tab === k} onClick={() => setTab(k)}>{l}{k === 'sales' && pending.length ? ` (${pending.length})` : ''}{k === 'catalog' && low.length ? ` ⚠️${low.length}` : ''}</Chip>)}
        </div>
      )}
      {error && <p className="mb-4 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}
      {flash && <p role="status" className="mb-4 rounded-2xl bg-emerald-500/15 p-3 text-sm font-semibold text-emerald-700 dark:text-emerald-300">✓ {flash}</p>}
      {loading && <div className="py-8 text-center"><Spinner /></div>}

      {!loading && tab === 'sell' && (
        <>
          {low.length > 0 && !cashier && (
            <button type="button" onClick={() => setTab('catalog')} className="mb-3 flex w-full items-center justify-between gap-2 rounded-2xl bg-amber-500/15 px-4 py-2.5 text-start text-sm font-semibold text-amber-800 dark:text-amber-200">
              <span className="min-w-0 truncate">⚠️ מלאי נמוך: {low.slice(0, 4).map((i) => `${i.name} (${stockText(i)})`).join(' · ')}{low.length > 4 ? ` ועוד ${low.length - 4}` : ''}</span><span className="shrink-0">למלאי ←</span>
            </button>
          )}
          <PosView key={prefill ? 'prefill' : 'pos'} userId={userId} items={items} sales={sales} leads={leads} employees={employees} todayAppts={todayAppts}
            vat={vat} payLinkReady={Boolean(settings.payLink)} onCheckout={checkout} onShowDoc={cashier ? undefined : () => setTab('docs')} prefill={prefill}
            onGoCatalog={cashier ? undefined : () => setTab('catalog')} wide={kiosk} />
        </>
      )}

      {!loading && tab === 'sales' && <SalesTab sales={sales} refunds={refunds} onPaid={markPaid} onCancel={cancelSale} onRemind={requestPayment} canRemind={Boolean(settings.payLink)}
        onOpen={setOpenSale} onLoadOlder={olderDone ? undefined : loadOlder} />}
      {!loading && tab === 'shift' && <ShiftTab userId={userId} sales={sales} refunds={refunds} employees={employees} businessName={business.name} />}
      {!loading && tab === 'commissions' && <CommissionsTab sales={sales} refunds={refunds} catalog={items} onLoadOlder={olderDone ? undefined : loadOlder} />}

      <SaleDetail sale={openSale} onClose={() => setOpenSale(null)} business={business} refunds={refunds} employees={employees} licensed={licensed}
        onRefund={refund} onCancel={cancelSale} />

      {!loading && tab === 'docs' && <DocumentsTab userId={userId} business={business} licensed={licensed} onError={setError} />}

      {!loading && tab === 'catalog' && <CatalogTab userId={userId} items={items} reload={load} onError={(e) => setError(errText(e))}
        onStock={(id, qty) => setItems((all) => all.map((i) => (i.id === id ? { ...i, stockQty: qty, trackStock: true } : i)))} />}

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
          <p className="mb-2 mt-4 font-bold">פרטי העסק למסמכים</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="מספר עוסק מורשה / פטור (9 ספרות)"><Input value={settings.dealerNumber} onChange={(e) => setSettings({ ...settings, dealerNumber: e.target.value.replace(/\D/g, '').slice(0, 9) })} inputMode="numeric" dir="ltr" /></Field>
            <Field label="מספר ח.פ (בחברה, לא חובה)"><Input value={settings.companyNumber} onChange={(e) => setSettings({ ...settings, companyNumber: e.target.value.replace(/\D/g, '').slice(0, 9) })} inputMode="numeric" dir="ltr" /></Field>
            <Field label="שם העסק כפי שרשום"><Input value={settings.legalName} onChange={(e) => setSettings({ ...settings, legalName: e.target.value })} placeholder={brand.name} /></Field>
            <Field label="רחוב"><Input value={settings.street} onChange={(e) => setSettings({ ...settings, street: e.target.value })} /></Field>
            <Field label="מספר בית"><Input value={settings.houseNo} onChange={(e) => setSettings({ ...settings, houseNo: e.target.value })} /></Field>
            <Field label="עיר"><Input value={settings.city} onChange={(e) => setSettings({ ...settings, city: e.target.value })} /></Field>
            <Field label="מיקוד"><Input value={settings.zip} onChange={(e) => setSettings({ ...settings, zip: e.target.value })} inputMode="numeric" dir="ltr" /></Field>
          </div>
          <Button variant="primary" onClick={async () => {
            const { error: e } = await supabase().from('register_settings').upsert({ user_id: userId, business_type: settings.businessType, vat_rate: settings.vatRate, pay_link: settings.payLink,
              dealer_number: settings.dealerNumber, company_number: settings.companyNumber, legal_name: settings.legalName, street: settings.street, house_no: settings.houseNo, city: settings.city, zip: settings.zip }, { onConflict: 'business_id' });
            if (e) setError(errText(e)); else { setError(null); say('ההגדרות נשמרו'); }
          }}>שמירה</Button>
          <p className="mt-3 text-sm"><a href="/finance/settings" className="font-semibold text-primary">הגדרות כספים מלאות (סוג עסק, בנק, רו״ח, רשות המסים) ←</a></p>
          <SignatureStatus />
          <PushSettings userId={userId} />
          <p className="mt-4 rounded-2xl bg-surface-2 p-3 text-xs text-ink-2">
            כשפרטי העסק מלאים, כל מכירה ששולמה מפיקה אוטומטית <strong>{settings.businessType === 'licensed' ? 'חשבונית מס / קבלה' : 'קבלה'}</strong> במספור רץ. מסמך שהופק לא ניתן לשינוי — תיקון נעשה בחשבונית זיכוי.
            {' '}עד לרישום התוכנה ברשות המסים ולבדיקת יועץ מס, השתמשו במסמכים לבדיקה בלבד.
          </p>
          <p className="mt-2 rounded-2xl bg-surface-2 p-3 text-xs text-ink-2">
            <strong>עובד/ת בקופה בלבד:</strong> מנהל המערכת מוסיף עובד/ת עם הרשאת &quot;קופה בלבד&quot; (ניהול ← עסקים). מי שנכנס/ת כך רואה רק את מסך המכירה —
            בלי דוחות, הכנסות, החזרים, מחירון, הגדרות או מחיקות, ורק את העסקאות שלו/ה מהיום.
          </p>
        </Card>
      )}
    </>
  );
}

function SalesTab({ sales, refunds, onPaid, onCancel, onRemind, canRemind, onOpen, onLoadOlder }: { sales: Sale[]; refunds: Refund[]; onPaid: (s: Sale, m: Method) => void; onCancel: (s: Sale) => void; onRemind: (s: Sale) => void; canRemind: boolean;
  onOpen: (s: Sale) => void; onLoadOlder?: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const today = israelParts(Date.now()).date;
  const thisMonth = today.slice(0, 7);
  const prev = israelParts(new Date(`${thisMonth}-01T12:00:00Z`).getTime() - 864e5).date.slice(0, 7);
  const [period, setPeriod] = useState<'today' | 'month' | 'prev'>('today');
  const range = period === 'today' ? [today, today] : period === 'month' ? [`${thisMonth}-01`, `${thisMonth}-31`] : [`${prev}-01`, `${prev}-31`];
  const sum = useMemo(() => summarize(sales, range[0], range[1], refunds), [sales, refunds, range[0], range[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  // searching looks through every loaded transaction (all periods): customer, phone, item, amount, note, seller
  const qq = q.trim();
  const hit = (s: Sale) => [s.customerName, s.customerPhone, s.note, s.employeeName, ...s.items.map((l) => l.name)].some((v) => (v ?? '').includes(qq))
    || (qq.replace(/\D/g, '').length >= 3 && s.customerPhone.replace(/\D/g, '').includes(qq.replace(/\D/g, ''))) || (Number(qq) > 0 && Math.abs(s.total - Number(qq)) < 0.005);
  const list = qq ? sales.filter(hit).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : sales.filter((s) => saleDay(s) >= range[0] && saleDay(s) <= range[1]);
  const pending = sales.filter((s) => s.status === 'pending');
  const refundedBy = useMemo(() => { const m = new Map<string, number>(); for (const r of refunds) m.set(r.saleId, Math.round(((m.get(r.saleId) ?? 0) + r.amount) * 100) / 100); return m; }, [refunds]);
  const [payMethod, setPayMethod] = useState<Method>('link');
  function exportCsv() {
    const blob = new Blob([salesCsv(sales, range[0], range[1], refunds)], { type: 'text/csv;charset=utf-8' });
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
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש עסקה: לקוח, טלפון, פריט, סכום…" className="mb-3 h-11" aria-label="חיפוש עסקה" />
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {([['today', 'היום'], ['month', 'החודש'], ['prev', 'חודש קודם']] as const).map(([k, l]) => <Chip key={k} on={period === k} onClick={() => setPeriod(k)}>{l}</Chip>)}
        <Button size="sm" variant="ghost" onClick={exportCsv}>ייצוא לאקסל</Button>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card className="p-3"><span className="block text-xs text-muted">הכנסות{sum.refunds ? ' (נטו)' : ''}</span><strong className="text-xl tabular-nums">{ils(sum.net)}</strong>
          {sum.refunds > 0 && <span className="block text-xs text-muted">מכירות {ils(sum.total)} · החזרים −{ils(sum.refunds)}</span>}</Card>
        <Card className="p-3"><span className="block text-xs text-muted">מכירות</span><strong className="text-xl tabular-nums">{sum.count}</strong>{sum.refundCount > 0 && <span className="block text-xs text-muted">{sum.refundCount} החזרים</span>}</Card>
        <Card className="p-3"><span className="block text-xs text-muted">מתוכו מע״מ</span><strong className="text-xl tabular-nums">{ils(sum.vat)}</strong></Card>
        <Card className="p-3"><span className="block text-xs text-muted">ממתין</span><strong className="text-xl tabular-nums">{ils(sum.pendingTotal)}</strong></Card>
      </div>
      {sum.byMethod.length > 0 && (
        <p className="mb-4 text-sm text-ink-2">{sum.byMethod.map((m) => `${methodLabel(m.method)} ${ils(m.total)} (${m.count})${m.refunded ? ` · הוחזרו ${ils(m.refunded)}` : ''}`).join(' · ')}</p>
      )}
      <div className="grid grid-cols-1 gap-2">
        {list.map((s) => {
          const back = refundedBy.get(s.id) ?? 0;
          return (
            <button key={s.id} type="button" onClick={() => onOpen(s)} aria-label={`פרטי עסקה: ${s.customerName || 'ללא שם'} ${ils(s.total)}`}
              className={cx('flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-start text-sm hover:border-primary', s.status === 'cancelled' && 'opacity-50')}>
              <span className="min-w-0 flex-1">
                <strong className="block truncate">{s.customerName || 'ללא שם'} · {s.items.map((l) => l.name).join(' + ')}</strong>
                <span className="text-xs text-muted">{formatIL(s.paidAt ?? s.createdAt, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric' })} · {methodLabel(s.method)} · {s.status === 'paid' ? 'שולם' : s.status === 'pending' ? 'ממתין' : 'בוטל'}</span>
                {back > 0 && <span className="ms-1 rounded-full bg-zinc-500/15 px-2 py-0.5 text-[11px] font-bold">{back >= s.total ? 'הוחזר במלואו' : `הוחזרו ${ils(back)}`}</span>}
              </span>
              <strong className="tabular-nums">{ils(s.total)}</strong>
            </button>
          );
        })}
        {!list.length && <p className="py-6 text-center text-sm text-muted">{qq ? 'לא נמצאו עסקאות.' : 'אין מכירות בתקופה הזו.'}</p>}
      </div>
      {onLoadOlder && <Button variant="ghost" className="mt-3 w-full" onClick={() => void onLoadOlder()}>טעינת עסקאות קודמות</Button>}
    </>
  );
}

function CatalogTab({ userId, items, reload, onError, onStock }: { userId: string; items: Item[]; reload: () => void; onError: (e: unknown) => void; onStock: (id: string, qty: number) => void }) {
  const [d, setD] = useState({ name: '', price: '', kind: 'service' as Item['kind'] });
  const [history, setHistory] = useState<{ item: Item; rows: { at: string; delta: number; after: number; reason: string; note: string }[] | null } | null>(null);
  const favs = items.filter((i) => i.favorite).sort((a, b) => a.favOrder - b.favOrder);
  const low = lowStockList(items.filter((i) => i.active));
  /** move a favorite up/down — rewrites the order of all favorites (8–16 items, cheap) */
  async function moveFav(id: string, dir: -1 | 1) {
    const list = [...favs]; const i = list.findIndex((x) => x.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    for (const [k, it] of list.entries()) { const { error } = await supabase().from('catalog_items').update({ fav_order: k }).eq('id', it.id); if (error) return onError(error); }
    reload();
  }
  const run = async (p: PromiseLike<{ error: any }>) => { const { error } = await p; if (error) onError(error); else reload(); };
  async function importServices() {
    const { data, error } = await supabase().from('booking_services').select('name, price').eq('active', true);
    if (error) return onError(error);
    const fresh = (data ?? []).filter((s: any) => s.price != null && !items.some((i) => i.name === s.name));
    if (!fresh.length) return;
    await run(supabase().from('catalog_items').insert(fresh.map((s: any, k: number) => ({ user_id: userId, name: s.name, price: Number(s.price), kind: 'service', sort: items.length + k }))));
  }
  /** "+ קבלת סחורה" / "ספירת מלאי" — through adjust_stock(), so every unit is logged */
  async function adjust(i: Item, mode: 'add' | 'set') {
    const raw = window.prompt(mode === 'add' ? `כמה יחידות של "${i.name}" התקבלו?` : `כמה יחידות של "${i.name}" יש בפועל? (ספירה)`, mode === 'set' ? String(Math.max(0, i.stockQty)) : '');
    if (raw === null) return;
    const p = planAdjust(i.trackStock ? i.stockQty : 0, mode, Number(raw));
    if (!p.ok) return onError({ message: p.error });
    const note = mode === 'add' ? (window.prompt('הערה (לא חובה) — למשל: ספק, חשבונית', '') ?? '') : '';
    const { data, error } = await supabase().rpc('adjust_stock', { p_item: i.id, p_mode: mode, p_qty: Number(raw), p_note: note });
    if (error) return onError(/adjust_stock|schema cache/.test(error.message) ? { message: 'relation stock does not exist' } : error);
    onStock(i.id, Number(data));
  }
  async function openHistory(i: Item) {
    setHistory({ item: i, rows: null });
    const { data } = await supabase().from('stock_movements').select('created_at, delta, qty_after, reason, note').eq('item_id', i.id).order('created_at', { ascending: false }).limit(40);
    setHistory({ item: i, rows: ((data ?? []) as any[]).map((r) => ({ at: r.created_at, delta: r.delta, after: r.qty_after, reason: r.reason, note: r.note ?? '' })) });
  }
  return (
    <div className="grid gap-3">
      {low.length > 0 && <p className="rounded-2xl bg-amber-500/15 p-3 text-sm font-semibold text-amber-800 dark:text-amber-200">⚠️ מלאי נמוך: {low.map((i) => `${i.name} (${stockText(i)})`).join(' · ')}</p>}
      <p className="text-xs text-muted">⭐ = מועדף בקופה (מומלץ 8–16 פריטים). החצים קובעים את הסדר. מלאי: &quot;קבלה&quot; מוסיפה יחידות, &quot;ספירה&quot; קובעת את מה שיש בפועל — כל מכירה מורידה מהמלאי לבד.</p>
      {[...favs, ...items.filter((i) => !i.favorite)].map((i) => {
        const level = stockLevel(i);
        return (
          <Card key={i.id} className="flex min-w-0 flex-wrap items-center gap-2 p-3">
            <button type="button" aria-pressed={i.favorite} aria-label={i.favorite ? `הסרה מהמועדפים: ${i.name}` : `הוספה למועדפים: ${i.name}`} className="text-xl"
              onClick={() => run(supabase().from('catalog_items').update({ favorite: !i.favorite, fav_order: i.favorite ? 0 : favs.length }).eq('id', i.id))}>{i.favorite ? '⭐' : '☆'}</button>
            <span className="min-w-0 flex-1"><strong className={cx('block truncate', !i.active && 'text-muted line-through')}>{i.name}</strong><span className="text-xs text-muted">{ils(i.price)} · {KIND_HE[i.kind]}</span></span>
            <SmallSelect value={i.kind} onChange={(e) => run(supabase().from('catalog_items').update({ kind: e.target.value }).eq('id', i.id))} className="w-32" aria-label={`קטגוריה: ${i.name}`}>
              {Object.entries(KIND_HE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </SmallSelect>
            {i.favorite && <span className="flex">
              <button type="button" className="h-9 w-8 rounded-full border border-line" aria-label={`למעלה: ${i.name}`} onClick={() => moveFav(i.id, -1)}>↑</button>
              <button type="button" className="h-9 w-8 rounded-full border border-line" aria-label={`למטה: ${i.name}`} onClick={() => moveFav(i.id, 1)}>↓</button>
            </span>}
            <Button size="sm" variant="ghost" onClick={() => run(supabase().from('catalog_items').update({ active: !i.active }).eq('id', i.id))}>{i.active ? 'הסתרה' : 'הצגה'}</Button>
            <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`למחוק את "${i.name}"? מכירות קודמות לא ישתנו.`)) void run(supabase().from('catalog_items').delete().eq('id', i.id)); }}>מחיקה</Button>
            {(i.kind === 'product' || i.trackStock) && (
              <div className="flex w-full flex-wrap items-center gap-2 border-t border-line pt-2 text-sm">
                {i.trackStock ? <>
                  <span className={cx('rounded-full px-2.5 py-1 text-xs font-bold tabular-nums', level === 'out' ? 'bg-red-500/15 text-red-700 dark:text-red-300' : level === 'low' ? 'bg-amber-500/15 text-amber-800 dark:text-amber-200' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300')}>
                    📦 {stockText(i)}</span>
                  <Button size="sm" variant="ghost" onClick={() => void adjust(i, 'add')}>+ קבלת סחורה</Button>
                  <Button size="sm" variant="ghost" onClick={() => void adjust(i, 'set')}>ספירה</Button>
                  <label className="flex items-center gap-1 text-xs text-muted">התראה מתחת ל-
                    <Input type="number" min={0} defaultValue={i.lowStock} className="h-8 w-16 py-0 text-center" aria-label={`רמת התראה: ${i.name}`}
                      onBlur={(e) => { const v = Math.max(0, Math.floor(Number(e.target.value) || 0)); if (v !== i.lowStock) void run(supabase().from('catalog_items').update({ low_stock: v }).eq('id', i.id)); }} />
                  </label>
                  <button type="button" className="text-xs font-semibold text-primary" onClick={() => void openHistory(i)}>היסטוריה</button>
                </> : <Button size="sm" variant="ghost" onClick={() => void adjust(i, 'set')}>📦 ניהול מלאי (ספירה ראשונה)</Button>}
              </div>
            )}
          </Card>
        );
      })}
      <Card className="p-3">
        <p className="mb-2 text-sm font-semibold">פריט חדש</p>
        <div className="grid gap-2 sm:grid-cols-[1fr_120px_130px_auto]">
          <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="למשל: הסרת שיער — רגליים" />
          <Input type="number" inputMode="decimal" value={d.price} onChange={(e) => setD({ ...d, price: e.target.value })} placeholder="מחיר ₪" />
          <Select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as Item['kind'] })} aria-label="קטגוריה">{Object.entries(KIND_HE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <Button variant="primary" disabled={!d.name.trim() || !(Number(d.price) >= 0) || d.price === ''} onClick={async () => {
            await run(supabase().from('catalog_items').insert({ user_id: userId, name: d.name.trim(), price: Number(d.price), kind: d.kind, sort: items.length }));
            setD({ name: '', price: '', kind: d.kind });
          }}>הוספה</Button>
        </div>
        <button type="button" className="mt-3 text-sm font-semibold text-primary" onClick={importServices}>ייבוא השירותים מזימון התורים (עם מחיר)</button>
      </Card>

      <Modal open={Boolean(history)} onClose={() => setHistory(null)}>
        {history && <>
          <h3 className="mb-3 font-display text-xl font-extrabold">📦 {history.item.name} · היסטוריית מלאי</h3>
          {history.rows === null ? <Spinner /> : !history.rows.length ? <p className="text-sm text-muted">עוד אין תנועות.</p> : (
            <ul className="grid max-h-[60vh] gap-1.5 overflow-y-auto text-sm tabular-nums">
              {history.rows.map((r, k) => (
                <li key={k} className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2">
                  <span className="min-w-0">{MOVE_HE[r.reason] ?? r.reason}{r.note ? ` · ${r.note}` : ''}<span className="block text-xs text-muted">{formatIL(r.at, { dateStyle: 'short', timeStyle: 'short' })}</span></span>
                  <span dir="ltr" className={cx('font-bold', r.delta < 0 ? 'text-red-600' : 'text-emerald-600')}>{r.delta > 0 ? `+${r.delta}` : r.delta}</span>
                  <span className="text-xs text-muted">נשארו {r.after}</span>
                </li>
              ))}
            </ul>
          )}
        </>}
      </Modal>
    </div>
  );
}

/** "חתימה דיגיטלית": whether the platform's certificate is set (Vercel env), whose and until when */
function SignatureStatus() {
  const [s, setS] = useState<{ configured: boolean; subject?: string; validTo?: string; error?: string } | null>(null);
  useEffect(() => {
    (async () => {
      try { const r = await fetch('/api/doc/sign-status', { headers: await authHeaders() }); setS(r.ok ? await r.json() : { configured: false }); }
      catch { setS({ configured: false }); }
    })();
  }, []);
  if (!s) return null;
  return (
    <div className="mt-5 rounded-2xl border border-line p-3 text-sm">
      <p className="font-bold">🔏 חתימה דיגיטלית על מסמכים</p>
      {s.configured ? (
        <p className="mt-1">✓ פעילה. כל מסמך שנשלח ללקוח בקישור אפשר להוריד כ-PDF חתום{s.subject ? ` (תעודה: ${s.subject}` : ''}{s.validTo ? `, בתוקף עד ${formatIL(s.validTo, { dateStyle: 'short' })})` : s.subject ? ')' : ''}.</p>
      ) : (
        <p className="mt-1 text-ink-2">{s.error ? `התעודה לא נטענה: ${s.error}` : 'עוד לא הוגדרה תעודת חתימה.'} עד אז ה-PDF יוצא <strong>לא חתום</strong>. מגדירים פעם אחת ב-Vercel: DOC_SIGN_P12_BASE64 ו-DOC_SIGN_P12_PASSWORD (תעודה מגורם מאשר — ראו REGISTRATION.md).</p>
      )}
    </div>
  );
}

/** "a notification on my phone for every sale" — the devices of this business account */
function PushSettings({ userId }: { userId: string }) {
  const [devices, setDevices] = useState<{ id: string; label: string; created_at: string }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data } = await supabase().from('push_subscriptions').select('id, label, created_at').eq('user_id', userId).order('created_at');
    setDevices((data ?? []) as any);
  }, [userId]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="mt-5 rounded-2xl border border-line p-3">
      <p className="font-bold">🔔 התראה לטלפון על כל עסקה</p>
      <p className="mb-2 text-xs text-muted">בכל מכירה (גם של עובד/ת בקופה) תגיע התראה למכשירים שהופעלו כאן — סכום, לקוח, אמצעי תשלום ומוכר/ת; וכשמוצר יורד מתחת לרמת ההתראה — התראת מלאי.</p>
      {!pushKeyReady() ? <p className="text-sm text-warn">צריך להגדיר ב-Vercel את מפתחות ההתראות (VAPID) — ראו התקנה.</p>
        : !pushSupported() ? <p className="text-sm text-warn">הדפדפן הזה לא תומך בהתראות.</p>
        : needsHomeScreen() ? <p className="text-sm">באייפון: <strong>שיתוף ← הוספה למסך הבית</strong>, ואז פותחים את Dream Promotion מהמסך הבית ומפעילים כאן.</p>
        : <Button variant="primary" disabled={busy} onClick={async () => { setBusy(true); const r = await enablePush(userId); setMsg(r.message); setBusy(false); void load(); }}>הפעלת התראות במכשיר הזה</Button>}
      {devices.length > 0 && (
        <ul className="mt-3 grid gap-1.5 text-sm">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2">
              <span>📱 {d.label || 'מכשיר'} · מ-{formatIL(d.created_at, { dateStyle: 'short' })}</span>
              <button type="button" className="text-xs text-muted" onClick={async () => { await supabase().from('push_subscriptions').delete().eq('id', d.id); void load(); }}>הסרה</button>
            </li>
          ))}
          <li><Button size="sm" variant="ghost" onClick={async () => setMsg(await sendTest())}>שליחת התראת ניסיון</Button></li>
        </ul>
      )}
      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}

/** one transaction: what was sold, how it was paid, who sold it — its refunds, and its documents (copy / signed PDF / WhatsApp) */
function SaleDetail({ sale, onClose, business, refunds, employees, licensed, onRefund, onCancel }: {
  sale: Sale | null; onClose: () => void; business: { dealerNumber: string; name: string; ready: boolean } & Record<string, any>;
  refunds: Refund[]; employees: { id: string; name: string }[]; licensed: boolean;
  onRefund: (sale: Sale, plan: RefundPlan) => Promise<{ ok: boolean; error?: string; message?: string }>; onCancel: (s: Sale) => void;
}) {
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [phone, setPhone] = useState('');
  const loadDocs = useCallback(async (s: Sale) => {
    const { data } = await supabase().from('documents').select('*').eq('sale_id', s.id).order('issued_at');
    setDocs((data ?? []).map(toDoc));
  }, []);
  useEffect(() => {
    if (!sale) return;
    setDocs(null); setPhone(sale.customerPhone);
    void loadDocs(sale);
  }, [sale, loadDocs]);
  if (!sale) return null;
  const pays = sale.method === 'split' ? sale.payments ?? [] : [{ method: sale.method, amount: sale.total }];
  const hasRefunds = refunds.some((r) => r.saleId === sale.id);
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="font-display text-xl font-extrabold">{sale.customerName || 'לקוח מזדמן'} · {ils(sale.total)}</h3>
      <p className="mb-3 text-xs text-muted">{formatIL(sale.paidAt ?? sale.createdAt)} · {sale.status === 'paid' ? 'שולם' : sale.status === 'pending' ? 'ממתין לתשלום' : 'בוטל'}{sale.employeeName ? ` · מוכר/ת: ${sale.employeeName}` : ''}</p>
      <ul className="mb-3 grid gap-1 text-sm">
        {sale.items.map((l, i) => <li key={i} className="flex justify-between"><span>{l.name}{l.qty > 1 ? ` ×${l.qty}` : ''}</span><span className="tabular-nums">{ils(l.price * l.qty)}</span></li>)}
        {sale.discount > 0 && <li className="flex justify-between text-muted"><span>הנחה</span><span>−{ils(sale.discount)}</span></li>}
        <li className="flex justify-between border-t border-line pt-1 font-bold"><span>סה״כ</span><span>{ils(sale.total)}</span></li>
      </ul>
      <p className="mb-3 text-sm">{pays.map((p) => `${methodLabel(p.method as Method)} ${ils(p.amount)}`).join(' · ')}
        {(sale as any).cashReceived != null && ` · התקבל ${ils((sale as any).cashReceived)}, עודף ${ils((sale as any).changeGiven ?? 0)}`}</p>
      {sale.customerDealer && <p className="mb-3 text-sm text-ink-2">חשבונית לעסק: {sale.billingName || sale.customerName} · ע.מ {sale.customerDealer}{sale.customerStreet || sale.customerCity ? ` · ${[sale.customerStreet, sale.customerCity].filter(Boolean).join(', ')}` : ''}</p>}
      {sale.note && <p className="mb-3 text-sm text-ink-2">הערה: {sale.note}</p>}

      <RefundPanel sale={sale} refunds={refunds} employees={employees} licensed={licensed} docsReady={business.ready}
        onRefund={async (plan) => { const r = await onRefund(sale, plan); if (r.ok) void loadDocs(sale); return r; }}
        onPrintSlip={(r) => printHtml(refundSlipHtml(r, sale, business.name))} />

      <p className="mb-2 font-semibold">מסמכים</p>
      {docs === null ? <Spinner /> : !docs.length ? <p className="text-sm text-muted">לא הופק מסמך לעסקה הזו.</p> : docs.map((d) => (
        <div key={d.id} className="mb-2 rounded-2xl bg-surface-2 p-3 text-sm">
          <p className="font-semibold">{DOC_LABEL[d.docType]} מס׳ {d.docNumber} · {ils(d.total)}{d.printCount ? ` · הודפס ${d.printCount}` : ''}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={async () => { const f = await printDocRow(d, business as any); if (f) setDocs((all) => (all ?? []).map((x) => (x.id === f.id ? f : x))); }}>
              {d.printCount ? 'הדפסת העתק' : 'הדפסת מקור'}
            </Button>
            {d.shareToken && <>
              <a href={`/api/doc/${d.shareToken}/pdf`} target="_blank" rel="noopener" className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold hover:border-primary">🔏 PDF</a>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="טלפון" inputMode="tel" dir="ltr" className="h-9 w-36 py-1" aria-label="טלפון לשליחה" />
              <Button size="sm" variant="primary" disabled={phoneDigits(phone).length < 9} onClick={() => {
                const url = waLink(phone, `שלום, ${DOC_LABEL[d.docType]} מס׳ ${d.docNumber} מ${business.name}: ${window.location.origin}/d/${d.shareToken}`);
                if (url) window.open(url, '_blank', 'noopener');
              }}>💬 שליחה בוואטסאפ</Button>
            </>}
          </div>
        </div>
      ))}
      {sale.status !== 'cancelled' && !hasRefunds && refundLeft(sale, refunds) > 0 && (
        <button type="button" className="mt-2 text-xs text-muted underline" onClick={() => onCancel(sale)}>
          {sale.status === 'paid' ? 'ביטול רישום (נרשם בטעות, לא התקבל כסף)' : 'ביטול בקשת התשלום'}
        </button>
      )}
    </Modal>
  );
}
