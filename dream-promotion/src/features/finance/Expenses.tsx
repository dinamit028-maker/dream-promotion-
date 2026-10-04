'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import { Button, Chip, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { Camera } from '@/components/ui/Icon';
import { useFinance } from './FinanceScreen';
import { financeError, logEvent } from './api';
import { EXPENSE_CATEGORIES, SUPPLIER_DOC_TYPES, carriesVat, categoryLabel, expenseColumns, expenseError, splitTotal, toExpense, type Expense, type ExpenseForm, type Extraction } from './expenses';
import { expensesCsv } from './reports';
import { PAY_METHODS } from './payments';
import { Note, PeriodPicker, Pill, ddmmyyyy, download, ils, periodNow, todayIL, type Period } from './ui';

/**
 * "הוצאות": supplier documents with their file (PDF / photo / the phone's camera) in a private bucket, by period.
 * "✨ קריאה אוטומטית" sends the file to the server, which asks the AI to read it; the answer only FILLS THE FORM — every field
 * is checked by the user, and nothing is saved until they press "אישור ושמירה". An expense is never deleted (void + reason).
 * Products bought come into stock through the register's stock log (no second inventory).
 */
const EMPTY = (today: string): ExpenseForm => ({ supplierName: '', supplierDealer: '', supplierDocType: 'tax_invoice', supplierDocNumber: '', allocationNumber: '', docDate: today,
  category: 'other', description: '', amountBeforeVat: 0, vatAmount: 0, total: 0, vatDeductiblePct: 100, paidOn: null, paymentMethod: null });

export function Expenses() {
  const { params, fail, vat } = useFinance();
  const [period, setPeriod] = useState<Period>(() => periodNow('month'));
  const [list, setList] = useState<Expense[] | null>(null);
  const [status, setStatus] = useState<'all' | 'draft' | 'void'>('all');
  const [edit, setEdit] = useState<Expense | 'new' | null>(null);
  const load = useCallback(async () => {
    let q = supabase().from('expenses').select('*').gte('doc_date', period.from).lte('doc_date', period.to).order('doc_date', { ascending: false }).limit(500);
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) { fail(financeError(error)); setList([]); return; }
    setList(((data ?? []) as any[]).map(toExpense));
  }, [period, status, fail]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (params.get('new')) setEdit('new'); }, [params]);
  const confirmed = (list ?? []).filter((e) => e.status === 'confirmed');
  const totalA = confirmed.reduce((a, e) => a + Math.round(e.total * 100) * (e.supplierDocType === 'credit' ? -1 : 1), 0);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setEdit('new')}><Camera size={18} aria-hidden />+ הוצאה</Button>
        <span className="flex-1" />
        {list && list.length > 0 && <Button size="sm" variant="ghost" onClick={() => { download(`הוצאות-${period.from}-${period.to}.csv`, expensesCsv(list, vat)); void logEvent('export.csv', 'expenses', '', { rows: list.length }); }}>ייצוא לאקסל</Button>}
      </div>
      <PeriodPicker value={period} onChange={setPeriod} />
      <div className="flex flex-wrap gap-1.5">
        <Chip on={status === 'all'} onClick={() => setStatus('all')}>הכל</Chip>
        <Chip on={status === 'draft'} onClick={() => setStatus('draft')}>ממתינות לאישור</Chip>
        <Chip on={status === 'void'} onClick={() => setStatus('void')}>מבוטלות</Chip>
      </div>
      {list === null ? <div className="py-8 text-center"><Spinner /></div> : !list.length ? <Note>אין הוצאות בתקופה הזו. מצלמים חשבונית או מעלים PDF — ו"קריאה אוטומטית" ממלאת את הטופס לבדיקה שלכם.</Note> : <>
        <p className="text-sm text-muted">{confirmed.length} הוצאות מאושרות · סה״כ {ils(totalA / 100)}</p>
        <div className="grid gap-1.5">
          {list.map((e) => (
            <button key={e.id} type="button" onClick={() => setEdit(e)} className="flex min-w-0 items-center gap-2 rounded-2xl border border-line bg-surface p-3 text-start text-sm hover:border-primary">
              <span className="min-w-0 flex-1"><strong className="block truncate">{e.supplierName} · {categoryLabel(e.category)}</strong>
                <span className="text-xs text-muted">#{e.number} · {ddmmyyyy(e.docDate)}{e.supplierDocNumber ? ` · מסמך ${e.supplierDocNumber}` : ''}{e.paidOn ? ' · שולם' : ' · לא שולם'}{e.filePath ? ' · 📎' : ''}</span></span>
              {e.status === 'draft' && <Pill tone="warn">ממתינה לאישור</Pill>}
              {e.status === 'void' && <Pill tone="bad">מבוטלת</Pill>}
              <strong className="tabular-nums">{e.supplierDocType === 'credit' ? '-' : ''}{ils(e.total)}</strong>
            </button>
          ))}
        </div>
      </>}
      {edit && <ExpenseEditor expense={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
    </div>
  );
}

function ExpenseEditor({ expense, onClose, onSaved }: { expense: Expense | null; onClose: () => void; onSaved: () => void }) {
  const { userId, settings, vat, catalog, say, access } = useFinance();
  const today = todayIL();
  const [f, setF] = useState<ExpenseForm>(() => (expense ? { ...expense, paymentMethod: expense.paymentMethod } as ExpenseForm : EMPTY(today)));
  const [file, setFile] = useState<File | null>(null);
  const [scan, setScan] = useState<{ busy: boolean; warnings: string[]; model: string; raw: unknown | null; error: string | null }>({ busy: false, warnings: [], model: '', raw: null, error: null });
  const [stock, setStock] = useState<{ itemId: string; qty: number }[]>(expense?.stockLines ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const locked = expense?.status === 'void' || Boolean(expense?.paidOn);
  const set = <K extends keyof ExpenseForm>(k: K, v: ExpenseForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const fromTotal = (total: number, withVat = carriesVat(f.supplierDocType) && vat) => setF((x) => ({ ...x, ...splitTotal(total, withVat ? settings.vatRate : 0) }));

  async function readFile(fl: File) {
    setFile(fl); setScan({ busy: true, warnings: [], model: '', raw: null, error: null });
    try {
      const fd = new FormData(); fd.append('file', fl);
      const r = await fetch('/api/finance/expenses/scan', { method: 'POST', headers: await authHeaders(), body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setScan({ busy: false, warnings: [], model: '', raw: null, error: j.message ?? 'הקריאה האוטומטית לא זמינה כרגע — ממלאים ידנית.' }); return; }
      const x = j.fields as Extraction;
      setF((cur) => ({ ...cur, ...Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)),
        vatDeductiblePct: EXPENSE_CATEGORIES.find((c) => c.id === (x.category ?? cur.category))?.vatPct ?? cur.vatDeductiblePct } as ExpenseForm));
      if (x.total !== undefined && (x.amountBeforeVat === undefined || x.vatAmount === undefined)) {
        const withVat = carriesVat(x.supplierDocType ?? f.supplierDocType) && vat;
        setF((cur) => ({ ...cur, ...splitTotal(x.total!, withVat ? settings.vatRate : 0) }));
      }
      setScan({ busy: false, warnings: j.warnings ?? [], model: j.model ?? '', raw: j.raw ?? x, error: null });
    } catch { setScan({ busy: false, warnings: [], model: '', raw: null, error: 'אין חיבור — ממלאים ידנית.' }); }
  }

  async function save(asDraft: boolean) {
    const err = expenseError(f, today, access.lockedUntil);
    if (err) { setError(err); return; }
    setBusy(true); setError(null);
    let path = expense?.filePath ?? '', mime = expense?.fileMime ?? '';
    if (file) {
      const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
      path = `${access.business}/${crypto.randomUUID()}-${safe}`; mime = file.type;
      const up = await supabase().storage.from('finance-files').upload(path, file, { contentType: file.type, upsert: false });
      if (up.error) { setBusy(false); setError(`הקובץ לא עלה: ${financeError(up.error)}`); return; }
    }
    const cols = { ...expenseColumns(f), file_path: path, file_mime: mime, stock_lines: stock.filter((s) => s.itemId && s.qty > 0) };
    const r = expense
      ? await supabase().from('expenses').update({ ...cols, ...(expense.status === 'draft' && !asDraft ? { status: 'confirmed' } : {}) }).eq('id', expense.id).select('*').single()
      : await supabase().from('expenses').insert({ ...cols, user_id: userId, status: asDraft ? 'draft' : 'confirmed', ...(scan.raw ? { ai_extracted: scan.raw, ai_model: scan.model.slice(0, 80) } : {}) }).select('*').single();
    if (r.error || !r.data) { setBusy(false); setError(financeError(r.error)); return; }
    const saved = toExpense(r.data);
    if (saved.status === 'confirmed' && saved.stockLines.length) {
      const st = await supabase().rpc('receive_expense_stock', { p_expense: saved.id });
      if (st.error) say(`ההוצאה נשמרה, אבל המלאי לא עודכן: ${financeError(st.error)}`);
    }
    setBusy(false); say(asDraft ? 'נשמרה — ממתינה לאישור' : 'ההוצאה נשמרה'); onSaved();
  }
  async function voidIt() {
    if (!expense) return;
    const { error: e } = await supabase().from('expenses').update({ status: 'void', void_reason: voiding.trim() }).eq('id', expense.id);
    if (e) { setError(financeError(e)); return; }
    say('ההוצאה בוטלה (היא נשארת ברשימה עם הסיבה)'); onSaved();
  }
  async function openFile() {
    if (!expense?.filePath) return;
    const { data, error: e } = await supabase().storage.from('finance-files').createSignedUrl(expense.filePath, 120);
    if (e || !data) { setError('הקובץ לא נפתח.'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  const products = catalog.filter((c) => c.kind === 'product');
  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="font-display text-xl font-extrabold">{expense ? `הוצאה #${expense.number}` : 'הוצאה חדשה'}</h3>
        <CloseButton onClick={onClose} />
      </div>
      {!expense && (
        <div className="mb-3 grid gap-2 rounded-2xl border border-dashed border-line p-3">
          <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} aria-label="קובץ החשבונית" />
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => fileRef.current?.click()}><Camera size={18} aria-hidden />צילום / העלאת קובץ</Button>
            {file && <span className="self-center text-sm">{file.name}</span>}
            {scan.busy && <span className="flex items-center gap-2 text-sm"><Spinner />קורא את הקובץ…</span>}
          </div>
          {scan.error && <Note tone="warn">{scan.error}</Note>}
          {scan.raw != null && !scan.busy && <Note>✨ הטופס מולא מהקובץ — <strong>בדקו כל שדה</strong> לפני השמירה. מה שלא נקרא בוודאות נשאר ריק.{scan.warnings.map((w) => <span key={w} className="block text-xs">• {w}</span>)}</Note>}
        </div>
      )}
      {expense?.filePath && <Button size="sm" variant="ghost" className="mb-3" onClick={() => void openFile()}>📎 פתיחת הקובץ</Button>}
      {locked && <div className="mb-3"><Note tone="warn">{expense?.status === 'void' ? `ההוצאה מבוטלת: ${expense.voidReason}` : 'ההוצאה שולמה — הסכומים נעולים. לתיקון: מבטלים ורושמים מחדש.'}</Note></div>}

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="ספק"><Input value={f.supplierName} onChange={(e) => set('supplierName', e.target.value)} disabled={expense?.status === 'void'} /></Field>
        <Field label="ע.מ ספק"><Input value={f.supplierDealer} onChange={(e) => set('supplierDealer', e.target.value.replace(/\D/g, '').slice(0, 9))} inputMode="numeric" dir="ltr" disabled={locked} /></Field>
        <Field label="סוג המסמך"><Select value={f.supplierDocType} disabled={locked} onChange={(e) => { const t = e.target.value; setF((x) => ({ ...x, supplierDocType: t, ...(carriesVat(t) ? {} : splitTotal(x.total, 0)) })); }}>
          {SUPPLIER_DOC_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select></Field>
        <Field label="מספר המסמך"><Input value={f.supplierDocNumber} onChange={(e) => set('supplierDocNumber', e.target.value)} disabled={expense?.status === 'void'} /></Field>
        <Field label="תאריך"><Input type="date" value={f.docDate} max={today} onChange={(e) => set('docDate', e.target.value)} disabled={locked} /></Field>
        <Field label="קטגוריה"><Select value={f.category} disabled={expense?.status === 'void'} onChange={(e) => { const c = EXPENSE_CATEGORIES.find((x) => x.id === e.target.value); setF((x) => ({ ...x, category: e.target.value, ...(locked ? {} : { vatDeductiblePct: c?.vatPct ?? 100 }) })); }}>
          {EXPENSE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
        <Field label="סה״כ (כולל מע״מ)"><Input type="number" inputMode="decimal" min={0} step="0.01" value={f.total || ''} disabled={locked} onChange={(e) => fromTotal(Number(e.target.value))} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="לפני מע״מ"><Input type="number" inputMode="decimal" step="0.01" value={f.amountBeforeVat || ''} disabled={locked} onChange={(e) => setF((x) => ({ ...x, amountBeforeVat: Number(e.target.value), vatAmount: Math.round((x.total - Number(e.target.value)) * 100) / 100 }))} /></Field>
          <Field label="מע״מ"><Input type="number" inputMode="decimal" step="0.01" value={f.vatAmount || ''} disabled={locked || !carriesVat(f.supplierDocType)} onChange={(e) => setF((x) => ({ ...x, vatAmount: Number(e.target.value), amountBeforeVat: Math.round((x.total - Number(e.target.value)) * 100) / 100 }))} /></Field>
        </div>
        {vat && carriesVat(f.supplierDocType) && <Field label={`מע״מ לקיזוז (%)${EXPENSE_CATEGORIES.find((c) => c.id === f.category)?.hint ? ` — ${EXPENSE_CATEGORIES.find((c) => c.id === f.category)!.hint}` : ''}`}>
          <Input type="number" min={0} max={100} step="0.01" value={f.vatDeductiblePct} disabled={locked} onChange={(e) => set('vatDeductiblePct', Number(e.target.value))} /></Field>}
        <Field label="מספר הקצאה (בחשבונית הספק, אם יש)"><Input value={f.allocationNumber} onChange={(e) => set('allocationNumber', e.target.value.replace(/\D/g, '').slice(0, 20))} inputMode="numeric" dir="ltr" disabled={expense?.status === 'void'} /></Field>
      </div>
      <Field label="תיאור"><Textarea value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={300} className="min-h-14" disabled={expense?.status === 'void'} /></Field>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.paidOn != null} disabled={locked} onChange={(e) => setF((x) => ({ ...x, paidOn: e.target.checked ? today : null, paymentMethod: e.target.checked ? 'transfer' : null }))} /> שולם</label>
        {f.paidOn != null && <>
          <Input type="date" value={f.paidOn} max={today} onChange={(e) => set('paidOn', e.target.value)} className="w-40 py-2" disabled={locked} aria-label="תאריך התשלום" />
          <select value={f.paymentMethod ?? 'transfer'} onChange={(e) => set('paymentMethod', e.target.value)} disabled={locked} className="h-10 rounded-md border-[1.5px] border-line bg-surface px-2" aria-label="אמצעי התשלום">
            {PAY_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
        </>}
      </div>
      {products.length > 0 && expense?.status !== 'void' && (
        <div className="mb-3 grid gap-1.5 rounded-2xl border border-line p-3 text-sm">
          <p className="font-bold">סחורה שנכנסה למלאי (לא חובה)</p>
          {stock.map((s, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_5rem_2rem] gap-1.5">
              <select value={s.itemId} onChange={(e) => setStock(stock.map((x, k) => (k === i ? { ...x, itemId: e.target.value } : x)))} className="h-10 rounded-md border-[1.5px] border-line bg-surface px-2" aria-label={`מוצר ${i + 1}`} disabled={expense?.status === 'confirmed'}>
                <option value="">בחירת מוצר</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <Input type="number" min={1} value={s.qty || ''} onChange={(e) => setStock(stock.map((x, k) => (k === i ? { ...x, qty: Math.max(0, Math.floor(Number(e.target.value))) } : x)))} className="px-2 py-2 text-center" aria-label={`כמות ${i + 1}`} disabled={expense?.status === 'confirmed'} />
              {expense?.status !== 'confirmed' && <button type="button" onClick={() => setStock(stock.filter((_, k) => k !== i))} aria-label="הסרה">✕</button>}
            </div>
          ))}
          {expense?.status !== 'confirmed' && <button type="button" className="justify-self-start font-semibold text-primary" onClick={() => setStock([...stock, { itemId: '', qty: 1 }])}>+ מוצר</button>}
          <p className="text-xs text-muted">באישור ההוצאה הכמויות נכנסות למלאי (קבלת סחורה) — פעם אחת, ביומן המלאי של הקופה.</p>
        </div>
      )}
      {error && <div className="mb-3"><Note tone="warn">{error}</Note></div>}
      <div className="flex flex-wrap gap-2">
        {expense?.status !== 'void' && <Button variant="primary" disabled={busy} onClick={() => void save(false)}>{busy ? 'שומר…' : expense?.status === 'confirmed' ? 'שמירה' : 'אישור ושמירה'}</Button>}
        {!expense && <Button variant="ghost" disabled={busy} onClick={() => void save(true)}>שמירה לאישור מאוחר יותר</Button>}
        <Button variant="ghost" onClick={onClose}>סגירה</Button>
      </div>
      {expense && expense.status !== 'void' && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
          <Input value={voiding} onChange={(e) => setVoiding(e.target.value)} placeholder="סיבת ביטול (למשל: נרשמה פעמיים)" className="max-w-xs py-2" aria-label="סיבת ביטול" />
          <Button size="sm" variant="ghost" disabled={voiding.trim().length < 2} onClick={() => window.confirm('לבטל את ההוצאה? היא תישאר ברשימה כמבוטלת, הכסף והמלאי שלה יחזרו.') && void voidIt()}>ביטול ההוצאה</Button>
        </div>
      )}
    </Modal>
  );
}
