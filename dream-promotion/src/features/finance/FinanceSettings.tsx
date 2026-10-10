'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import { Button, Card, Chip, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { validIsraeliId } from '@/features/register/billing';
import { useFinance, type Profile, type Settings } from './FinanceScreen';
import { financeError } from './api';
import { ENTITY_TYPES, businessTypeOf, chargesVat } from './rules';
import { rateWarning } from './vat';
import { TERMS } from './receivables';
import { allocationRules } from './DocView';
import type { AllocationRule } from './allocation';
import { Note, Pill, ddmmyyyy, ils, todayIL } from './ui';
import { PaylinkSettings } from './Paylinks';
import { ReminderSettingsCard } from './Reminders';

/**
 * Money settings: the business's legal identity (what every document prints — and keeps, as it was, from 2.51), VAT,
 * bank details for payment by transfer, payment terms, the accountant, payment links (2.88: the terminal — the same one as
 * the site's checkout — and when a link's receipt is issued), automatic debt reminders (2.89: off until the owner approves them),
 * the Tax Authority connection (status only — the tokens never
 * reach the browser), the allocation rules (with "not verified" where they are not), and who opened the business's money
 * as a super admin.
 */
/** back from the Tax Authority's login page (callback/route.ts adds ?tax=…) */
const TAX_BACK: Record<string, string> = {
  connected: 'החיבור לרשות המסים נשמר לעסק הזה.',
  denied: 'החיבור לא נשמר: צריך להתחיל ולסיים אותו באותו דפדפן, כחבר/ה בעסק עם גישה מלאה.',
  failed: 'החיבור לרשות המסים לא הושלם. אפשר לנסות שוב.',
};
interface TaxStatus { mode: 'unconfigured' | 'mock' | 'live'; configured: boolean; connection: { status: string; environment: string; expiresAt: string | null; connectedAt: string | null } | null; message: string }

export function FinanceSettings() {
  const { userId, settings, profile, reload, say, fail, access } = useFinance();
  const [s, setS] = useState<Settings>(settings);
  const [p, setP] = useState<Profile>(profile);
  const [busy, setBusy] = useState(false);
  const [tax, setTax] = useState<TaxStatus | null>(null);
  const [taxBack, setTaxBack] = useState<string | null>(null);
  const [rules, setRules] = useState<AllocationRule[] | null>(null);
  const [grants, setGrants] = useState<{ reason: string; grantedAt: string; expiresAt: string; revokedAt: string | null }[]>([]);
  useEffect(() => {
    try { setTaxBack(new URLSearchParams(window.location.search).get('tax')); } catch { /* no address to read */ }
  }, []);
  useEffect(() => {
    void allocationRules().then(setRules);
    void (async () => {
      const unknown: TaxStatus = { mode: 'unconfigured', configured: false, connection: null, message: 'מצב החיבור לרשות המסים לא נטען כרגע. אפשר לרענן את הדף ולנסות שוב.' };
      try { const r = await fetch('/api/finance/tax/status', { headers: await authHeaders() }); setTax(r.ok ? await r.json() : unknown); } catch { setTax(unknown); }
    })();
    void supabase().from('finance_access_grants').select('reason, granted_at, expires_at, revoked_at').eq('business_id', access.business).order('granted_at', { ascending: false }).limit(20)
      .then(({ data }) => setGrants(((data ?? []) as any[]).map((g) => ({ reason: g.reason, grantedAt: g.granted_at, expiresAt: g.expires_at, revokedAt: g.revoked_at }))));
  }, [access.business]);

  const dealerBad = s.dealerNumber && (!/^\d{9}$/.test(s.dealerNumber) || !validIsraeliId(s.dealerNumber));
  const warn = rateWarning(s.vatRate, todayIL(), chargesVat(s.entity));
  async function save() {
    if (s.dealerNumber && !/^\d{9}$/.test(s.dealerNumber)) { fail('מספר עוסק / ח.פ — 9 ספרות'); return; }
    setBusy(true);
    const sb = supabase();
    const a = await sb.from('register_settings').upsert({ user_id: userId, entity_type: s.entity, business_type: businessTypeOf(s.entity), vat_rate: chargesVat(s.entity) ? s.vatRate : 0,
      dealer_number: s.dealerNumber, company_number: s.companyNumber, legal_name: s.legalName.trim(), street: s.street.trim(), house_no: s.houseNo.trim(), city: s.city.trim(), zip: s.zip.trim() }, { onConflict: 'business_id' });
    const b = a.error ? a : await sb.from('business_finance_profile').upsert({ user_id: userId, trading_name: p.tradingName.trim(), phone: p.phone.trim(), email: p.email.trim(),
      bank_name: p.bankName.trim(), bank_branch: p.bankBranch.trim(), bank_account: p.bankAccount.trim(), payment_terms: p.paymentTerms, quote_valid_days: p.quoteValidDays,
      doc_note: p.docNote.trim(), vat_period: p.vatPeriod, accountant_name: p.accountantName.trim(), accountant_email: p.accountantEmail.trim() }, { onConflict: 'business_id' });
    setBusy(false);
    if (b.error) { fail(financeError(b.error)); return; }
    say('ההגדרות נשמרו. מסמכים שכבר הופקו שומרים את הפרטים שהיו בהם.'); await reload();
  }
  async function connect() {
    const r = await fetch('/api/finance/tax/connect', { method: 'POST', headers: await authHeaders() });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.url) window.location.href = j.url; else fail(j.message ?? 'החיבור לא זמין.');
  }
  const setSv = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));
  const setPv = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((x) => ({ ...x, [k]: v }));

  return (
    <div className="grid gap-3">
      <Card className="p-4">
        <p className="mb-2 font-bold">סוג העסק</p>
        <div className="flex flex-wrap gap-1.5">{ENTITY_TYPES.map((e) => <Chip key={e.id} on={s.entity === e.id} onClick={() => setSv('entity', e.id)}>{e.label}</Chip>)}</div>
        <p className="mt-1 text-xs text-muted">{ENTITY_TYPES.find((e) => e.id === s.entity)?.hint}. הקופה עוברת בהתאם ({chargesVat(s.entity) ? 'חשבונית מס / קבלה' : 'קבלה'} על כל מכירה).</p>
        {chargesVat(s.entity) && <div className="mt-3"><Field label="שיעור מע״מ %"><Input type="number" value={s.vatRate} onChange={(e) => setSv('vatRate', Number(e.target.value))} className="w-28" /></Field>
          {warn && <Note tone="warn">{warn}</Note>}</div>}
      </Card>
      <Card className="p-4">
        <p className="mb-2 font-bold">פרטי העסק על המסמכים</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={s.entity === 'company' ? 'ח.פ / מספר עוסק (9 ספרות)' : 'מספר עוסק (9 ספרות)'}><Input value={s.dealerNumber} onChange={(e) => setSv('dealerNumber', e.target.value.replace(/\D/g, '').slice(0, 9))} inputMode="numeric" dir="ltr" /></Field>
          <Field label="מספר ח.פ / ע״ר (אם שונה)"><Input value={s.companyNumber} onChange={(e) => setSv('companyNumber', e.target.value.replace(/\D/g, '').slice(0, 9))} inputMode="numeric" dir="ltr" /></Field>
          <Field label="השם הרשום"><Input value={s.legalName} onChange={(e) => setSv('legalName', e.target.value)} /></Field>
          <Field label="שם מסחרי (לא חובה)"><Input value={p.tradingName} onChange={(e) => setPv('tradingName', e.target.value)} /></Field>
          <Field label="רחוב"><Input value={s.street} onChange={(e) => setSv('street', e.target.value)} /></Field>
          <Field label="מספר בית"><Input value={s.houseNo} onChange={(e) => setSv('houseNo', e.target.value)} /></Field>
          <Field label="עיר"><Input value={s.city} onChange={(e) => setSv('city', e.target.value)} /></Field>
          <Field label="מיקוד"><Input value={s.zip} onChange={(e) => setSv('zip', e.target.value)} inputMode="numeric" dir="ltr" /></Field>
          <Field label="טלפון על המסמכים"><Input value={p.phone} onChange={(e) => setPv('phone', e.target.value)} inputMode="tel" dir="ltr" /></Field>
          <Field label="מייל על המסמכים"><Input value={p.email} onChange={(e) => setPv('email', e.target.value)} inputMode="email" dir="ltr" /></Field>
        </div>
        {dealerBad && <Note tone="warn">מספר העוסק לא עובר בדיקת ספרת ביקורת — כדאי לבדוק שוב.</Note>}
        <Field label="הערה קבועה בתחתית המסמכים (לא חובה)"><Textarea value={p.docNote} onChange={(e) => setPv('docNote', e.target.value)} maxLength={500} className="min-h-14" /></Field>
      </Card>
      <Card className="p-4">
        <p className="mb-2 font-bold">תשלום והצעות מחיר</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="בנק"><Input value={p.bankName} onChange={(e) => setPv('bankName', e.target.value)} /></Field>
          <Field label="סניף"><Input value={p.bankBranch} onChange={(e) => setPv('bankBranch', e.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" dir="ltr" /></Field>
          <Field label="חשבון"><Input value={p.bankAccount} onChange={(e) => setPv('bankAccount', e.target.value.replace(/[^\d-]/g, '').slice(0, 20))} inputMode="numeric" dir="ltr" /></Field>
          <Field label="תנאי תשלום ברירת מחדל"><Select value={p.paymentTerms} onChange={(e) => setPv('paymentTerms', e.target.value)}>{TERMS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select></Field>
          <Field label="תוקף הצעת מחיר (ימים)"><Input type="number" min={1} max={365} value={p.quoteValidDays} onChange={(e) => setPv('quoteValidDays', Number(e.target.value))} /></Field>
          <Field label="דיווח מע״מ"><Select value={p.vatPeriod} onChange={(e) => setPv('vatPeriod', e.target.value as Profile['vatPeriod'])}><option value="bimonthly">דו-חודשי</option><option value="monthly">חודשי</option></Select></Field>
        </div>
        <p className="text-xs text-muted">פרטי הבנק מודפסים על חשבונית מס וחשבונית עסקה ("לתשלום בהעברה"). קופאי/ת לא רואה אותם.</p>
      </Card>
      <Card className="p-4">
        <p className="mb-2 font-bold">רואה החשבון</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="שם"><Input value={p.accountantName} onChange={(e) => setPv('accountantName', e.target.value)} /></Field>
          <Field label="מייל"><Input value={p.accountantEmail} onChange={(e) => setPv('accountantEmail', e.target.value)} inputMode="email" dir="ltr" /></Field>
        </div>
      </Card>
      <div><Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'שומר…' : 'שמירת ההגדרות'}</Button></div>

      <Card className="p-4"><PaylinkSettings userId={userId} /></Card>
      <Card className="p-4"><ReminderSettingsCard userId={userId} businessId={access.business} /></Card>

      <Card className="p-4">
        <p className="mb-1 font-bold">רשות המסים — מספרי הקצאה</p>
        {taxBack && <div className="mb-2"><Note tone={taxBack === 'connected' ? 'ok' : 'warn'}>{TAX_BACK[taxBack] ?? TAX_BACK.failed}</Note></div>}
        {!tax ? <Spinner /> : <>
          <p className="text-sm">{tax.message}</p>
          {tax.connection && <p className="mt-1 text-sm">חיבור: <Pill tone={tax.connection.status === 'connected' ? 'ok' : 'warn'}>{tax.connection.status}</Pill> · סביבה: {tax.connection.environment}{tax.connection.expiresAt ? ` · בתוקף עד ${formatIL(tax.connection.expiresAt)}` : ''}</p>}
          {tax.mode === 'mock' && <p className="mt-1 text-xs font-bold text-amber-600">מצב בדיקות: מספרים שמתקבלים מסומנים TEST ואינם מספרי הקצאה אמיתיים.</p>}
          {tax.configured && <Button size="sm" variant="ghost" className="mt-2" onClick={() => void connect()}>חיבור לרשות המסים</Button>}
        </>}
        <p className="mb-1 mt-4 text-sm font-bold">כללי מספר הקצאה (לפי תאריך המסמך)</p>
        {!rules ? <Spinner /> : (
          <ul className="grid gap-1 text-sm">{rules.map((r) => (
            <li key={r.version} className="flex flex-wrap items-center gap-2"><span>מ-{ddmmyyyy(r.effectiveFrom)}: מעל {ils(r.thresholdBeforeVat)} לפני מע״מ, לעוסק</span>
              <Pill tone={r.verified ? 'ok' : 'warn'}>{r.verified ? 'אומת' : 'לא אומת מול פרסום רשמי'}</Pill></li>
          ))}</ul>
        )}
        <p className="mt-2 text-xs text-muted">הספים נלקחו ממקורות משניים ומסומנים "לא אומת" עד שרו״ח מאשר מול פרסום רשות המסים. Dream Promotion לא מאושרת על ידי רשות המסים, ולא מדווחת אליה בלי חיבור אמיתי שאושר.</p>
      </Card>

      <Card className="p-4">
        <p className="mb-1 font-bold">גישת מנהל-על לנתונים הכספיים</p>
        {!grants.length ? <p className="text-sm text-muted">מנהל-על לא פתח גישה לנתונים הכספיים של העסק.</p> : (
          <ul className="grid gap-1 text-sm">{grants.map((g, i) => <li key={i}>{formatIL(g.grantedAt)} — {g.reason} · {g.revokedAt ? `נסגרה ${formatIL(g.revokedAt, { timeStyle: 'short' })}` : `עד ${formatIL(g.expiresAt, { timeStyle: 'short' })}`}</li>)}</ul>
        )}
      </Card>
    </div>
  );
}
