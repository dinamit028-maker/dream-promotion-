'use client';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Button, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { DOC_LABEL, type DocRow } from '@/features/documents/documents';
import { useFinance } from './FinanceScreen';
import { DocView, loadDoc } from './DocView';
import { composeCredit } from './compose';
import { documentRow, financeError, issueDocumentRow } from './api';
import { followKey } from './keys';
import { PAY_METHODS, type PayMethod } from './payments';
import { Note, Pill, ils, todayIL } from './ui';
import {
  STATE_HE, cancelSuggestion, ddmmyyyy, packageLine, packageState, packageWarnings, sessionsLabel, usedValueA,
  type ClientPackage, type PackageUse,
} from './packages';
import { cancelPackage, giveBack, loadPackage, loadUses, packagesChanged, setPackageValidity } from './packages-data';
import { SellPackageDialog } from './SellPackage';

/**
 * One sold package (docs/FINANCE ADDITIONS HE.md, T1): what is left, its validity, its document and money, every treatment
 * taken from it (and given back) — and what can happen to it: its document issued (when it was not), the validity moved,
 * a treatment given back, or the package cancelled. Cancelling puts the money right through the existing documents only:
 * a credit invoice (330) on a tax invoice, or the cancellation of a receipt / transaction invoice issued for nothing used.
 * The amounts are the system's suggestion; the owner approves or changes them.
 */
const TONE = { active: 'ok', used_up: 'default', expired: 'warn', cancelled: 'bad' } as const;

export function PackageView({ pkg: initial, onClose, onChanged, onOpenCard }: {
  pkg: ClientPackage; onClose: () => void; onChanged: () => void; onOpenCard?: (leadId: string) => void;
}) {
  const { say, fail, userId, settings, vat, business, profile } = useFinance();
  const today = todayIL();
  const [pkg, setPkg] = useState(initial);
  const [uses, setUses] = useState<PackageUse[] | null>(null);
  const [doc, setDoc] = useState<DocRow | null>(null);
  const [dialog, setDialog] = useState<'cancel' | 'document' | 'giveback' | null>(null);
  const [giving, setGiving] = useState<PackageUse | null>(null);
  const [validity, setValidity] = useState(initial.validUntil ?? '');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, u] = await Promise.all([loadPackage(pkg.id), loadUses([pkg.id])]);
    if (p.ok && p.data) { setPkg(p.data); setValidity(p.data.validUntil ?? ''); }
    setUses(u.ok ? u.data : []);
  }, [pkg.id]);
  useEffect(() => { void load(); }, [load]);
  const changed = () => { void load(); onChanged(); packagesChanged(pkg.leadId); };

  const st = packageState(pkg, today);
  const warnings = packageWarnings(pkg, today);
  const owed = pkg.docTotal != null && !pkg.docCancelled && (pkg.docType === 305 || pkg.docType === 300)
    ? Math.max(0, Math.round((pkg.docTotal - pkg.credited - pkg.paid) * 100) / 100) : 0;

  async function saveValidity() {
    setBusy(true);
    const r = await setPackageValidity(pkg.id, validity || null);
    setBusy(false);
    if (!r.ok) { fail(r.error); return; }
    say(validity ? `התוקף עודכן: עד ${ddmmyyyy(validity)}` : 'החבילה בלי הגבלת תוקף'); changed();
  }
  async function openDoc() {
    if (!pkg.documentId) return;
    const d = await loadDoc(pkg.documentId);
    if (d) setDoc(d); else fail('המסמך לא נטען — נסו שוב.');
  }

  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-display text-xl font-extrabold">{pkg.name}</h3>
          <p className="text-sm text-muted">{pkg.customerName || 'לקוח/ה'} · נמכרה {ddmmyyyy(pkg.soldOn)}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Pill tone={TONE[st]}>{STATE_HE[st]}</Pill>
            {warnings.map((w) => <Pill key={w.kind} tone="warn">⚠️ {w.text}</Pill>)}
          </div>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <div className="grid gap-3">
        <div className="rounded-2xl bg-surface-2 p-3 text-sm">
          <p className="text-base font-bold">{packageLine(pkg, today)}</p>
          <p className="mt-1 tabular-nums">{sessionsLabel(pkg.sessionsTotal)} · {ils(pkg.price)}
            {pkg.used > 0 ? ` · נוצלו ${pkg.used} (שווי ${ils(usedValueA(pkg) / 100)})` : ''}</p>
          {pkg.notes && <p className="mt-1 whitespace-pre-wrap text-ink-2" dir="auto">{pkg.notes}</p>}
        </div>

        {/* the document and the money — always from the ledger */}
        <div className="grid gap-1.5 rounded-2xl border border-line p-3 text-sm">
          {pkg.documentId && pkg.docType ? <>
            <p className="flex flex-wrap items-center gap-2">
              <span>{DOC_LABEL[pkg.docType]} מס׳ {pkg.docNumber}{pkg.docCancelled ? ' (בוטל)' : ''}</span>
              <button type="button" className="text-xs font-semibold text-primary" onClick={() => void openDoc()}>פתיחת המסמך</button>
            </p>
            <p className="tabular-nums">שולם: <strong>{ils(pkg.paid)}</strong>{pkg.credited ? ` · זוכה: ${ils(pkg.credited)}` : ''}
              {owed > 0 ? <span className="text-amber-700 dark:text-amber-300"> · יתרה לתשלום: {ils(owed)}</span> : null}</p>
            {owed > 0 && <p className="text-xs text-muted">תשלום שמגיע — &quot;קבלה על תשלום&quot; מתוך המסמך (אפשר בכמה תשלומים).</p>}
          </> : pkg.price > 0 ? (
            <div className="grid gap-2">
              <Note tone="warn">המסמך של החבילה לא הופק.</Note>
              {pkg.status === 'active' && <Button variant="primary" onClick={() => setDialog('document')}>הפקת המסמך</Button>}
            </div>
          ) : <p className="text-muted">חבילה ללא תשלום — בלי מסמך.</p>}
        </div>

        {/* the validity — the owner may move it while the package is active (written in the audit log) */}
        {pkg.status === 'active' && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="בתוקף עד (ריק = בלי הגבלה)">
              <Input type="date" value={validity} min={pkg.soldOn} onChange={(e) => setValidity(e.target.value)} className="w-44" />
            </Field>
            <Button size="sm" variant="ghost" disabled={busy || validity === (pkg.validUntil ?? '')} onClick={() => void saveValidity()}>שמירת התוקף</Button>
          </div>
        )}

        {/* every treatment taken from it */}
        <div>
          <p className="mb-1.5 text-sm font-bold">טיפולים שנוכו</p>
          {uses === null ? <Spinner /> : !uses.length ? <p className="text-sm text-muted">עוד לא נוכו טיפולים. ניכוי נעשה ברישום טיפול שבוצע, בכרטיס הלקוח (תיק לקוח).</p> : (
            <ol className="grid gap-1.5">
              {uses.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                  <span className={u.returnedAt ? 'text-muted line-through' : ''}>נוכה טיפול · {formatIL(u.usedAt, { dateStyle: 'short' })}</span>
                  {u.returnedAt && <span className="text-xs text-muted">הוחזר {formatIL(u.returnedAt, { dateStyle: 'short' })}{u.returnReason ? ` · ${u.returnReason}` : ''}</span>}
                  {!u.sessionId && <span className="text-xs text-muted">(תיק הלקוח נמחק)</span>}
                  {!u.returnedAt && pkg.status === 'active' && (
                    <button type="button" className="ms-auto text-xs font-semibold text-primary" onClick={() => { setGiving(u); setDialog('giveback'); }}>החזרה לחבילה</button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {onOpenCard && <Button variant="ghost" onClick={() => onOpenCard(pkg.leadId)}>לכרטיס הלקוח</Button>}
          {pkg.status === 'active' && <Button variant="ghost" onClick={() => setDialog('cancel')}>ביטול החבילה</Button>}
        </div>
        {pkg.status === 'cancelled' && <Note>בוטלה {pkg.cancelledAt ? formatIL(pkg.cancelledAt, { dateStyle: 'short' }) : ''}{pkg.cancelReason ? ` · ${pkg.cancelReason}` : ''}</Note>}
      </div>

      {dialog === 'cancel' && <CancelPackage pkg={pkg} onClose={() => setDialog(null)} onDone={(m) => { setDialog(null); say(m); changed(); }} />}
      {dialog === 'document' && <SellPackageDialog existing={pkg} basics={{ userId, entity: settings.entity, vatRate: settings.vatRate, vat, ready: business.ready, paymentTerms: profile.paymentTerms }}
        onClose={() => setDialog(null)} onDone={() => { setDialog(null); say('המסמך הופק'); changed(); }} />}
      {dialog === 'giveback' && giving && <GiveBack use={giving} onClose={() => setDialog(null)} onDone={() => { setDialog(null); say('הטיפול חזר לחבילה'); changed(); }} />}
      {doc && <DocView doc={doc} onClose={() => setDoc(null)} onChanged={changed} />}
    </Modal>
  );
}

function GiveBack({ use, onClose, onDone }: { use: PackageUse; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const r = await giveBack(use.id, reason || 'נוכה בטעות');
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onDone();
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">החזרת טיפול לחבילה</h3>
      <p className="mb-3 text-sm text-muted">הטיפול שבוצע נשאר בתיק הלקוח — רק הניכוי מהחבילה מתבטל. כשהטיפול עצמו בוטל, מבטלים אותו בכרטיס, והוא חוזר לחבילה לבד.</p>
      <Field label="סיבה (לא חובה)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="נוכה בטעות" /></Field>
      {error && <Note tone="warn">{error}</Note>}
      <div className="mt-3 flex gap-2"><Button variant="primary" disabled={busy} onClick={() => void go()}>החזרה לחבילה</Button><Button variant="ghost" onClick={onClose}>חזרה</Button></div>
    </Modal>
  );
}

/**
 * Cancelling a package: the suggestion (cancelSuggestion) — a credit invoice for what was not used and the money back for what
 * was paid beyond it — and the owner approves or changes the amounts. The documents are the existing ones only (composeCredit /
 * issueDocumentRow / record_credit_refund, or the cancellation of a 300 / 400); then the package is cancelled.
 */
function CancelPackage({ pkg, onClose, onDone }: { pkg: ClientPackage; onClose: () => void; onDone: (message: string) => void }) {
  const { userId } = useFinance();
  const { addActivity, updateLead } = useApp();
  const today = todayIL();
  const first = cancelSuggestion(pkg);
  const [credit, setCredit] = useState(first.credit);
  const plan = cancelSuggestion(pkg, credit);
  const [refund, setRefund] = useState(first.refund);
  const [refundTouched, setRefundTouched] = useState(false);
  const [refundNow, setRefundNow] = useState(first.refund > 0);
  const [method, setMethod] = useState<PayMethod>('cash');
  const [cancelDoc, setCancelDoc] = useState(first.route === 'cancel_document');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // what this dialog already did: a retry (after the refund or the cancellation was refused) never issues a second credit
  // invoice, records the money back twice or asks again
  const [issued, setIssued] = useState<DocRow | null>(null);
  const [refunded, setRefunded] = useState(false);
  const [cancelledDoc, setCancelledDoc] = useState(false);
  // the money back follows the credit until the owner types it
  useEffect(() => { if (!refundTouched) setRefund(plan.refund); }, [plan.refund, refundTouched]);

  async function go() {
    if (reason.trim().length < 2) { setErrors(['צריך לכתוב סיבה (2 תווים לפחות).']); return; }
    setBusy(true); setErrors([]);
    try {
      const done: string[] = [];
      if (plan.route === 'credit' && (credit > 0 || issued)) {
        let creditDoc = issued;
        if (!creditDoc) {
          if (credit > plan.maxCredit) { setErrors([`אפשר לזכות עד ${ils(plan.maxCredit)}.`]); return; }
          const base = await loadDoc(pkg.documentId!);
          if (!base) { setErrors(['המסמך של החבילה לא נטען — נסו שוב.']); return; }
          // the next credit invoice of this document: two devices crediting it at once share the key — one credit invoice only
          const { count, error: cErr } = await supabase().from('documents').select('id', { count: 'exact', head: true })
            .eq('doc_type', 330).eq('base_doc_type', base.docType).eq('base_doc_number', base.docNumber);
          if (cErr) { setErrors([financeError(cErr)]); return; }
          const r = composeCredit(base, { kind: 'amount', amount: credit }, pkg.credited, today, { reason: `ביטול חבילה: ${reason.trim()}`, today });
          if (!r.ok) { setErrors(r.errors); return; }
          if (!window.confirm(`להפיק חשבונית מס זיכוי על ${ils(r.doc.total)} ולבטל את החבילה? החשבונית המקורית נשארת כמו שהיא.`)) return;
          const out = await issueDocumentRow(documentRow(r.doc, { userId, idempotencyKey: followKey('credit', base.id, count ?? 0), vatRate: r.totals.vatRate, leadId: pkg.leadId, saleId: base.saleId }));
          if (!out.ok) { setErrors([out.error]); return; }
          // the key was taken by another device's credit invoice — not this one: nothing is recorded on it from here
          if (out.again) { setErrors(['כבר הופקה חשבונית זיכוי על המסמך הזה, כנראה ממכשיר אחר. סגרו ופתחו שוב כדי לראות מה נשאר.']); return; }
          creditDoc = out.doc; setIssued(out.doc);
          addActivity(pkg.leadId, 'note', `חשבונית זיכוי על חבילה "${pkg.name}" · ${ils(out.doc.total)}`);
          const l = useApp.getState().leads.find((x) => x.id === pkg.leadId);
          if (l) updateLead(l.id, { value: Math.max(0, Math.round(((l.value ?? 0) - out.doc.total) * 100) / 100) });
        }
        done.push(`הופקה חשבונית מס זיכוי מס׳ ${creditDoc.docNumber} · ${ils(creditDoc.total)}`);
        if (refundNow && refund > 0 && !refunded) {
          const { error } = await supabase().rpc('record_credit_refund', { p_document: creditDoc.id, p_method: method, p_amount: refund, p_paid_on: today, p_note: `ביטול חבילה: ${reason.trim()}`.slice(0, 300) });
          if (error) { setErrors([`חשבונית הזיכוי הופקה, אבל ההחזר לא נרשם: ${financeError(error)}`, 'אפשר לנסות שוב מכאן (לא תופק חשבונית נוספת), או לרשום אותו מחשבונית הזיכוי (מסמכים).']); return; }
          setRefunded(true);
        }
        if (refunded || (refundNow && refund > 0)) done.push(`נרשם החזר של ${ils(refund)}`);
      } else if (plan.route === 'cancel_document' && cancelDoc) {
        if (!cancelledDoc) {
          if (!window.confirm(`לבטל את ${DOC_LABEL[pkg.docType!]} מס׳ ${pkg.docNumber} ואת החבילה? המסמך נשאר ומסומן "בוטל".`)) return;
          const { error } = await supabase().from('document_cancellations').insert({ document_id: pkg.documentId, user_id: userId, reason: `ביטול חבילה: ${reason.trim()}`.slice(0, 300) });
          if (error && !/duplicate key|document_cancellations_pkey/.test(error.message)) { setErrors([financeError(error)]); return; }
          setCancelledDoc(true);
        }
        done.push(`${DOC_LABEL[pkg.docType!]} מס׳ ${pkg.docNumber} בוטל/ה`);
      } else if (!window.confirm('לבטל את החבילה? לא ינוכו ממנה יותר טיפולים.')) return;
      const c = await cancelPackage(pkg.id, reason);
      if (!c.ok) { setErrors([...done.map((d) => `${d} ✓`), `אבל החבילה לא בוטלה: ${c.error}`]); return; }
      addActivity(pkg.leadId, 'note', `החבילה "${pkg.name}" בוטלה · ${reason.trim()}`);
      onDone(['החבילה בוטלה', ...done].join(' · '));
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">ביטול החבילה · {pkg.name}</h3>
      <dl className="mb-3 grid gap-1 rounded-2xl bg-surface-2 p-3 text-sm tabular-nums">
        <div className="flex justify-between"><dt>נוצלו</dt><dd>{pkg.used} מתוך {pkg.sessionsTotal} · שווי {ils(plan.usedValue)}</dd></div>
        <div className="flex justify-between"><dt>לא נוצל</dt><dd>{ils(plan.unusedValue)}</dd></div>
        <div className="flex justify-between"><dt>שולם</dt><dd>{ils(plan.paid)}</dd></div>
      </dl>
      <Note>{plan.note}</Note>
      {plan.route === 'credit' && (
        <div className="mt-3 grid gap-2">
          <Field label={`חשבונית זיכוי על ₪ (עד ${ils(plan.maxCredit)}; 0 = בלי)`}>
            <Input type="number" inputMode="decimal" min={0} max={plan.maxCredit} step="0.01" value={credit} disabled={Boolean(issued)} onChange={(e) => setCredit(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          {issued && <p className="text-sm">✓ הופקה חשבונית מס זיכוי מס׳ {issued.docNumber} · {ils(issued.total)}</p>}
          {/* money back is recorded on the credit invoice — without one there is nothing to record it on */}
          {(credit > 0 || issued) && <>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={refundNow} disabled={refunded} onChange={(e) => setRefundNow(e.target.checked)} className="h-5 w-5" /> הכסף הוחזר ללקוח/ה</label>
            {refundNow && <>
              <Field label="החזר ₪"><Input type="number" inputMode="decimal" min={0} step="0.01" value={refund} disabled={refunded} onChange={(e) => { setRefundTouched(true); setRefund(Math.max(0, Number(e.target.value) || 0)); }} /></Field>
              <div className="flex flex-wrap gap-1.5">{PAY_METHODS.map((m) => <Chip key={m.id} on={method === m.id} onClick={() => !refunded && setMethod(m.id)} className="min-h-9">{m.icon} {m.label}</Chip>)}</div>
            </>}
          </>}
          {plan.owed > 0 && <p className="text-sm text-amber-700 dark:text-amber-300">אחרי הזיכוי נשאר/ת חייב/ת {ils(plan.owed)} על הטיפולים שנוצלו.</p>}
        </div>
      )}
      {plan.route === 'cancel_document' && (
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={cancelDoc} onChange={(e) => setCancelDoc(e.target.checked)} className="h-5 w-5" /> לבטל גם את {DOC_LABEL[pkg.docType!]} מס׳ {pkg.docNumber}</label>
      )}
      {plan.route === 'none' && plan.refund > 0 && <p className="mt-2 text-sm">לפי החישוב: שולם {ils(plan.refund)} יותר משווי הטיפולים שנוצלו.</p>}
      <Field label="סיבה (חובה)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-14" /></Field>
      {errors.length > 0 && <Note tone="warn">{errors.map((e) => <span key={e} className="block">{e}</span>)}</Note>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void go()}>{busy ? 'רגע…' : plan.route === 'credit' && credit > 0 && !issued ? 'הפקת זיכוי וביטול החבילה' : 'ביטול החבילה'}</Button>
        <Button variant="ghost" onClick={onClose}>חזרה</Button>
      </div>
      <p className="mt-2 text-xs text-muted">החישוב הוא הצעה של המערכת לפי החלק היחסי של הטיפולים — הבעלים מחליט/ה על הסכום.</p>
    </Modal>
  );
}
