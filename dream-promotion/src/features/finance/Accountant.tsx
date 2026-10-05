'use client';
import { useCallback, useEffect, useState } from 'react';
import JSZip from 'jszip';
import { supabase } from '@/lib/supabase/client';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { toDoc, type DocRow } from '@/features/documents/documents';
import { buildOpenFormat, toIso88598 } from '@/features/documents/openformat';
import { SOFTWARE } from '@/features/documents/DocumentsTab';
import { useFinance } from './FinanceScreen';
import { loadSummary } from './Overview';
import { reportHtml } from './Reports';
import { financeError, logEvent } from './api';
import { toExpense } from './expenses';
import { toLedgerRow } from './payments';
import { documentsCsv, expensesCsv, ledgerCsv, receivablesCsv } from './reports';
import { toReceivable } from './receivables';
import { ACTOR_HE, auditLine, auditSeal, toAuditRow, type AuditRow } from './audit';
import { toAllocationRow, isRealAllocation } from './allocation';
import { Note, PeriodPicker, ddmmyyyy, periodNow, todayIL, type Period } from './ui';

/**
 * "רואה חשבון": one package for the accountant — documents, expenses (with their files), the payments ledger, receivables,
 * the VAT working paper and the unified-structure files (ממשק פתוח) of the period, from the same data as every other screen.
 * Closing the books ("נעילת תקופה") freezes a reported period. The audit log, and a check that its chain is intact.
 */
async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>, map: (r: any) => T, cap = 20000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []).map(map));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export function Accountant() {
  const { profile, business, vat, access, reload, say, fail } = useFinance();
  const [period, setPeriod] = useState<Period>(() => periodNow(profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'));
  const [withFiles, setWithFiles] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [lockDate, setLockDate] = useState(() => periodNow('month').from > todayIL() ? '' : new Date(Date.parse(`${periodNow('month').from}T12:00:00Z`) - 864e5).toISOString().slice(0, 10));
  const [log, setLog] = useState<AuditRow[] | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; rows: number; firstBad?: number } | null>(null);

  const loadLog = useCallback(async (more = false) => {
    const from = more ? log?.length ?? 0 : 0;
    const { data, error } = await supabase().from('finance_audit_log').select('*').order('id', { ascending: false }).range(from, from + 49);
    if (error) { fail(financeError(error)); setLog([]); return; }
    const rows = ((data ?? []) as any[]).map(toAuditRow);
    setLog(more ? [...(log ?? []), ...rows] : rows);
  }, [log, fail]);
  useEffect(() => { void loadLog(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function pack() {
    setBusy('אוסף את הנתונים…');
    try {
      const sb = supabase();
      const [docs, cancels, allocs, expenses, ledger, recv, sum] = await Promise.all([
        all((a, b) => sb.from('documents').select('*').gte('doc_date', period.from).lte('doc_date', period.to).order('doc_type').order('doc_number').range(a, b), toDoc),
        all((a, b) => sb.from('document_cancellations').select('document_id').range(a, b), (r) => r.document_id as string),
        all((a, b) => sb.from('tax_allocations').select('*').range(a, b), (r) => ({ documentId: r.document_id as string, row: toAllocationRow(r) })),
        all((a, b) => sb.from('expenses').select('*').gte('doc_date', period.from).lte('doc_date', period.to).order('doc_date').range(a, b), toExpense),
        all((a, b) => sb.from('payments').select('*').gte('paid_on', period.from).lte('paid_on', period.to).order('paid_on').range(a, b), toLedgerRow),
        all((a, b) => sb.from('receivables').select('*').range(a, b), toReceivable),
        loadSummary(period),
      ]);
      if (!sum.ok) throw new Error(sum.error);
      const cancelled = new Set(cancels);
      const real = new Map(allocs.filter((x) => isRealAllocation(x.row)).map((x) => [x.documentId, `${x.row.number}${x.row.status === 'manual' ? ' (ידני)' : ''}`]));
      const marked: (DocRow & { cancelled?: boolean; allocation?: string })[] = docs.map((d) => ({ ...d, cancelled: cancelled.has(d.id), allocation: real.get(d.id) }));
      setBusy('מכין קבצים…');
      const zip = new JSZip();
      const root = `${business.dealerNumber || 'business'}-${period.from}-${period.to}`;
      zip.file(`${root}/מסמכים.csv`, documentsCsv(marked));
      zip.file(`${root}/הוצאות.csv`, expensesCsv(expenses, vat));
      zip.file(`${root}/יומן-תשלומים.csv`, ledgerCsv(ledger));
      zip.file(`${root}/חייבים.csv`, receivablesCsv(recv.filter((r) => !r.cancelled && r.balance > 0), todayIL()));
      zip.file(`${root}/דוח-${period.label}.html`, reportHtml(sum.s, `דוח ${period.label}`, business));
      // the last hash of the audit chain, kept with the accountant (outside the system)
      const [head, chain] = await Promise.all([
        sb.from('finance_audit_log').select('id, hash, at').order('id', { ascending: false }).limit(1).maybeSingle(),
        sb.rpc('finance_audit_verify'),
      ]);
      if (!head.error && !chain.error && chain.data) {
        const c = chain.data as { ok: boolean; rows: number; firstBad?: number };
        zip.file(`${root}/חותמת-יומן.txt`, auditSeal({ business: `${business.name}${business.dealerNumber ? ` (${business.dealerNumber})` : ''}`, from: period.from, to: period.to,
          madeAt: formatIL(new Date().toISOString()), rows: c.rows, ok: c.ok, firstBad: c.firstBad, lastId: head.data ? Number((head.data as any).id) : null,
          lastHash: head.data ? String((head.data as any).hash) : '', lastAt: head.data ? formatIL(String((head.data as any).at)) : '' }));
      }
      if (business.ready && docs.length) {
        const f = buildOpenFormat(business, SOFTWARE, marked, { from: period.from, to: period.to, startedAt: new Date().toISOString() });
        const inner = new JSZip(); inner.file('BKMVDATA.TXT', toIso88598(f.bkmv));
        zip.file(`${root}/${f.dir.replace(/\\/g, '/')}/INI.TXT`, toIso88598(f.ini));
        zip.file(`${root}/${f.dir.replace(/\\/g, '/')}/BKMVDATA.zip`, await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
      }
      let files = 0;
      if (withFiles) {
        const withPath = expenses.filter((e) => e.filePath);
        for (const [i, e] of withPath.entries()) {
          setBusy(`מוריד קבצי הוצאות ${i + 1}/${withPath.length}…`);
          const { data } = await sb.storage.from('finance-files').download(e.filePath);
          if (data) { zip.file(`${root}/קבצי-הוצאות/${e.number}-${e.filePath.split('/').pop()}`, data); files++; }
        }
      }
      setBusy('אורז…');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${root}.zip`; a.click();
      void logEvent('export.package', 'accountant', '', { from: period.from, to: period.to, documents: docs.length, expenses: expenses.length, files });
      say(`החבילה ירדה: ${docs.length} מסמכים, ${expenses.length} הוצאות${files ? `, ${files} קבצים` : ''}`);
    } catch (e) { fail(financeError(e)); }
    setBusy(null);
  }

  async function lock() {
    if (!lockDate) return;
    if (!window.confirm(`לסגור את הספרים עד ${ddmmyyyy(lockDate)}? אחרי הסגירה אי אפשר להפיק, לבטל או לשנות מסמכים והוצאות בתאריכים האלה — ואין פתיחה מהאפליקציה.`)) return;
    const { error } = await supabase().rpc('lock_finance_period', { p_end: lockDate, p_note: `נסגר מתוך מסך רואה החשבון (${period.label})` });
    if (error) { fail(financeError(error)); return; }
    say(`הספרים נסגרו עד ${ddmmyyyy(lockDate)}`); await reload(); void loadLog(false);
  }
  async function check() {
    const { data, error } = await supabase().rpc('finance_audit_verify');
    if (error) { fail(financeError(error)); return; }
    setVerify(data as any);
  }
  const mail = profile.accountantEmail
    ? `mailto:${profile.accountantEmail}?subject=${encodeURIComponent(`${business.name} — חומר לתקופה ${period.label}`)}&body=${encodeURIComponent(`שלום ${profile.accountantName || ''},\nמצורפת חבילת החומר לתקופה ${period.label} (מסמכים, הוצאות, יומן תשלומים וממשק פתוח).\nתודה`)}` : '';

  return (
    <div className="grid gap-3">
      <Card className="p-4">
        <p className="mb-2 font-bold">חבילה לרואה החשבון</p>
        <PeriodPicker value={period} onChange={setPeriod} vatKind={profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'} />
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} /> לצרף את קבצי ההוצאות (צילומים ו-PDF)</label>
        <p className="mt-2 text-sm text-muted">בחבילה: מסמכים, הוצאות, יומן תשלומים, חייבים, דוח מע״מ ורווח (לעבודה) וקבצי מבנה אחיד (INI.TXT + BKMVDATA) של התקופה.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" disabled={Boolean(busy)} onClick={() => void pack()}>{busy ? <><Spinner />{busy}</> : 'הורדת החבילה (ZIP)'}</Button>
          {mail && <a href={mail} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold hover:border-primary">✉️ מייל ל{profile.accountantName || 'רו״ח'}</a>}
        </div>
        {!profile.accountantEmail && <p className="mt-2 text-xs text-muted">את פרטי רואה החשבון ממלאים בלשונית "הגדרות".</p>}
      </Card>

      <Card className="p-4">
        <p className="mb-1 font-bold">סגירת ספרים (נעילת תקופה)</p>
        <p className="mb-2 text-sm text-muted">{access.lockedUntil ? `הספרים סגורים עד ${ddmmyyyy(access.lockedUntil)}.` : 'אין תקופה סגורה.'} אחרי דיווח לרשויות — סוגרים, כדי שאף מסמך או הוצאה לא יתווספו או ישתנו בתקופה שדווחה.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="לסגור עד (כולל)"><Input type="date" value={lockDate} max={new Date(Date.parse(`${todayIL()}T12:00:00Z`) - 864e5).toISOString().slice(0, 10)} onChange={(e) => setLockDate(e.target.value)} /></Field>
          <Button variant="ghost" disabled={!lockDate || (access.lockedUntil != null && lockDate <= access.lockedUntil)} onClick={() => void lock()} className="mb-4">סגירה</Button>
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="font-bold">יומן ביקורת כספי</p>
          <Button size="sm" variant="ghost" onClick={() => void check()}>בדיקת שלמות היומן</Button>
        </div>
        {verify && <div className="mb-2"><Note tone={verify.ok ? 'ok' : 'warn'}>{verify.ok ? `לא נמצא שינוי ביומן: ${verify.rows} רשומות, וכל רשומה משורשרת (hash) לקודמת.` : `נמצאה רשומה שהשתנתה (מס׳ ${verify.firstBad}) — צריך לבדוק.`}</Note></div>}
        {log === null ? <Spinner /> : !log.length ? <p className="text-sm text-muted">אין רשומות עדיין.</p> : (
          <ul className="grid gap-1 text-sm">{log.map((r) => (
            <li key={r.id} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 border-b border-line py-1.5 last:border-0">
              <span className="min-w-0">{auditLine(r)}</span>
              <span className={r.actorKind === 'super_admin' ? 'text-xs font-bold text-amber-600' : 'text-xs text-muted'}>{ACTOR_HE[r.actorKind]} · {formatIL(r.at)}</span>
            </li>
          ))}</ul>
        )}
        {log && log.length % 50 === 0 && log.length > 0 && <Button size="sm" variant="ghost" className="mt-2" onClick={() => void loadLog(true)}>עוד</Button>}
        <p className="mt-2 text-xs text-muted">היומן נכתב על ידי מסד הנתונים בלבד, ומהאפליקציה אי אפשר לשנות או למחוק בו שורה. כל שורה משורשרת (hash) לקודמת, ולכן בדיקת השלמות מגלה שורה שהשתנתה.
          זו הגנה שמגלה שינוי — היא לא מונעת שינוי ממי ששולט ישירות במסד הנתונים. לכן חבילת רואה החשבון כוללת חותמת של היומן, ששומרים מחוץ למערכת.</p>
      </Card>
    </div>
  );
}
