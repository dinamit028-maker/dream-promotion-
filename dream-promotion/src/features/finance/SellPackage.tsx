'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Button, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { DOC_LABEL } from '@/features/documents/documents';
import type { Lead } from '@/types';
import { accessState, documentRow, issueDocumentRow } from './api';
import { composeDocument, computeLines, type ComposeCustomer } from './compose';
import { toSettings } from './FinanceScreen';
import { chargesVat, type EntityType } from './rules';
import { TERMS, dueDateFor } from './receivables';
import type { PaymentEntry } from './payments';
import { Note, PaymentsEditor, ils, todayIL } from './ui';
import {
  ddmmyyyy, packageDocLine, packageDocType, packageKey, priceOf, saleProblems, sessionsLabel, termsText, validUntilOf,
  type CatalogPackage, type ClientPackage,
} from './packages';
import { insertPackage, loadCatalogPackages, loadPackage, loadTreatmentTypes, packagesChanged, type TreatmentType } from './packages-data';
import { financeHref } from './routes';

/**
 * "מכירת חבילה" (docs/FINANCE ADDITIONS HE.md, T1) — from the client card or the packages screen. The package's terms are
 * copied from the catalog at the sale; its document comes from the existing engine only: composeDocument → issueDocumentRow,
 * with the key "package:<id>" (the database links it to the package in the same transaction — a retry is the same document).
 *   paid now   a tax invoice-receipt (320) — an exempt dealer: a receipt (400) — with how it was paid
 *   later      a tax invoice (305) — an exempt dealer: a transaction invoice (300) — paid by receipts, in one or more payments
 *              ("קבלה על תשלום" of the document, as every invoice)
 * The package is saved first: a document that is refused (closed books, a lost connection) leaves the sale recorded, and
 * "הפקת המסמך" issues it later with the same key. A package without a price has no document.
 * Recording a payment is not charging one: nothing here charges a card or sends a payment link.
 */
export interface FinanceBasics { userId: string; entity: EntityType; vatRate: number; vat: boolean; ready: boolean; paymentTerms: string }

/** the money settings the dialog needs, when it opens outside the finance screens (the client card) */
async function loadBasics(userId: string, brandName: string): Promise<{ ok: true; basics: FinanceBasics } | { ok: false; error: string }> {
  const a = await accessState();
  if (!a.ok) return { ok: false, error: a.error };
  if (!a.state.open || a.state.access === 'register') return { ok: false, error: 'אין לך גישה לנתונים הכספיים של העסק הזה.' };
  const sb = supabase();
  const [st, fp] = await Promise.all([
    sb.from('register_settings').select('*').maybeSingle(),
    sb.from('business_finance_profile').select('payment_terms').maybeSingle(),
  ]);
  const s = toSettings(st.data);
  return { ok: true, basics: { userId, entity: s.entity, vatRate: s.vatRate, vat: chargesVat(s.entity),
    ready: /^[0-9]{9}$/.test(s.dealerNumber) && Boolean(s.legalName || brandName), paymentTerms: (fp.data as any)?.payment_terms ?? 'immediate' } };
}
const customerOf = (l: Lead): ComposeCustomer => ({ name: l.billingName || l.name, phone: l.phone ?? '', email: l.email ?? '', dealer: l.billingDealer ?? '',
  street: l.billingStreet ?? '', city: l.billingCity ?? '' });

export function SellPackageDialog({ leadId, existing, basics: given, onClose, onDone }: {
  leadId?: string | null; existing?: ClientPackage | null; basics?: FinanceBasics; onClose: () => void; onDone: (p: ClientPackage) => void;
}) {
  const { userId, leads, brand, addActivity, updateLead } = useApp();
  const today = todayIL();
  const [basics, setBasics] = useState<FinanceBasics | null>(given ?? null);
  const [catalog, setCatalog] = useState<CatalogPackage[] | null>(null);
  const [types, setTypes] = useState<TreatmentType[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // the sale's id is fixed when the dialog opens: a second tap, a retry after a lost answer — the same package and document
  const [id] = useState(() => existing?.id ?? crypto.randomUUID());
  const [lead, setLead] = useState<string | null>(existing?.leadId ?? leadId ?? null);
  const [q, setQ] = useState('');
  const [pkgId, setPkgId] = useState<string | null>(existing?.itemId ?? null);
  const [priceText, setPriceText] = useState(existing ? String(existing.price) : '');
  const [validUntil, setValidUntil] = useState(existing?.validUntil ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [payNow, setPayNow] = useState(true);
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [paymentsTouched, setPaymentsTouched] = useState(false);
  const [terms, setTerms] = useState('immediate');
  const [dueDate, setDueDate] = useState(today);
  const [saved, setSaved] = useState<ClientPackage | null>(existing ?? null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!given) {
        if (!userId) { setLoadError('צריך להתחבר מחדש.'); return; }
        const b = await loadBasics(userId, brand.name);
        if (!alive) return;
        if (!b.ok) { setLoadError(b.error); return; }
        setBasics(b.basics);
      }
      const [c, t] = await Promise.all([existing ? Promise.resolve(null) : loadCatalogPackages(), loadTreatmentTypes()]);
      if (!alive) return;
      setTypes(t);
      if (c && !c.ok) { setLoadError(c.error); return; }
      setCatalog(c ? c.data.filter((p) => p.active && p.sessions) : []);
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (basics && !existing) { setTerms(basics.paymentTerms); setDueDate(dueDateFor(today, basics.paymentTerms)); } }, [basics]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDueDate(dueDateFor(today, terms)); }, [terms]); // eslint-disable-line react-hooks/exhaustive-deps

  const customer = lead ? leads.find((l) => l.id === lead) ?? null : null;
  const pkg: (Pick<CatalogPackage, 'name' | 'sessions' | 'typeId' | 'validMonths'> & { id: string | null }) | null = existing
    ? { id: existing.itemId, name: existing.name, sessions: existing.sessionsTotal, typeId: existing.typeId, validMonths: null }
    : catalog?.find((p) => p.id === pkgId) ?? null;
  const typeName = (tid: string | null) => types.find((t) => t.id === tid)?.name ?? null;
  const price = priceOf(priceText);
  const docType = basics ? packageDocType(basics.vat, payNow) : 320;
  const rate = basics?.vat ? basics.vatRate : 0;
  const preview = useMemo(() => computeLines([{ name: 'x', qty: 1, unitPrice: price }], { pricesIncludeVat: true, rate }), [price, rate]);
  // "paid now" starts with one payment of the whole price — until the user changes the payments
  useEffect(() => { if (!paymentsTouched) setPayments(price > 0 ? [{ method: 'cash', amount: price, date: today }] : []); }, [price, paymentsTouched]); // eslint-disable-line react-hooks/exhaustive-deps

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const digits = s.replace(/\D/g, '');
    return leads.filter((l) => l.name.toLowerCase().includes(s) || (digits.length >= 3 && (l.phone ?? '').replace(/\D/g, '').includes(digits))).slice(0, 6);
  }, [q, leads]);
  function choose(p: CatalogPackage) {
    setPkgId(p.id); setPriceText(String(p.price));
    setValidUntil(validUntilOf(today, p.validMonths) ?? '');
  }

  async function sell() {
    if (!basics || !userId) return;
    const problems = saleProblems({ leadId: lead, pkg, price: priceText, validUntil, today });
    if (problems.length) { setErrors(problems); return; }
    if (!customer) { setErrors(['הלקוח/ה לא נמצא/ה ברשימת אנשי הקשר — רעננו ונסו שוב.']); return; }
    const sessions = pkg!.sessions!;
    // the document on paper first: composed and checked before anything is saved (the database checks it all again)
    let composed: ReturnType<typeof composeDocument> | null = null;
    if (price > 0) {
      if (!basics.ready) { setErrors(['חסרים פרטי העסק למסמכים (מספר עוסק) — ממלאים בהגדרות הכספים.']); return; }
      composed = composeDocument({ docType, entity: basics.entity, vatRate: basics.vatRate, pricesIncludeVat: true,
        lines: [packageDocLine(pkg!.name, sessions, price, pkg!.id)], customer: customerOf(customer), payments: payNow ? payments : [],
        docDate: today, dueDate: payNow ? null : dueDate, notes: '', today });
      if (!composed.ok) { setErrors(composed.errors); return; }
    }
    const what = `"${pkg!.name}" (${sessionsLabel(sessions)}) ל${customer.name} ב-${ils(price)}`;
    // asked once per dialog: a retry after a refused document does not ask again
    if (!confirmed) {
      const ask = saved
        ? `להפיק ${DOC_LABEL[docType]} על ${ils(price)} לחבילה ${what}? מסמך שהופק לא ניתן לשינוי או למחיקה.`
        : composed && composed.ok ? `למכור את ${what}? תופק ${DOC_LABEL[docType]} — מסמך שהופק לא ניתן לשינוי או למחיקה.`
        : `למכור את ${what}? חבילה ללא תשלום — בלי מסמך.`;
      if (!window.confirm(ask)) return;
      setConfirmed(true);
    }
    setBusy(true); setErrors([]);
    try {
      // 1. the package, with the terms of today's catalog (a retry of this dialog is the same package)
      let pk = saved;
      if (!pk) {
        const r = await insertPackage({ id, userId, leadId: customer.id, itemId: pkg!.id, name: pkg!.name, typeId: pkg!.typeId,
          sessions, price, validUntil: validUntil || null, notes });
        if (!r.ok) { setErrors([r.error]); return; }
        pk = r.data; setSaved(pk);
        if (!composed) addActivity(customer.id, 'purchase', `נמכרה חבילה: ${pkg!.name} (${sessionsLabel(sessions)}) · ללא תשלום`);
      }
      // 2. its document — the existing engine, the package's key; the database links it to the package as it is issued
      if (composed && composed.ok && !pk.documentId) {
        const out = await issueDocumentRow(documentRow(composed.doc, { userId, idempotencyKey: packageKey(id), vatRate: composed.totals.vatRate, leadId: customer.id }));
        if (!out.ok) {
          setErrors([`החבילה נשמרה, אבל ה${DOC_LABEL[docType]} לא הופקה: ${out.error}`, 'אפשר לנסות שוב מכאן — או אחר כך, מהחבילה ("הפקת המסמך").']);
          packagesChanged(customer.id);
          return;
        }
        if (!out.again) {
          addActivity(customer.id, 'purchase', `נמכרה חבילה: ${pkg!.name} (${sessionsLabel(sessions)}) · ${DOC_LABEL[out.doc.docType]} מס׳ ${out.doc.docNumber} · ${ils(out.doc.total)}`);
          // the customer's value, as the document composer adds it (a transaction invoice counts when its receipt comes)
          if (out.doc.docType !== 300) {
            const l = useApp.getState().leads.find((x) => x.id === customer.id);
            if (l) updateLead(l.id, { value: Math.round(((l.value ?? 0) + out.doc.total) * 100) / 100 });
          }
        }
      }
      packagesChanged(customer.id);
      const fresh = await loadPackage(id);
      onDone(fresh.ok && fresh.data ? fresh.data : pk);
    } finally { setBusy(false); }
  }

  const title = existing ? `הפקת המסמך · ${existing.name}` : 'מכירת חבילה';
  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-display text-xl font-extrabold">{title}</h3>
          <p className="text-xs text-muted">רישום מכירה והפקת מסמך — לא סליקה. שום כרטיס לא מחויב כאן.</p>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      {loadError ? <Note tone="warn">{loadError}</Note> : !basics || catalog === null ? <div className="py-8 text-center"><Spinner /></div> : <div className="grid gap-3">
        {/* the customer */}
        <div>
          <p className="mb-1 text-sm font-bold">לקוח/ה</p>
          {customer ? (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <strong>{customer.name}</strong>{customer.phone ? <span className="text-muted">{customer.phone}</span> : null}
              {!existing && !saved && <button type="button" className="text-xs font-semibold text-primary" onClick={() => setLead(null)}>החלפה</button>}
            </p>
          ) : (
            <div className="relative">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש באנשי הקשר (שם או טלפון)" aria-label="חיפוש לקוח/ה" />
              {hits.length > 0 && (
                <div className="absolute inset-x-0 top-full z-10 mt-1 grid rounded-2xl border border-line bg-surface p-1 shadow-lg">
                  {hits.map((l) => <button key={l.id} type="button" onClick={() => { setLead(l.id); setQ(''); }} className="min-h-11 rounded-xl px-3 text-start text-sm hover:bg-surface-2">{l.name}{l.phone ? ` · ${l.phone}` : ''}</button>)}
                </div>
              )}
              <p className="mt-1 text-xs text-muted">חבילה נמכרת ללקוח/ה מאנשי הקשר — כך היא מופיעה בכרטיס, והטיפולים נוכים ממנה.</p>
            </div>
          )}
        </div>

        {/* the package */}
        {existing ? (
          <Note>{existing.name} · {sessionsLabel(existing.sessionsTotal)} · {ils(existing.price)}{existing.validUntil ? ` · בתוקף עד ${ddmmyyyy(existing.validUntil)}` : ''}</Note>
        ) : (
          <div>
            <p className="mb-1 text-sm font-bold">חבילה</p>
            {!catalog.length ? (
              <Note>אין עדיין חבילות בקטלוג. חבילה היא פריט מסוג &quot;חבילה&quot; עם מספר טיפולים — יוצרים אותה במסך <Link href={financeHref('packages')} className="font-semibold text-primary">חבילות</Link> (כספים).</Note>
            ) : (
              <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="בחירת חבילה">
                {catalog.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={pkgId === p.id} disabled={Boolean(saved)} onClick={() => choose(p)}
                    className={`min-h-11 rounded-2xl border p-2.5 text-start text-sm ${pkgId === p.id ? 'border-primary bg-primary-soft' : 'border-line hover:border-primary'}`}>
                    <strong className="block">{p.name} · {ils(p.price)}</strong>
                    <span className="text-xs text-muted">{termsText(p, typeName(p.typeId))}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {pkg && <>
          {!existing && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="המחיר בפועל ₪ (כולל מע״מ)"><Input inputMode="decimal" value={priceText} disabled={Boolean(saved)} onChange={(e) => setPriceText(e.target.value)} /></Field>
              <Field label="בתוקף עד (ריק = בלי הגבלה)"><Input type="date" value={validUntil} min={today} disabled={Boolean(saved)} onChange={(e) => setValidUntil(e.target.value)} /></Field>
            </div>
          )}
          {price > 0 && <>
            <div>
              <p className="mb-1 text-sm font-bold">תשלום</p>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="מתי משלמים">
                <Chip on={payNow} onClick={() => setPayNow(true)} role="radio" aria-checked={payNow}>שולם עכשיו</Chip>
                <Chip on={!payNow} onClick={() => setPayNow(false)} role="radio" aria-checked={!payNow}>חשבונית — תשלום אחר כך / בתשלומים</Chip>
              </div>
              <p className="mt-1 text-xs text-muted">{payNow
                ? `תופק ${DOC_LABEL[docType]} עם התשלומים שהתקבלו.`
                : `תופק ${DOC_LABEL[docType]}. כל תשלום שמגיע — "קבלה על תשלום" מהמסמך (אפשר בכמה תשלומים); היתרה מופיעה בחייבים.`}</p>
            </div>
            {payNow ? (
              <PaymentsEditor payments={payments} onChange={(p) => { setPaymentsTouched(true); setPayments(p); }} total={price} today={today} />
            ) : (
              <Field label="תנאי תשלום">
                <div className="flex flex-wrap items-center gap-1.5">
                  <select value={terms} onChange={(e) => setTerms(e.target.value)} className="h-11 rounded-md border-[1.5px] border-line bg-surface px-3 text-sm" aria-label="תנאי תשלום">
                    {TERMS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                  <Input type="date" value={dueDate} min={today} onChange={(e) => setDueDate(e.target.value)} className="w-40" aria-label="לתשלום עד" />
                </div>
              </Field>
            )}
          </>}
          {!existing && <Field label="הערות על החבילה (לא חובה)"><Textarea value={notes} disabled={Boolean(saved)} onChange={(e) => setNotes(e.target.value)} maxLength={500} className="min-h-16" /></Field>}
          <div className="rounded-2xl bg-surface-2 p-3 text-sm">
            {price > 0 ? <>
              <p><strong>יופק: {DOC_LABEL[docType]}</strong> · {ils(preview.totals.total)}{rate ? ` (מתוכו מע״מ ${ils(preview.totals.vatAmount)})` : ''}</p>
              <p className="text-xs text-muted">שורה אחת: {pkg.name} — {sessionsLabel(pkg.sessions ?? 0)}. ההכנסה נרשמת פעם אחת, במסמך הזה.</p>
            </> : <p>חבילה ללא תשלום — בלי מסמך.</p>}
          </div>
        </>}
        {!basics.ready && price > 0 && <Note tone="warn">חסרים פרטי העסק למסמכים (מספר עוסק) — ממלאים בהגדרות הכספים, ואז מוכרים.</Note>}
        {errors.length > 0 && <Note tone="warn">{errors.map((e) => <span key={e} className="block">{e}</span>)}</Note>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || !pkg || !customer} onClick={() => void sell()}>
            {busy ? 'רגע…' : saved ? `הפקת ה${DOC_LABEL[docType]}` : price > 0 ? 'מכירה והפקת המסמך' : 'מכירה'}
          </Button>
          <Button variant="ghost" onClick={onClose}>{saved ? 'סגירה' : 'ביטול'}</Button>
        </div>
      </div>}
    </Modal>
  );
}
