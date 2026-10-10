'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { Button, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { DOC_LABEL, type DocRow } from '@/features/documents/documents';
import { useFinance } from './FinanceScreen';
import { DocView, loadDoc } from './DocView';
import { financeHref } from './routes';
import {
  EVERY, MODE_HE, STATUS_HE, chargeLine, firstCharge, newPlanInput, periodLabel, planError, planInputOf, planLine, planTotal, scheduleLabel, upcoming,
  type PlanInput, type PlanStatus, type RecurringCharge, type RecurringPlan,
} from './recurring';
import {
  RECURRING_MIGRATION, loadChargeRefs, loadRecurringCharges, loadRecurringPlans, recurringReady, retryRecurringCharge, saveRecurringPlan, setRecurringPlan,
  type ChargeRefs,
} from './recurring-data';
import { LinesEditor, LoadFailed, Note, Pill, Stat, ddmmyyyy, ils, todayIL } from './ui';

/**
 * "חיובים חוזרים" (docs/FINANCE_ADDITIONS_HE.md T4; 2.90, migration 20261010004500): a retainer, a monthly subscription, a standing
 * order. Each period the dashboard's timer issues the plan's invoice (or a draft for the owner) through the existing documents —
 * once per plan and period — and, when asked, a payment link with it (T2). No card and no bank account is ever charged.
 * New: here or from the client card (?new=1&lead=…); a plan opens from the card's link (?open=<id>).
 */
type Filter = PlanStatus | 'all';
const FILTERS: { id: Filter; label: string }[] = [{ id: 'active', label: 'פעילים' }, { id: 'paused', label: 'מושהים' }, { id: 'ended', label: 'הסתיימו' }, { id: 'all', label: 'הכל' }];
const TONE: Record<PlanStatus, 'ok' | 'warn' | 'default'> = { active: 'ok', paused: 'warn', ended: 'default' };
const EMPTY_REFS: ChargeRefs = { docs: new Map(), drafts: new Map(), links: new Map() };
const LINK_HE: Record<string, string> = { sent: 'לינק נשלח', paid: 'שולם בלינק', failed: 'התשלום בלינק נכשל', expired: 'הלינק פג', cancelled: 'הלינק בוטל' };

export function Recurring() {
  const { params, clearParams, say } = useFinance();
  const { leads } = useApp();
  const [ready, setReady] = useState<boolean | null>(null);
  const [plans, setPlans] = useState<RecurringPlan[] | null>(null);
  const [charges, setCharges] = useState<RecurringCharge[]>([]);
  const [refs, setRefs] = useState<ChargeRefs>(EMPTY_REFS);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('active');
  const [editor, setEditor] = useState<{ plan: RecurringPlan | null; leadId: string | null } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    if (!(await recurringReady())) { setReady(false); return; }
    setReady(true);
    const [p, c] = await Promise.all([loadRecurringPlans(), loadRecurringCharges({ limit: 300 })]);
    if (!p.ok || !c.ok) { setError(!p.ok ? p.error : !c.ok ? c.error : null); setPlans([]); return; }
    setError(null); setPlans(p.data); setCharges(c.data);
    setRefs(await loadChargeRefs(c.data));
  }, []);
  useEffect(() => { void load(); }, [load, attempt]);

  // ?new=1&lead=… (the client card) · ?open=<id> (the card's link)
  useEffect(() => {
    if (params.get('new')) { setEditor({ plan: null, leadId: params.get('lead') }); clearParams(); return; }
    const id = params.get('open');
    if (id && plans) { if (plans.some((p) => p.id === id)) setOpenId(id); clearParams(); }
  }, [params, plans]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = useCallback((leadId: string) => leads.find((l) => l.id === leadId)?.name ?? 'לקוח/ה', [leads]);
  const planOf = useMemo(() => new Map((plans ?? []).map((p) => [p.id, p])), [plans]);
  const active = (plans ?? []).filter((p) => p.status === 'active');
  const monthly = active.reduce((a, p) => a + Math.round((p.amount * 100) / p.every), 0) / 100;
  const blocked = charges.filter((c) => c.status === 'blocked');
  const drafts = charges.filter((c) => c.status === 'draft' && c.draftId && refs.drafts.get(c.draftId)?.open !== false);
  const shown = (plans ?? []).filter((p) => filter === 'all' || p.status === filter);

  async function retry(c: RecurringCharge) {
    const r = await retryRecurringCharge(c.id);
    if (!r.ok) { say(r.error); return; }
    say(r.data ? 'החיוב יופק בדקות הקרובות' : 'החיוב כבר לא מחכה');
    void load();
  }

  if (ready === false) return <Note tone="warn">{RECURRING_MIGRATION}</Note>;
  if (plans === null) return <div className="py-8 text-center"><Spinner /></div>;
  if (error) return <LoadFailed message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  const open = openId ? planOf.get(openId) ?? null : null;
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="חיובים חוזרים פעילים" value={active.length} onClick={() => setFilter('active')} />
        <Stat label="בחודש, בערך" value={ils(monthly)} hint="הסכום לתקופה ÷ מספר החודשים" />
        <Stat label="טיוטות לאישור" value={drafts.length} tone={drafts.length ? 'warn' : undefined} />
        <Stat label="לא הופקו" value={blocked.length} tone={blocked.length ? 'bad' : undefined} />
      </div>
      <p className="text-xs text-muted">שום כרטיס אשראי ושום חשבון בנק לא מחויבים כאן. בכל תקופה מופקת חשבונית (או טיוטה לאישור שלכם), ואם ביקשתם — נשלח איתה לינק לתשלום. החיוב נעשה ביום שלו בין 08:00 ל-20:00 (חיוב של שבת — ביום ראשון).</p>

      {blocked.length > 0 && (
        <section aria-labelledby="rc-blocked" className="grid gap-1.5 rounded-2xl border border-red-500/30 p-3">
          <h3 id="rc-blocked" className="text-sm font-bold">לא הופקו — צריך לבדוק</h3>
          {blocked.map((c) => { const p = planOf.get(c.planId); return (
            <div key={c.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 flex-1">
                <strong>{p ? `${nameOf(p.leadId)} · ${p.name}` : 'חיוב חוזר'}</strong> · {p ? periodLabel(c.periodDate, p.every) : ddmmyyyy(c.periodDate)}
                <span className="block text-xs text-red-700 dark:text-red-300">{c.error}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void retry(c)}>נסו שוב</Button>
            </div>
          ); })}
        </section>
      )}
      {drafts.length > 0 && (
        <Note tone="warn">{drafts.length === 1 ? 'טיוטה אחת של חיוב חוזר מחכה לאישור' : `${drafts.length} טיוטות של חיובים חוזרים מחכות לאישור`} — <Link href={financeHref('documents')} className="font-semibold underline">פתיחה במסמכים</Link> (בודקים ומפיקים).</Note>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setEditor({ plan: null, leadId: null })}>+ חיוב חוזר</Button>
      </div>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0" role="group" aria-label="סינון חיובים חוזרים">
        {FILTERS.map((f) => <Chip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)} className="shrink-0">{f.label}</Chip>)}
      </div>
      {!shown.length ? (
        <Note>{plans.length ? 'אין חיובים חוזרים במצב הזה.' : 'עוד אין חיובים חוזרים. ריטיינר, מנוי חודשי או הוראת קבע — מוסיפים כאן או מכרטיס הלקוח ("💰 כספים").'}</Note>
      ) : (
        <div className="grid gap-1.5">
          {shown.map((p) => (
            <button key={p.id} type="button" onClick={() => setOpenId(p.id)} className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-start text-sm hover:border-primary">
              <span className="min-w-0 flex-1">
                <strong className="block truncate">{nameOf(p.leadId)} · {p.name}</strong>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  {scheduleLabel(p.every, p.day, p.nextDate)} · {planLine(p)}
                  {p.status !== 'active' && <Pill tone={TONE[p.status]}>{STATUS_HE[p.status]}</Pill>}
                  {p.mode === 'draft' && <Pill>{MODE_HE.draft}</Pill>}
                  {!p.sendLink && <Pill>בלי לינק</Pill>}
                </span>
              </span>
              <strong className="shrink-0 tabular-nums">{ils(p.amount)}</strong>
            </button>
          ))}
        </div>
      )}

      {open && <PlanView plan={open} customer={nameOf(open.leadId)} charges={charges.filter((c) => c.planId === open.id)} refs={refs}
        onClose={() => setOpenId(null)} onEdit={() => setEditor({ plan: open, leadId: open.leadId })} onRetry={(c) => void retry(c)} onChanged={() => void load()} />}
      {editor && <PlanEditor plan={editor.plan} leadId={editor.leadId} charged={editor.plan ? charges.some((c) => c.planId === editor.plan!.id) : false}
        onClose={() => setEditor(null)} onSaved={(id, msg) => { setEditor(null); say(msg); void load(); setOpenId(id); }} />}
    </div>
  );
}

/** one plan: its terms, the next dates, its charges (each with its document, draft or reason) and what can be done with it */
function PlanView({ plan: p, customer, charges, refs, onClose, onEdit, onRetry, onChanged }: {
  plan: RecurringPlan; customer: string; charges: RecurringCharge[]; refs: ChargeRefs; onClose: () => void; onEdit: () => void;
  onRetry: (c: RecurringCharge) => void; onChanged: () => void;
}) {
  const { say } = useFinance();
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocRow | null>(null);
  const next = p.status === 'active' ? upcoming(p, 3) : [];

  async function act(action: 'pause' | 'resume' | 'end') {
    setBusy(true); setErr(null);
    const r = await setRecurringPlan(p.id, action, reason);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setEnding(false);
    say(r.data.status === 'paused' ? 'החיוב החוזר הושהה — לא יחייב עד שממשיכים'
      : r.data.status === 'active' ? `החיוב החוזר ממשיך — הבא ב-${ddmmyyyy(r.data.next)}` : 'החיוב החוזר הסתיים. מה שכבר הופק נשאר כמו שהוא.');
    onChanged();
  }
  async function openDoc(id: string) {
    const d = await loadDoc(id);
    if (d) setDoc(d); else say('המסמך לא נמצא');
  }

  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-display text-xl font-extrabold">{p.name}</h3>
          <p className="text-sm text-muted">{customer} · {ils(p.amount)} · {scheduleLabel(p.every, p.day, p.nextDate)}</p>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <div className="grid gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={TONE[p.status]}>{STATUS_HE[p.status]}</Pill>
          <Pill>{MODE_HE[p.mode]}</Pill>
          <Pill>{p.sendLink ? 'עם לינק לתשלום' : 'בלי לינק (למשל הוראת קבע)'}</Pill>
          <span className="text-muted">מ-{ddmmyyyy(p.startDate)}{p.endDate ? ` עד ${ddmmyyyy(p.endDate)}` : ' · בלי תאריך סיום'}</span>
        </div>
        <p>{planLine(p)}{next.length > 1 ? ` · אחר כך: ${next.slice(1).map(ddmmyyyy).join(', ')}` : ''}</p>
        {p.note && <p className="text-muted">הערה: {p.note}</p>}
        <ul className="grid gap-0.5 text-muted">
          {p.lines.map((l, i) => <li key={i} className="flex justify-between gap-2"><span>{l.name}{l.qty !== 1 ? ` × ${l.qty}` : ''}</span><span className="tabular-nums">{ils(l.unitPrice * l.qty)}</span></li>)}
          <li className="text-xs">{p.pricesIncludeVat ? 'המחירים כולל מע״מ' : 'המחירים לפני מע״מ'}</li>
        </ul>

        {p.status !== 'ended' && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>עריכה</Button>
            {p.status === 'active' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('pause')}>השהיה</Button>}
            {p.status === 'paused' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('resume')}>המשך</Button>}
            {!ending && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEnding(true)}>סיום</Button>}
          </div>
        )}
        {ending && (
          <div className="grid gap-2 rounded-2xl border border-line p-3">
            <p className="font-semibold">לסיים את החיוב החוזר?</p>
            <p className="text-xs text-muted">לא יופקו עוד חיובים. חשבוניות שכבר הופקו נשארות כמו שהן. אי אפשר להחזיר — אפשר לפתוח חיוב חוזר חדש.</p>
            <div className="w-full max-w-md"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="למה (לא חובה)" aria-label="סיבת הסיום" /></div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void act('end')}>{busy ? 'רגע…' : 'סיום החיוב החוזר'}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEnding(false)}>ביטול</Button>
            </div>
          </div>
        )}
        {err && <p role="alert" className="text-sm text-warn">{err}</p>}

        <section aria-labelledby="rc-charges" className="grid gap-1.5">
          <h4 id="rc-charges" className="font-bold">החיובים</h4>
          {!charges.length ? <p className="text-muted">{p.status === 'active' ? `עוד לא חויב — החיוב הראשון ב-${ddmmyyyy(p.nextDate)}.` : 'לא היו חיובים.'}</p> : (
            <ul className="grid gap-1.5">
              {charges.map((c) => {
                const st = chargeLine(c);
                const d = c.documentId ? refs.docs.get(c.documentId) : null;
                const link = c.paylinkId ? refs.links.get(c.paylinkId) : null;
                const draftDone = c.status === 'draft' && c.draftId ? refs.drafts.get(c.draftId) : null;
                return (
                  <li key={c.id} className="grid gap-1 rounded-xl bg-surface-2 px-3 py-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <strong className="min-w-0 flex-1">{periodLabel(c.periodDate, p.every)}</strong>
                      <Pill tone={st.tone}>{c.status === 'blocked' ? 'לא הופק' : st.text}</Pill>
                      {link && <Pill tone={link.status === 'paid' ? 'ok' : link.status === 'failed' ? 'bad' : 'default'}>{LINK_HE[link.status] ?? link.status}{link.isTest ? ' (בדיקה)' : ''}</Pill>}
                    </div>
                    {d && c.documentId && (
                      <button type="button" className="justify-self-start text-xs font-semibold text-primary" onClick={() => void openDoc(c.documentId!)}>
                        {DOC_LABEL[d.docType]} מס׳ {d.docNumber} · {ils(d.total)} ←
                      </button>
                    )}
                    {c.status === 'draft' && c.draftId && draftDone?.open !== false && (
                      <Link href={financeHref('documents')} className="justify-self-start text-xs font-semibold text-primary">הטיוטה מחכה במסמכים — בודקים ומפיקים ←</Link>
                    )}
                    {c.status === 'blocked' && <span className="text-xs text-red-700 dark:text-red-300">{c.error}</span>}
                    {c.note && <span className="text-xs text-muted">{c.note}</span>}
                    {c.status === 'blocked' && <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => onRetry(c)}>נסו שוב</Button>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      {doc && <DocView doc={doc} onClose={() => setDoc(null)} onChanged={onChanged} />}
    </Modal>
  );
}

/** a new plan, or new terms for one (from the next charge on; the schedule only before the first charge) */
function PlanEditor({ plan, leadId, charged, onClose, onSaved }: {
  plan: RecurringPlan | null; leadId: string | null; charged: boolean; onClose: () => void; onSaved: (id: string, message: string) => void;
}) {
  const { settings, vat, business, catalog, products, productsReady, reloadCatalog } = useFinance();
  const { leads } = useApp();
  const today = todayIL();
  const [id] = useState(() => plan?.id ?? crypto.randomUUID());
  const [f, setF] = useState<PlanInput>(() => (plan ? planInputOf(plan) : newPlanInput(today, leadId)));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof PlanInput>(k: K, v: PlanInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const customer = f.leadId ? leads.find((l) => l.id === f.leadId) ?? null : null;
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const digits = s.replace(/\D/g, '');
    return leads.filter((l) => l.name.toLowerCase().includes(s) || (digits.length >= 3 && (l.phone ?? '').replace(/\D/g, '').includes(digits))).slice(0, 6);
  }, [q, leads]);
  const total = planTotal(f.lines, f.pricesIncludeVat, settings.entity, settings.vatRate);
  const first = charged && plan ? plan.nextDate : firstCharge(f.startDate, f.every, f.day, today);
  const dates = first ? upcoming({ startDate: f.startDate, every: f.every, day: f.day, nextDate: first, endDate: f.endDate }, 3) : [];
  const schedule = !charged;

  async function save() {
    const problem = planError(f, total, today, { charged, startWas: plan?.startDate });
    if (problem) { setErr(problem); return; }
    setBusy(true); setErr(null);
    const r = await saveRecurringPlan(id, f, total);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    onSaved(id, r.data.status === 'ended' ? 'נשמר — תאריך הסיום עבר, החיוב החוזר הסתיים'
      : plan ? 'השינויים נשמרו — מהחיוב הבא' : `החיוב החוזר נשמר — הראשון ב-${ddmmyyyy(r.data.next)}`);
  }

  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-display text-xl font-extrabold">{plan ? 'עריכת חיוב חוזר' : 'חיוב חוזר חדש'}</h3>
          <p className="text-xs text-muted">ריטיינר, מנוי או הוראת קבע. שום כרטיס לא מחויב — בכל תקופה מופקת חשבונית (או טיוטה), ואם תבחרו — לינק לתשלום.</p>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <div className="grid gap-3">
        <div>
          <p className="mb-1 text-sm font-bold">לקוח/ה</p>
          {customer ? (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <strong>{customer.name}</strong>{customer.phone ? <span className="text-muted">{customer.phone}</span> : null}
              {!plan && <button type="button" className="text-xs font-semibold text-primary" onClick={() => set('leadId', null)}>החלפה</button>}
            </p>
          ) : (
            <div className="relative">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש באנשי הקשר (שם או טלפון)" aria-label="חיפוש לקוח/ה" />
              {hits.length > 0 && (
                <div className="absolute inset-x-0 top-full z-10 mt-1 grid rounded-2xl border border-line bg-surface p-1 shadow-lg">
                  {hits.map((l) => <button key={l.id} type="button" onClick={() => { set('leadId', l.id); setQ(''); }} className="min-h-11 rounded-xl px-3 text-start text-sm hover:bg-surface-2">{l.name}{l.phone ? ` · ${l.phone}` : ''}</button>)}
                </div>
              )}
              <p className="mt-1 text-xs text-muted">החשבוניות יוצאות על הפרטים שבכרטיס (שם לחשבונית, ע.מ / ח.פ, כתובת) — כדאי לבדוק אותם בכרטיס.</p>
            </div>
          )}
        </div>
        <Field label="שם החיוב (מופיע בחשבונית)"><Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} placeholder="למשל: ריטיינר חודשי — שיווק" /></Field>

        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold">מה מחייבים בכל תקופה</p>
            {vat && (
              <div className="flex gap-1.5 text-xs">
                <Chip on={f.pricesIncludeVat} onClick={() => set('pricesIncludeVat', true)} className="min-h-9">מחירים כולל מע״מ</Chip>
                <Chip on={!f.pricesIncludeVat} onClick={() => set('pricesIncludeVat', false)} className="min-h-9">לפני מע״מ</Chip>
              </div>
            )}
          </div>
          <LinesEditor lines={f.lines} onChange={(lines) => set('lines', lines)} catalog={catalog} products={products} productsReady={productsReady} onCatalogChanged={reloadCatalog} />
          <p className="mt-2 text-sm">סה״כ לתקופה: <strong className="tabular-nums">{ils(total)}</strong>{vat ? (f.pricesIncludeVat ? ' (כולל מע״מ)' : ` (כולל מע״מ ${settings.vatRate}%)`) : ''}</p>
        </div>

        <div className="grid gap-2">
          <p className="text-sm font-bold">מתי</p>
          {!schedule && <p className="text-xs text-muted">אחרי החיוב הראשון התדירות, היום וההתחלה לא משתנים. כדי לשנות — מסיימים ופותחים חיוב חוזר חדש.</p>}
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="כל כמה זמן">
            {EVERY.map((e) => <Chip key={e.months} on={f.every === e.months} disabled={!schedule} onClick={() => set('every', e.months)} role="radio" aria-checked={f.every === e.months}>{e.label}</Chip>)}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="ביום בחודש (1–28)">
              <div className="w-28"><Input type="number" inputMode="numeric" min={1} max={28} value={f.day || ''} disabled={!schedule} onChange={(e) => set('day', Math.trunc(Number(e.target.value)))} aria-label="ביום בחודש (1–28)" /></div>
            </Field>
            <Field label="מתחיל ב-"><div className="w-44"><Input type="date" value={f.startDate} disabled={!schedule} onChange={(e) => set('startDate', e.target.value || today)} aria-label="מתחיל ב-" /></div></Field>
            <Field label="מסתיים ב- (לא חובה)"><div className="w-44"><Input type="date" value={f.endDate ?? ''} min={f.startDate} onChange={(e) => set('endDate', e.target.value || null)} aria-label="מסתיים ב- (לא חובה)" /></div></Field>
          </div>
          {dates.length > 0 && <p className="text-xs text-muted">{charged ? 'החיובים הבאים' : 'החיובים הראשונים'}: {dates.map(ddmmyyyy).join(', ')}{f.endDate ? ` · עד ${ddmmyyyy(f.endDate)}` : ''}</p>}
        </div>

        <div className="grid gap-2">
          <p className="text-sm font-bold">מה קורה בכל תקופה</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="מה קורה בכל תקופה">
            <Chip on={f.mode === 'issue'} onClick={() => set('mode', 'issue')} role="radio" aria-checked={f.mode === 'issue'}>חשבונית מופקת אוטומטית</Chip>
            <Chip on={f.mode === 'draft'} onClick={() => set('mode', 'draft')} role="radio" aria-checked={f.mode === 'draft'}>טיוטה — אני מאשר/ת ומפיק/ה</Chip>
          </div>
          {f.mode === 'issue' ? (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={f.sendLink} onChange={(e) => set('sendLink', e.target.checked)} />
              לצרף לינק לתשלום (כשמסוף הסליקה מחובר; במייל — כשיש מייל בכרטיס)
            </label>
          ) : <p className="text-xs text-muted">הטיוטה מחכה ב"מסמכים". אחרי שמפיקים אותה — אפשר לשלוח ממנה לינק לתשלום.</p>}
          {f.mode === 'issue' && !f.sendLink && <p className="text-xs text-muted">בלי לינק — למשל הוראת קבע: הבנק משלם, ורושמים קבלה כשהכסף מגיע.</p>}
        </div>
        <Field label="הערה פנימית (לא בחשבונית)"><Textarea value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={300} className="min-h-14" /></Field>

        {!business.ready && <Note tone="warn">חסרים פרטי העסק למסמכים (מספר עוסק) — אפשר לשמור, אבל החשבוניות לא יופקו עד שממלאים ב"הגדרות".</Note>}
        {err && <Note tone="warn">{err}</Note>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'רגע…' : plan ? 'שמירת השינויים' : 'שמירת החיוב החוזר'}</Button>
          <Button variant="ghost" onClick={onClose}>ביטול</Button>
        </div>
      </div>
    </Modal>
  );
}
