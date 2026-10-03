'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase, isCloudConfigured } from '@/lib/supabase/client';
import { Button, Card, Chip, Field, Input, PageHead, Select } from '@/components/ui/primitives';
import { EmptyState, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL, israelParts } from '@/lib/il-time';
import { CashRegister } from '@/components/ui/Icon';
import { phoneDigits, waLink } from '@/features/crm/crm';
import { DocumentsTab, docInsertRow, printDocRow, toDoc, type DocRow } from '@/features/documents/DocumentsTab';
import { DOC_LABEL, docFromSale } from '@/features/documents/documents';
import { enablePush, needsHomeScreen, notifySale, pushKeyReady, pushSupported, sendTest } from './notifications';
import { PosView, type CheckoutInput, type CheckoutResult, type PosItem, type TodayAppt } from './PosView';
import { israelToIso } from '@/lib/il-time';
import { METHODS, computeSale, ils, methodLabel, payRequestText, saleDay, salesCsv, summarize, type Line, type Method, type Sale } from './money';

/** Toolbox stage 3, part 1: price list, sell, record payments, reports. Records — not tax documents. */
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
  cashReceived: r.cash_received == null ? null : Number(r.cash_received), changeGiven: r.change_given == null ? null : Number(r.change_given),
} as Sale & { cashReceived: number | null; changeGiven: number | null });
const errText = (e: any) => /relation .* does not exist|schema cache/i.test(String(e?.message)) ? 'צריך להריץ את מיגרציית הקופה ב-Supabase (20261003001200).'
  : /pay_link_check/.test(String(e?.message)) ? 'קישור התשלום חייב להתחיל ב-https://' : 'משהו השתבש. נסו שוב.';

export function RegisterScreen() {
  const { userId, brand, leads, addLead, addActivity, updateLead } = useApp();
  const [tab, setTab] = useState<'sell' | 'sales' | 'catalog' | 'docs' | 'settings'>('sell');
  const [items, setItems] = useState<Item[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([]);
  const [todayAppts, setTodayAppts] = useState<TodayAppt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 3000); };

  const [openSale, setOpenSale] = useState<Sale | null>(null);
  const [olderDone, setOlderDone] = useState(false);
  async function loadOlder() {
    if (!userId) return;
    const oldest = sales.reduce((a, s) => (s.createdAt < a ? s.createdAt : a), new Date().toISOString());
    const { data } = await supabase().from('sales').select('*').eq('user_id', userId).lt('created_at', oldest).order('created_at', { ascending: false }).limit(300);
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
        sb.from('register_settings').select('*').eq('user_id', userId).maybeSingle(),
        sb.from('catalog_items').select('*').eq('user_id', userId).order('sort').order('created_at'),
        sb.from('sales').select('*').eq('user_id', userId).or(`created_at.gte.${since},status.eq.pending`).order('created_at', { ascending: false }).limit(2000),
      ]);
      for (const r of [st, it, sa]) if (r.error) throw r.error;
      if (st.data) setSettings({ businessType: st.data.business_type, vatRate: Number(st.data.vat_rate), payLink: st.data.pay_link ?? '',
        dealerNumber: st.data.dealer_number ?? '', companyNumber: st.data.company_number ?? '', legalName: st.data.legal_name ?? '',
        street: st.data.street ?? '', houseNo: st.data.house_no ?? '', city: st.data.city ?? '', zip: st.data.zip ?? '' });
      setItems((it.data ?? []).map((r: any) => ({ id: r.id, name: r.name, price: Number(r.price), kind: r.kind, active: r.active, sort: r.sort ?? 0,
        favorite: Boolean(r.favorite), favOrder: r.fav_order ?? 0, imageUrl: r.image_url ?? '' })));
      // for the POS: who sells (time-clock employees) and today's appointments
      const dayStart = israelToIso(israelParts(Date.now()).date, '00:00');
      const [emps, appts, svcs] = await Promise.all([
        sb.from('employees').select('id, name').eq('user_id', userId).eq('active', true).order('created_at'),
        sb.from('appointments').select('id, name, phone, lead_id, service_id, service_name, start_at, status').eq('user_id', userId)
          .gte('start_at', dayStart).lt('start_at', new Date(new Date(dayStart).getTime() + 864e5).toISOString()).order('start_at'),
        sb.from('booking_services').select('id, price').eq('user_id', userId),
      ]);
      setEmployees(emps.error ? [] : (emps.data ?? []) as any);
      const price = new Map(((svcs.data ?? []) as any[]).map((x) => [x.id, x.price == null ? null : Number(x.price)]));
      setTodayAppts(appts.error ? [] : ((appts.data ?? []) as any[]).filter((a) => a.status !== 'cancelled' && a.status !== 'no_show')
        .map((a) => ({ id: a.id, name: a.name, phone: a.phone ?? '', leadId: a.lead_id, serviceName: a.service_name ?? '', start: a.start_at, price: price.get(a.service_id) ?? null })));
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
    setPrefill({ customer: { name: q.get('name') ?? '', phone: q.get('phone') ?? '', leadId: q.get('lead'), appointmentId: q.get('appt') },
      line: q.get('item') ? { name: q.get('item')!, price: Number(q.get('price') || 0), qty: 1 } : null });
    window.history.replaceState(null, '', '/register');
  }, []);

  const vat = { type: settings.businessType, rate: settings.vatRate };
  const business = {
    dealerNumber: settings.dealerNumber, companyNumber: settings.companyNumber, name: settings.legalName || brand.name,
    street: settings.street, houseNo: settings.houseNo, city: settings.city, zip: settings.zip,
    ready: /^[0-9]{9}$/.test(settings.dealerNumber) && Boolean(settings.legalName || brand.name),
  };
  async function issueDocumentFull(s: Sale, leadId: string | null): Promise<{ label: string; token: string } | null> {
    if (!business.ready || !userId) return null;
    const d = docFromSale(s, { licensed: settings.businessType === 'licensed', docDate: israelParts(Date.now()).date });
    const row = docInsertRow(userId, d, { saleId: s.id, leadId, vatRate: d.lines[0]?.vatRate ?? 0 });
    let { data, error: e } = await supabase().from('documents').insert(row).select('doc_type, doc_number, share_token').single();
    // before migration 20261003001600 there is no share link — the document is still issued (the failed request inserted nothing)
    if (e && /share_token/.test(e.message)) ({ data, error: e } = await supabase().from('documents').insert(row).select('doc_type, doc_number').single() as any);
    if (e || !data) { setError('המכירה נשמרה, אבל המסמך לא הופק. אפשר לנסות שוב מ"מסמכים".'); return null; }
    return { label: `הופקה ${DOC_LABEL[data.doc_type]} מס׳ ${data.doc_number}`, token: (data as any).share_token ?? '' };
  }
  /** every paid sale gets its legal document (numbered by the database, never editable) */
  async function issueDocument(s: Sale, leadId: string | null): Promise<string> {
    if (!business.ready || !userId) return '';
    const d = docFromSale(s, { licensed: settings.businessType === 'licensed', docDate: israelParts(Date.now()).date });
    const { data, error: e } = await supabase().from('documents').insert(docInsertRow(userId, d, { saleId: s.id, leadId, vatRate: d.lines[0]?.vatRate ?? 0 })).select('doc_type, doc_number').single();
    if (e) { setError('המכירה נשמרה, אבל המסמך לא הופק. אפשר לנסות שוב מ"מסמכים".'); return ''; }
    return ` · הופקה ${DOC_LABEL[data.doc_type]} מס׳ ${data.doc_number}`;
  }
  function crmPurchase(leadId: string, s: { total: number; items: Line[]; method: Method }) {
    addActivity(leadId, 'purchase', `${s.items.map((l) => l.name).join(' + ')} · ${ils(s.total)} · ${methodLabel(s.method)}`);
    const l = leads.find((x) => x.id === leadId);
    updateLead(leadId, { value: (l?.value ?? 0) + s.total, status: 'נסגר' });
  }

  async function checkout(c: CheckoutInput): Promise<CheckoutResult> {
    if (!userId) return { ok: false, error: 'אין חיבור' };
    const tt = computeSale(c.lines, c.discount, vat);
    if (!c.lines.length || tt.total <= 0) return { ok: false, error: 'הסל ריק' };
    let leadId = c.customer.leadId || leads.find((l) => c.customer.phone && phoneDigits(l.phone) === phoneDigits(c.customer.phone))?.id || null;
    if (!leadId && c.customer.name.trim()) leadId = addLead({ name: c.customer.name.trim(), phone: c.customer.phone.trim(), source: 'קופה', date: israelParts(Date.now()).date, status: c.paidNow ? 'נסגר' : 'מעוניין', value: 0 });
    const now = new Date().toISOString();
    const { data, error: e } = await supabase().from('sales').insert({
      user_id: userId, lead_id: leadId, appointment_id: c.customer.appointmentId, customer_name: c.customer.name.trim(), customer_phone: c.customer.phone.trim(),
      items: c.lines.filter((l) => l.qty > 0), subtotal: tt.subtotal, discount: tt.discount, total: tt.total, vat_rate: tt.vatRate, vat_amount: tt.vatAmount,
      method: c.paidNow ? c.method : 'link', payments: c.method === 'split' ? c.payments : [], status: c.paidNow ? 'paid' : 'pending', note: c.note, paid_at: c.paidNow ? now : null,
      employee_id: c.employee?.id ?? null, employee_name: c.employee?.name ?? '',
      ...(c.cashReceived != null ? { cash_received: c.cashReceived, change_given: Math.round((c.cashReceived - tt.total) * 100) / 100 } : {}),
    }).select('*').single();
    if (e) return { ok: false, error: errText(e) };
    const sale = toSale(data);
    setSales((all) => [sale, ...all]);
    if (leadId && c.paidNow) crmPurchase(leadId, sale);
    if (!c.paidNow) { if (leadId) addActivity(leadId, 'note', `נשלחה בקשת תשלום: ${ils(sale.total)}`); requestPayment(sale); }
    const doc = c.paidNow ? await issueDocumentFull(sale, leadId) : null;
    void notifySale(sale.id); // the owner's phones — never blocks the sale
    return { ok: true, sale, docLabel: doc?.label, docUrl: doc?.token ? `${window.location.origin}/d/${doc.token}` : undefined };
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
        {([['sell', 'מכירה'], ['sales', 'מכירות ודוחות'], ['docs', 'מסמכים'], ['catalog', 'מחירון'], ['settings', 'הגדרות']] as const).map(([k, l]) => <Chip key={k} on={tab === k} onClick={() => setTab(k)}>{l}{k === 'sales' && pending.length ? ` (${pending.length})` : ''}</Chip>)}
      </div>
      {error && <p className="mb-4 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}
      {flash && <p className="mb-4 rounded-2xl bg-emerald-500/15 p-3 text-sm font-semibold text-emerald-700 dark:text-emerald-300">✓ {flash}</p>}
      {loading && <div className="py-8 text-center"><Spinner /></div>}

      {!loading && tab === 'sell' && (
        <PosView key={prefill ? 'prefill' : 'pos'} items={items} sales={sales} leads={leads} employees={employees} todayAppts={todayAppts}
          vat={vat} payLinkReady={Boolean(settings.payLink)} onCheckout={checkout} onShowDoc={() => setTab('docs')} prefill={prefill} onGoCatalog={() => setTab('catalog')} />
      )}

      {!loading && tab === 'sales' && <SalesTab sales={sales} onPaid={markPaid} onCancel={cancelSale} onRemind={requestPayment} canRemind={Boolean(settings.payLink)}
        onOpen={setOpenSale} onLoadOlder={olderDone ? undefined : loadOlder} />}
      <SaleDetail sale={openSale} onClose={() => setOpenSale(null)} business={business} />

      {!loading && tab === 'docs' && <DocumentsTab userId={userId} business={business} licensed={settings.businessType === 'licensed'} onError={setError} />}

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
              dealer_number: settings.dealerNumber, company_number: settings.companyNumber, legal_name: settings.legalName, street: settings.street, house_no: settings.houseNo, city: settings.city, zip: settings.zip });
            if (e) setError(errText(e)); else { setError(null); say('ההגדרות נשמרו'); }
          }}>שמירה</Button>
          <PushSettings userId={userId} />
          <p className="mt-4 rounded-2xl bg-surface-2 p-3 text-xs text-ink-2">
            כשפרטי העסק מלאים, כל מכירה ששולמה מפיקה אוטומטית <strong>{settings.businessType === 'licensed' ? 'חשבונית מס / קבלה' : 'קבלה'}</strong> במספור רץ. מסמך שהופק לא ניתן לשינוי — תיקון נעשה בחשבונית זיכוי.
            {' '}עד לרישום התוכנה ברשות המסים ולבדיקת יועץ מס, השתמשו במסמכים לבדיקה בלבד.
          </p>
        </Card>
      )}
    </>
  );
}

function SalesTab({ sales, onPaid, onCancel, onRemind, canRemind, onOpen, onLoadOlder }: { sales: Sale[]; onPaid: (s: Sale, m: Method) => void; onCancel: (s: Sale) => void; onRemind: (s: Sale) => void; canRemind: boolean;
  onOpen: (s: Sale) => void; onLoadOlder?: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const today = israelParts(Date.now()).date;
  const thisMonth = today.slice(0, 7);
  const prev = israelParts(new Date(`${thisMonth}-01T12:00:00Z`).getTime() - 864e5).date.slice(0, 7);
  const [period, setPeriod] = useState<'today' | 'month' | 'prev'>('today');
  const range = period === 'today' ? [today, today] : period === 'month' ? [`${thisMonth}-01`, `${thisMonth}-31`] : [`${prev}-01`, `${prev}-31`];
  const sum = useMemo(() => summarize(sales, range[0], range[1]), [sales, range[0], range[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  // searching looks through every loaded transaction (all periods): customer, phone, item, amount, note, seller
  const qq = q.trim();
  const hit = (s: Sale) => [s.customerName, s.customerPhone, s.note, s.employeeName, ...s.items.map((l) => l.name)].some((v) => (v ?? '').includes(qq))
    || (qq.replace(/\D/g, '').length >= 3 && s.customerPhone.replace(/\D/g, '').includes(qq.replace(/\D/g, ''))) || (Number(qq) > 0 && Math.abs(s.total - Number(qq)) < 0.005);
  const list = qq ? sales.filter(hit).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : sales.filter((s) => saleDay(s) >= range[0] && saleDay(s) <= range[1]);
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
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש עסקה: לקוח, טלפון, פריט, סכום…" className="mb-3 h-11" aria-label="חיפוש עסקה" />
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
            <button type="button" onClick={() => onOpen(s)} className="min-w-0 flex-1 text-start" aria-label={`פרטי עסקה: ${s.customerName || 'ללא שם'} ${ils(s.total)}`}>
              <strong className="block truncate">{s.customerName || 'ללא שם'} · {s.items.map((l) => l.name).join(' + ')}</strong>
              <span className="text-xs text-muted">{formatIL(s.paidAt ?? s.createdAt, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric' })} · {methodLabel(s.method)} · {s.status === 'paid' ? 'שולם' : s.status === 'pending' ? 'ממתין' : 'בוטל'}</span>
            </button>
            <strong className="tabular-nums">{ils(s.total)}</strong>
            {s.status === 'paid' && <button type="button" className="text-xs text-muted" onClick={() => onCancel(s)} aria-label="ביטול">✕</button>}
          </div>
        ))}
        {!list.length && <p className="py-6 text-center text-sm text-muted">{qq ? 'לא נמצאו עסקאות.' : 'אין מכירות בתקופה הזו.'}</p>}
      </div>
      {onLoadOlder && <Button variant="ghost" className="mt-3 w-full" onClick={() => void onLoadOlder()}>טעינת עסקאות קודמות</Button>}
    </>
  );
}

function CatalogTab({ userId, items, reload, onError }: { userId: string; items: Item[]; reload: () => void; onError: (e: unknown) => void }) {
  const [d, setD] = useState({ name: '', price: '', kind: 'service' as Item['kind'] });
  const favs = items.filter((i) => i.favorite).sort((a, b) => a.favOrder - b.favOrder);
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
    const { data, error } = await supabase().from('booking_services').select('name, price').eq('user_id', userId).eq('active', true);
    if (error) return onError(error);
    const fresh = (data ?? []).filter((s: any) => s.price != null && !items.some((i) => i.name === s.name));
    if (!fresh.length) return;
    await run(supabase().from('catalog_items').insert(fresh.map((s: any, k: number) => ({ user_id: userId, name: s.name, price: Number(s.price), kind: 'service', sort: items.length + k }))));
  }
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted">⭐ = מועדף בקופה (מומלץ 8–16 פריטים). החצים קובעים את הסדר.</p>
      {[...favs, ...items.filter((i) => !i.favorite)].map((i) => (
        <Card key={i.id} className="flex min-w-0 flex-wrap items-center gap-2 p-3">
          <button type="button" aria-pressed={i.favorite} aria-label={i.favorite ? `הסרה מהמועדפים: ${i.name}` : `הוספה למועדפים: ${i.name}`} className="text-xl"
            onClick={() => run(supabase().from('catalog_items').update({ favorite: !i.favorite, fav_order: i.favorite ? 0 : favs.length }).eq('id', i.id))}>{i.favorite ? '⭐' : '☆'}</button>
          <span className="min-w-0 flex-1"><strong className={cx('block truncate', !i.active && 'text-muted line-through')}>{i.name}</strong><span className="text-xs text-muted">{ils(i.price)} · {KIND_HE[i.kind]}</span></span>
          <Select value={i.kind} onChange={(e) => run(supabase().from('catalog_items').update({ kind: e.target.value }).eq('id', i.id))} className="h-9 w-32 py-1 text-sm" aria-label={`קטגוריה: ${i.name}`}>
            {Object.entries(KIND_HE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          {i.favorite && <span className="flex">
            <button type="button" className="h-9 w-8 rounded-full border border-line" aria-label={`למעלה: ${i.name}`} onClick={() => moveFav(i.id, -1)}>↑</button>
            <button type="button" className="h-9 w-8 rounded-full border border-line" aria-label={`למטה: ${i.name}`} onClick={() => moveFav(i.id, 1)}>↓</button>
          </span>}
          <Button size="sm" variant="ghost" onClick={() => run(supabase().from('catalog_items').update({ active: !i.active }).eq('id', i.id))}>{i.active ? 'הסתרה' : 'הצגה'}</Button>
          <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`למחוק את "${i.name}"? מכירות קודמות לא ישתנו.`)) void run(supabase().from('catalog_items').delete().eq('id', i.id)); }}>מחיקה</Button>
        </Card>
      ))}
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
      <p className="mb-2 text-xs text-muted">בכל מכירה תגיע התראה למכשירים שהופעלו כאן — סכום, לקוח, אמצעי תשלום ומוכר/ת.</p>
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

/** one transaction: what was sold, how it was paid, who sold it — and its document (copy / WhatsApp) */
function SaleDetail({ sale, onClose, business }: { sale: Sale | null; onClose: () => void; business: { dealerNumber: string; name: string; ready: boolean } & Record<string, any> }) {
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [phone, setPhone] = useState('');
  useEffect(() => {
    if (!sale) return;
    setDocs(null); setPhone(sale.customerPhone);
    void supabase().from('documents').select('*').eq('sale_id', sale.id).order('issued_at').then(({ data }) => setDocs((data ?? []).map(toDoc)));
  }, [sale]);
  if (!sale) return null;
  const pays = sale.method === 'split' ? sale.payments ?? [] : [{ method: sale.method, amount: sale.total }];
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
      {sale.note && <p className="mb-3 text-sm text-ink-2">הערה: {sale.note}</p>}
      <p className="mb-2 font-semibold">מסמכים</p>
      {docs === null ? <Spinner /> : !docs.length ? <p className="text-sm text-muted">לא הופק מסמך לעסקה הזו.</p> : docs.map((d) => (
        <div key={d.id} className="mb-2 rounded-2xl bg-surface-2 p-3 text-sm">
          <p className="font-semibold">{DOC_LABEL[d.docType]} מס׳ {d.docNumber} · {ils(d.total)}{d.printCount ? ` · הודפס ${d.printCount}` : ''}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={async () => { const f = await printDocRow(d, business as any); if (f) setDocs((all) => (all ?? []).map((x) => (x.id === f.id ? f : x))); }}>
              {d.printCount ? 'הדפסת העתק' : 'הדפסת מקור'}
            </Button>
            {d.shareToken && <>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="טלפון" inputMode="tel" dir="ltr" className="h-9 w-36 py-1" aria-label="טלפון לשליחה" />
              <Button size="sm" variant="primary" disabled={phoneDigits(phone).length < 9} onClick={() => {
                const url = waLink(phone, `שלום, ${DOC_LABEL[d.docType]} מס׳ ${d.docNumber} מ${business.name}: ${window.location.origin}/d/${d.shareToken}`);
                if (url) window.open(url, '_blank', 'noopener');
              }}>💬 שליחה בוואטסאפ</Button>
            </>}
          </div>
        </div>
      ))}
    </Modal>
  );
}
