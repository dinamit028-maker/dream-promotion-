'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL, israelParts, israelToIso } from '@/lib/il-time';
import { DOC_LABEL } from '@/features/documents/documents';
import { ils, methodLabel, type Sale } from './money';
import { cashDifference, daySummary, shiftDay, toShift, type DocLite, type Shift } from './shift';

/** "סגירת יום": open the drawer in the morning, count it in the evening, see the day — and keep every closing */
const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
const ddmmyyyy = (day: string) => day.split('-').reverse().join('/');
const amount = (v: string) => (v.trim() === '' || !(Number(v) >= 0) ? null : Math.round(Number(v) * 100) / 100);
const errText = (e: any) => /relation .* does not exist|schema cache/i.test(String(e?.message)) ? 'צריך להריץ את מיגרציית סגירת היום ב-Supabase (20261003001800).'
  : /register_shifts_one_open/.test(String(e?.message)) ? 'כבר יש יום פתוח. סוגרים אותו לפני שפותחים חדש.' : 'משהו השתבש. נסו שוב.';

async function loadDocs(userId: string, day: string): Promise<DocLite[]> {
  const { data } = await supabase().from('documents').select('doc_type, doc_number, issued_at').eq('user_id', userId)
    .gte('issued_at', israelToIso(day, '00:00')).lt('issued_at', israelToIso(nextDay(day), '00:00'));
  return ((data ?? []) as any[]).map((d) => ({ docType: d.doc_type, docNumber: Number(d.doc_number), issuedAt: d.issued_at }));
}

export function ShiftTab({ userId, sales, employees, businessName }: { userId: string; sales: Sale[]; employees: { id: string; name: string }[]; businessName: string }) {
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [docs, setDocs] = useState<DocLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState('');
  const [employee, setEmployee] = useState('');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const { data, error: e } = await supabase().from('register_shifts').select('*').eq('user_id', userId).order('opened_at', { ascending: false }).limit(60);
    if (e) { setError(errText(e)); setShifts([]); return; }
    setShifts((data ?? []).map(toShift)); setError(null);
  }, [userId]);
  useEffect(() => { void load(); }, [load]);

  const open = shifts?.find((s) => !s.closedAt) ?? null;
  const day = open ? shiftDay(open) : israelParts(Date.now()).date;
  useEffect(() => { void loadDocs(userId, day).then(setDocs); }, [userId, day, sales.length]);

  if (shifts === null) return <div className="py-8 text-center"><Spinner /></div>;
  const sum = daySummary({ sales, docs, day, openingCash: open?.openingCash ?? 0 });
  const countedA = amount(counted);
  const diff = countedA == null ? null : cashDifference(countedA, sum.expectedCash);

  async function openDay() {
    const cash = amount(opening); if (cash == null) return;
    setBusy(true);
    const { error: e } = await supabase().from('register_shifts').insert({ user_id: userId, opening_cash: cash, employee_name: employee });
    setBusy(false);
    if (e) return setError(errText(e));
    setOpening(''); void load();
  }
  async function closeDay() {
    if (!open || countedA == null || !diff) return;
    if (diff.kind !== 'even' && !window.confirm(`יש ${diff.kind === 'short' ? 'חוסר' : 'עודף'} של ${ils(Math.abs(diff.difference))}. לסגור את היום בכל זאת?`)) return;
    const w = window.open('', '_blank'); // opened on the click itself — a window opened after a request is blocked
    setBusy(true);
    const { data, error: e } = await supabase().from('register_shifts').update({
      closed_at: new Date().toISOString(), counted_cash: countedA, expected_cash: sum.expectedCash, difference: diff.difference, note: note.trim(),
      ...(employee && !open.employeeName ? { employee_name: employee } : {}),
    }).eq('id', open.id).is('closed_at', null).select('*').single();
    setBusy(false);
    if (e) { w?.close(); return setError(errText(e)); }
    setCounted(''); setNote(''); void load();
    printReport(w, toShift(data), sum, businessName);
  }

  return (
    <div className="grid gap-4">
      {error && <p className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}

      {!open ? (
        <Card className="p-4">
          <p className="mb-1 font-display text-lg font-extrabold">☀️ פתיחת יום</p>
          <p className="mb-3 text-sm text-ink-2">כמה מזומן יש במגירה עכשיו, לפני המכירה הראשונה?</p>
          <div className="grid gap-2 sm:grid-cols-[160px_1fr_auto] sm:items-end">
            <Field label="מזומן בפתיחה ₪"><Input type="number" inputMode="decimal" min={0} value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" className="h-12 text-lg" /></Field>
            {employees.length > 0 && <Field label="מי פותח/ת (לא חובה)">
              <Select value={employee} onChange={(e) => setEmployee(e.target.value)}><option value="">—</option>{employees.map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}</Select>
            </Field>}
            <Button variant="primary" size="lg" disabled={busy || amount(opening) == null} onClick={openDay}>פתיחת יום</Button>
          </div>
        </Card>
      ) : (
        <Card className="p-4">
          <p className="mb-1 font-display text-lg font-extrabold">🌙 סגירת יום · {ddmmyyyy(day)}</p>
          <p className="mb-3 text-xs text-muted">נפתח ב-{formatIL(open.openedAt, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric' })}{open.employeeName ? ` · ${open.employeeName}` : ''}
            {day !== israelParts(Date.now()).date && ' · היום הזה עדיין פתוח מתאריך קודם'}</p>
          <ul className="mb-3 grid gap-1 rounded-2xl bg-surface-2 p-3 text-sm tabular-nums">
            <li className="flex justify-between"><span>מזומן בפתיחה</span><span>{ils(open.openingCash)}</span></li>
            <li className="flex justify-between"><span>+ מזומן שנכנס היום (אחרי עודף)</span><span>{ils(sum.cashIn)}</span></li>
            <li className="flex justify-between border-t border-line pt-1 text-base font-bold"><span>צריך להיות במגירה</span><span>{ils(sum.expectedCash)}</span></li>
          </ul>
          <Field label="כמה מזומן יש במגירה בפועל? (ספרו והקלידו) ₪">
            <Input type="number" inputMode="decimal" min={0} value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="0" className="h-14 text-2xl font-bold" />
          </Field>
          <p role="status" className={cx('my-3 rounded-2xl p-4 text-center text-3xl font-black tabular-nums',
            !diff ? 'bg-surface-2 text-muted' : diff.kind === 'even' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : diff.kind === 'short' ? 'bg-red-500/15 text-red-700 dark:text-red-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>
            {!diff ? 'הקלידו את הסכום שספרתם' : diff.kind === 'even' ? '✓ הקופה מאוזנת' : diff.kind === 'short' ? `חוסר: ${ils(-diff.difference)}` : `עודף: ${ils(diff.difference)}`}
          </p>
          <Field label="הערה (לא חובה)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="למשל: 50 ₪ יצאו לקניית חלב" /></Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="lg" disabled={busy || !diff} onClick={closeDay}>סגירת יום והדפסה</Button>
            <Button variant="ghost" onClick={() => printReport(window.open('', '_blank'), null, sum, businessName, { day, openingCash: open.openingCash })}>הדפסת מצב ביניים</Button>
          </div>
        </Card>
      )}

      <DaySummaryCard sum={sum} day={day} />

      <Card className="p-4">
        <p className="mb-2 font-bold">סגירות קודמות</p>
        {!shifts.some((s) => s.closedAt) ? <p className="text-sm text-muted">עדיין אין סגירות.</p> : (
          <ul className="grid gap-2">
            {shifts.filter((s) => s.closedAt).map((s) => (
              <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <strong>{ddmmyyyy(shiftDay(s))}</strong>{s.employeeName ? ` · ${s.employeeName}` : ''}
                  <span className="block text-xs text-muted tabular-nums">צפוי {ils(s.expectedCash ?? 0)} · נספר {ils(s.countedCash ?? 0)}{s.note ? ` · ${s.note}` : ''}</span>
                </span>
                <DiffBadge difference={s.difference ?? 0} />
                <Button size="sm" variant="ghost" onClick={async () => {
                  const w = window.open('', '_blank'); const d = shiftDay(s);
                  printReport(w, s, daySummary({ sales, docs: await loadDocs(userId, d), day: d, openingCash: s.openingCash }), businessName);
                }}>הדפסה</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function DiffBadge({ difference }: { difference: number }) {
  const k = cashDifference(difference, 0).kind;
  return <span className={cx('rounded-full px-2.5 py-1 text-xs font-bold tabular-nums',
    k === 'even' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : k === 'short' ? 'bg-red-500/15 text-red-700 dark:text-red-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>
    {k === 'even' ? 'מאוזן' : k === 'short' ? `חוסר ${ils(-difference)}` : `עודף ${ils(difference)}`}</span>;
}

type Summary = ReturnType<typeof daySummary>;
function DaySummaryCard({ sum, day }: { sum: Summary; day: string }) {
  return (
    <Card className="p-4">
      <p className="mb-3 font-bold">סיכום היום · {ddmmyyyy(day)}</p>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-2xl bg-surface-2 p-3"><span className="block text-xs text-muted">הכנסות</span><strong className="text-xl tabular-nums">{ils(sum.total)}</strong></div>
        <div className="rounded-2xl bg-surface-2 p-3"><span className="block text-xs text-muted">עסקאות</span><strong className="text-xl tabular-nums">{sum.count}</strong></div>
        <div className="rounded-2xl bg-surface-2 p-3"><span className="block text-xs text-muted">מתוכו מע״מ</span><strong className="text-xl tabular-nums">{ils(sum.vat)}</strong></div>
        <div className="rounded-2xl bg-surface-2 p-3"><span className="block text-xs text-muted">ממתין לתשלום</span><strong className="text-xl tabular-nums">{ils(sum.pendingTotal)}</strong>{sum.pendingCount > 0 && <span className="text-xs text-muted"> ({sum.pendingCount})</span>}</div>
      </div>
      <p className="mb-1 text-sm font-semibold">לפי אמצעי תשלום</p>
      {!sum.byMethod.length ? <p className="mb-3 text-sm text-muted">אין מכירות היום.</p> : (
        <ul className="mb-3 grid gap-1 text-sm tabular-nums">
          {sum.byMethod.map((m) => <li key={m.method} className="flex justify-between"><span>{methodLabel(m.method)} ({m.count})</span><span>{ils(m.total)}</span></li>)}
        </ul>
      )}
      <p className="mb-1 text-sm font-semibold">מסמכים שהופקו היום</p>
      {!sum.docs.length ? <p className="text-sm text-muted">לא הופקו מסמכים.</p> : (
        <ul className="grid gap-1 text-sm tabular-nums">
          {sum.docs.map((d) => <li key={d.docType} className="flex justify-between"><span>{DOC_LABEL[d.docType] ?? d.docType}</span><span>{d.from === d.to ? `מס׳ ${d.from}` : `מס׳ ${d.from}–${d.to}`} ({d.count})</span></li>)}
        </ul>
      )}
    </Card>
  );
}

// ---------- printable report ----------
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function reportHtml(shift: Shift | null, sum: Summary, business: string, interim?: { day: string; openingCash: number }) {
  const day = shift ? shiftDay(shift) : interim!.day;
  const row = (a: string, b: string, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}><td>${esc(a)}</td><td>${esc(b)}</td></tr>`;
  const k = shift?.difference == null ? null : cashDifference(shift.difference, 0).kind;
  const cash = shift?.closedAt
    ? row('מזומן בפתיחה', ils(shift.openingCash)) + row('מזומן שנכנס (אחרי עודף)', ils(sum.cashIn)) + row('צריך להיות במגירה', ils(shift.expectedCash ?? 0), 'tot')
      + row('נספר בפועל', ils(shift.countedCash ?? 0)) + row('הפרש', k === 'even' ? 'מאוזן' : `${k === 'short' ? 'חוסר' : 'עודף'} ${ils(Math.abs(shift.difference ?? 0))}`, 'tot')
    : row('מזומן בפתיחה', ils(interim?.openingCash ?? shift?.openingCash ?? 0)) + row('מזומן שנכנס עד עכשיו (אחרי עודף)', ils(sum.cashIn)) + row('צריך להיות במגירה', ils(sum.expectedCash), 'tot');
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>סגירת יום ${esc(ddmmyyyy(day))}</title>
<style>body{font-family:Arial,system-ui,sans-serif;color:#111;margin:24px}table{width:100%;border-collapse:collapse;margin:8px 0 16px}td,th{border:1px solid #bbb;padding:6px;text-align:right;font-size:13px}
th{background:#f2f2f2}.tot td{font-weight:bold}h1{font-size:20px;margin:0}h2{font-size:15px;margin:16px 0 4px}.muted{color:#666;font-size:12px}</style></head><body>
<h1>${esc(business)} — ${shift?.closedAt ? 'דוח סגירת יום' : 'מצב ביניים'} ${esc(ddmmyyyy(day))}</h1>
<p class="muted">${shift ? `נפתח ${esc(formatIL(shift.openedAt))}` : ''}${shift?.closedAt ? ` · נסגר ${esc(formatIL(shift.closedAt))}` : ` · הופק ${esc(formatIL(new Date()))}`}${shift?.employeeName ? ` · ${esc(shift.employeeName)}` : ''}</p>
<h2>מזומן במגירה</h2><table>${cash}</table>
${shift?.note ? `<p>הערה: ${esc(shift.note)}</p>` : ''}
<h2>סיכום היום</h2><table>${row('הכנסות', ils(sum.total))}${row('מתוכו מע״מ', ils(sum.vat))}${row('מספר עסקאות', String(sum.count))}${row('הנחות', ils(sum.discounts))}${row('ממתין לתשלום', `${ils(sum.pendingTotal)} (${sum.pendingCount})`)}</table>
<h2>לפי אמצעי תשלום</h2><table><tr><th>אמצעי</th><th>עסקאות</th><th>סכום</th></tr>${sum.byMethod.map((m) => `<tr><td>${esc(methodLabel(m.method))}</td><td>${m.count}</td><td>${esc(ils(m.total))}</td></tr>`).join('') || '<tr><td colspan="3">אין מכירות</td></tr>'}</table>
<h2>מסמכים שהופקו</h2><table><tr><th>סוג</th><th>מספרים</th><th>כמות</th></tr>${sum.docs.map((d) => `<tr><td>${esc(DOC_LABEL[d.docType] ?? d.docType)}</td><td>${d.from === d.to ? d.from : `${d.from}–${d.to}`}</td><td>${d.count}</td></tr>`).join('') || '<tr><td colspan="3">לא הופקו מסמכים</td></tr>'}</table>
<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`;
}
function printReport(w: Window | null, shift: Shift | null, sum: Summary, business: string, interim?: { day: string; openingCash: number }) {
  if (!w) return;
  w.document.write(reportHtml(shift, sum, business, interim)); w.document.close();
}
