'use client';
import { useEffect, useMemo, useState } from 'react';
import JSZip from 'jszip';
import { supabase } from '@/lib/supabase/client';
import { Button, Card, Chip, Field, Input } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { formatIL, israelParts } from '@/lib/il-time';
import { ils } from '@/features/register/money';
import { buildOpenFormat, docTypeReport, toIso88598, type Business, type Doc, type SoftwareInfo } from './openformat';
import { DOC_LABEL, PAY_LABEL, creditFor, creditedTotals, issuerFor, toDoc, type DocRow } from './documents';
import { issuerIdLine } from '@/features/finance/rules';

/** Legal documents: list, view & print (original / true copy), credit invoice, and the "ממשק פתוח" export. */
export { toDoc, type DocRow } from './documents';
export const docInsertRow = (userId: string, d: Omit<Doc, 'docNumber' | 'linkNo' | 'issuedAt'>, extra: { saleId?: string | null; leadId?: string | null; vatRate: number }) => ({
  user_id: userId, doc_type: d.docType, doc_number: 0, doc_date: d.docDate, customer_name: d.customerName, customer_phone: d.customerPhone ?? '',
  customer_dealer: d.customerDealer ?? '', customer_street: d.customerStreet ?? '', customer_city: d.customerCity ?? '', lines: d.lines, payments: d.payments,
  before_discount: d.beforeDiscount, discount: d.discount, after_discount: d.afterDiscount, vat_amount: d.vatAmount, total: d.total, vat_rate: extra.vatRate,
  base_doc_type: d.baseDocType ?? null, base_doc_number: d.baseDocNumber ?? null, sale_id: extra.saleId ?? null, lead_id: extra.leadId ?? null, issued_by: d.issuedBy ?? '',
});
export const SOFTWARE: SoftwareInfo = {
  regNumber: process.env.NEXT_PUBLIC_SOFTWARE_REG_NUMBER || '00000000', name: 'Dream Promotion',
  version: process.env.NEXT_PUBLIC_APP_VERSION || '', vendorVat: process.env.NEXT_PUBLIC_SOFTWARE_VENDOR_VAT || '000000000', vendorName: 'Dream Promotion',
};
/** print a document: the print is counted first, so the first print is "מקור" and every later one "העתק נאמן למקור" */
export async function printDocRow(d: DocRow, business: Business): Promise<DocRow | null> {
  const { data, error } = await supabase().from('documents').update({ print_count: d.printCount + 1 }).eq('id', d.id).select('*').single();
  if (error) return null;
  const fresh = toDoc(data);
  const w = window.open('', '_blank');
  if (w) { w.document.write(docHtml(fresh, business, fresh.printCount === 1 ? 'מקור' : 'העתק נאמן למקור')); w.document.close(); }
  return fresh;
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const ddmmyyyy = (d: string) => d.split('-').reverse().join('/');

export function DocumentsTab({ userId, business, licensed, onError }: { userId: string; business: Business & { ready: boolean }; licensed: boolean; onError: (m: string) => void }) {
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [open, setOpen] = useState<DocRow | null>(null);
  const [view, setView] = useState<'list' | 'export'>('list');
  const load = async () => {
    const { data, error } = await supabase().from('documents').select('*').order('issued_at', { ascending: false }).limit(3000);
    if (error) { onError(/relation .* does not exist|schema cache/i.test(error.message) ? 'צריך להריץ את מיגרציית המסמכים ב-Supabase (20261003001400).' : 'לא הצלחנו לטעון מסמכים.'); setDocs([]); return; }
    setDocs((data ?? []).map(toDoc));
  };
  useEffect(() => { void load(); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  // a document can be credited in parts (refunds) — how much of each was credited so far
  const credited = useMemo(() => creditedTotals(docs ?? []), [docs]);
  const creditNote = (d: DocRow) => { const c = credited.get(`${d.docType}:${d.docNumber}`) ?? 0; return !c ? '' : c >= d.total ? ' · זוכתה' : ` · זוכתה חלקית (${ils(c)})`; };

  async function printDoc(d: DocRow) {
    const { data, error } = await supabase().from('documents').update({ print_count: d.printCount + 1 }).eq('id', d.id).select('*').single();
    if (error) return onError('ההדפסה לא נרשמה. נסו שוב.');
    const fresh = toDoc(data);
    setDocs((all) => (all ?? []).map((x) => (x.id === d.id ? fresh : x))); setOpen(fresh);
    const w = window.open('', '_blank'); if (!w) return;
    w.document.write(docHtml(fresh, business, fresh.printCount === 1 ? 'מקור' : 'העתק נאמן למקור'));
    w.document.close();
  }
  async function credit(d: DocRow) {
    if (!window.confirm(`להפיק חשבונית מס זיכוי על ${DOC_LABEL[d.docType]} מס׳ ${d.docNumber} (${ils(d.total)})? המסמך המקורי נשאר כמו שהוא.`)) return;
    const c = creditFor(d, israelParts(Date.now()).date);
    const { error } = await supabase().from('documents').insert(docInsertRow(userId, c, { saleId: d.saleId, vatRate: d.lines[0]?.vatRate ?? 0 }));
    if (error) return onError('לא הצלחנו להפיק את הזיכוי.');
    await load(); setOpen(null);
  }

  if (!business.ready) return <Card className="p-4 text-sm">כדי להפיק מסמכים צריך למלא את פרטי העסק (מספר עוסק, שם, כתובת) ב<strong>הגדרות</strong>.</Card>;
  if (docs === null) return <div className="py-8 text-center"><Spinner /></div>;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Chip on={view === 'list'} onClick={() => setView('list')}>מסמכים</Chip>
        <Chip on={view === 'export'} onClick={() => setView('export')}>ממשק פתוח (מבנה אחיד)</Chip>
        <a href="/finance/documents" className="ms-auto text-sm font-semibold text-primary">מרכז המסמכים בכספים ←</a>
      </div>
      {view === 'list' && (
        <div className="grid grid-cols-1 gap-2">
          {docs.map((d) => (
            <button key={d.id} type="button" onClick={() => setOpen(d)} className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-start text-sm hover:border-primary">
              <span className="min-w-0 flex-1"><strong className="block truncate">{DOC_LABEL[d.docType]} {d.docNumber} · {d.customerName || 'לקוח מזדמן'}</strong>
                <span className="text-xs text-muted">{ddmmyyyy(d.docDate)}{creditNote(d)}{d.printCount ? ` · הודפס ${d.printCount}` : ''}</span></span>
              <strong className="tabular-nums">{ils(d.total)}</strong>
            </button>
          ))}
          {!docs.length && <p className="py-6 text-center text-sm text-muted">עוד לא הופקו מסמכים. מסמך מופק אוטומטית בכל מכירה ששולמה.</p>}
        </div>
      )}
      {view === 'export' && <OpenFormatExport docs={docs} business={business} />}

      <Modal open={Boolean(open)} onClose={() => setOpen(null)} wide>
        {open && <>
          <div className="max-h-[60vh] overflow-auto rounded-xl bg-white p-2 text-black" dangerouslySetInnerHTML={{ __html: docBody(open, business, open.printCount ? 'העתק נאמן למקור' : 'מקור (טרם הודפס)') }} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => printDoc(open)}>{open.printCount ? 'הדפסת העתק' : 'הדפסת מקור'}</Button>
            {licensed && (open.docType === 320 || open.docType === 305) && !credited.has(`${open.docType}:${open.docNumber}`) &&
              <Button variant="ghost" onClick={() => credit(open)}>חשבונית מס זיכוי</Button>}
            {open.shareToken && <a href={`/api/doc/${open.shareToken}/pdf`} target="_blank" rel="noopener" className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-semibold hover:border-primary">🔏 PDF חתום</a>}
            <Button variant="ghost" onClick={() => setOpen(null)}>סגירה</Button>
          </div>
          <p className="mt-2 text-xs text-muted">מסמך שהופק לא ניתן לשינוי או למחיקה. לתיקון — חשבונית זיכוי. החזר כספי על חלק מעסקה עושים מהעסקה עצמה (מכירות ודוחות ← העסקה ← החזר כספי).</p>
        </>}
      </Modal>
    </>
  );
}

function OpenFormatExport({ docs, business }: { docs: DocRow[]; business: Business }) {
  const y = israelParts(Date.now()).date.slice(0, 4);
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(israelParts(Date.now()).date);
  const [result, setResult] = useState<ReturnType<typeof buildOpenFormat> & { startedAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    const startedAt = new Date().toISOString();
    const f = buildOpenFormat(business, SOFTWARE, docs, { from, to, startedAt });
    const inner = new JSZip(); inner.file('BKMVDATA.TXT', toIso88598(f.bkmv));
    const bkmvZip = await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const outer = new JSZip(); const folder = f.dir.replace(/\\/g, '/');
    outer.file(`${folder}/INI.TXT`, toIso88598(f.ini)); outer.file(`${folder}/BKMVDATA.zip`, bkmvZip);
    const blob = await outer.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `OPENFRMT-${business.dealerNumber}-${from}-${to}.zip`; a.click();
    setResult({ ...f, startedAt }); setBusy(false);
  }
  const report = docTypeReport(docs, from, to);
  const printSummary = () => { const w = window.open('', '_blank'); if (w && result) { w.document.write(summaryHtml(result, business, from, to)); w.document.close(); } };
  const printReport = () => { const w = window.open('', '_blank'); if (w) { w.document.write(reportHtml(report, business, from, to)); w.document.close(); } };
  return (
    <Card className="p-4">
      <p className="mb-3 text-sm text-ink-2">הפקת קבצים במבנה אחיד (INI.TXT + BKMVDATA) לפי הוראות רשות המסים, לרואה החשבון או לביקורת.</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="מתאריך"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="עד תאריך"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={run} disabled={busy || from > to}>{busy ? 'מפיק…' : 'הפקת קבצים'}</Button>
        <Button variant="ghost" onClick={printReport}>דוח מסמכים לפי סוג (2.6)</Button>
      </div>
      {result && (
        <div className="mt-4 rounded-2xl bg-surface-2 p-3 text-sm">
          <p className="font-bold">ביצוע ממשק פתוח הסתיים בהצלחה.</p>
          <p className="break-all text-xs" dir="ltr">{result.dir}</p>
          <p className="mt-1">רשומות: {Object.entries(result.counts).map(([k, n]) => `${k}: ${n}`).join(' · ')}</p>
          <Button size="sm" variant="ghost" className="mt-2" onClick={printSummary}>הדפסת סיכום ההפקה</Button>
        </div>
      )}
    </Card>
  );
}

// ---------- printable HTML ----------
const page = (title: string, body: string) => `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Arial,system-ui,sans-serif;color:#111;margin:24px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #bbb;padding:6px;text-align:right;font-size:13px}
th{background:#f2f2f2}.h{display:flex;justify-content:space-between;gap:16px}.mark{font-size:13px;font-weight:bold;border:1px solid #111;padding:2px 8px;display:inline-block}.tot td{font-weight:bold}.muted{color:#666;font-size:12px}</style></head>
<body>${body}<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`;

export function docBody(d: Doc & Partial<Pick<DocRow, 'issuer' | 'dueDate' | 'notes' | 'customerEmail'>>, b: Business & { entityType?: string }, mark: string,
  extra: { allocation?: string | null } = {}) {
  const i = issuerFor(d, b);
  const rows = d.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${l.qty}</td><td>${l.unitPriceExVat.toFixed(2)}</td><td>${l.totalExVat.toFixed(2)}</td></tr>`).join('');
  const cheque = (p: Doc['payments'][number]) => (p.cheque?.number ? ` · צ׳ק ${esc(p.cheque.number)}${p.cheque.bank ? ` · בנק ${esc(p.cheque.bank)}` : ''}${p.cheque.branch ? ` · סניף ${esc(p.cheque.branch)}` : ''}${p.cheque.dueDate ? ` · פירעון ${ddmmyyyy(p.cheque.dueDate)}` : ''}` : '');
  const pays = d.payments.map((p) => `<tr><td>${esc(PAY_LABEL[p.method] ?? 'אחר')}${cheque(p)}</td><td>${ddmmyyyy(p.date)}</td><td>${p.amount.toFixed(2)}</td></tr>`).join('');
  const contact = [i.phone, i.email].filter(Boolean).join(' · ');
  const rate = d.lines[0]?.vatRate ?? 0;
  const vatRow = d.vatAmount || rate ? `<tr><td>מע״מ ${rate}%</td><td>${d.vatAmount.toFixed(2)}</td></tr>` : '';
  const bank = (d.docType === 305 || d.docType === 300) && i.bankAccount ? `<p>לתשלום בהעברה: ${esc([i.bankName, i.bankBranch ? `סניף ${i.bankBranch}` : '', `חשבון ${i.bankAccount}`].filter(Boolean).join(' · '))}</p>` : '';
  return `<div class="h"><div><strong style="font-size:18px">${esc(i.name)}</strong>${i.tradingName ? `<br>${esc(i.tradingName)}` : ''}<br>${esc(issuerIdLine(i))}<br>${esc([i.street, i.houseNo, i.city].filter(Boolean).join(' '))}${contact ? `<br>${esc(contact)}` : ''}</div>
<div style="text-align:left"><span class="mark">${esc(mark)}</span>${d.cancelled ? ' <span class="mark" style="color:#b00;border-color:#b00">בוטל</span>' : ''}<br><strong style="font-size:18px">${esc(DOC_LABEL[d.docType])} מס׳ ${d.docNumber}</strong><br>תאריך: ${ddmmyyyy(d.docDate)}${d.dueDate ? `<br>לתשלום עד: ${ddmmyyyy(d.dueDate)}` : ''}${extra.allocation ? `<br>${esc(extra.allocation)}` : ''}</div></div>
<p>לכבוד: <strong>${esc(d.customerName || 'לקוח מזדמן')}</strong>${d.customerDealer ? ` · ע.מ / ח.פ ${esc(d.customerDealer)}` : ''}${d.customerPhone ? ` · ${esc(d.customerPhone)}` : ''}${d.customerStreet || d.customerCity ? `<br>${esc([d.customerStreet, d.customerCity].filter(Boolean).join(', '))}` : ''}</p>
${d.baseDocNumber ? `<p>זיכוי עבור ${esc(DOC_LABEL[d.baseDocType ?? 0] ?? '')} מס׳ ${d.baseDocNumber}</p>` : ''}
<table><tr><th>תיאור</th><th>כמות</th><th>מחיר ליחידה (לפני מע״מ)</th><th>סה״כ (לפני מע״מ)</th></tr>${rows}</table>
<table><tr><td>סה״כ לפני הנחה</td><td>${d.beforeDiscount.toFixed(2)}</td></tr>${d.discount ? `<tr><td>הנחה</td><td>-${d.discount.toFixed(2)}</td></tr>` : ''}
<tr><td>${vatRow ? 'סה״כ לפני מע״מ' : 'סה״כ'}</td><td>${d.afterDiscount.toFixed(2)}</td></tr>${vatRow}
<tr class="tot"><td>${d.docType === 330 ? 'סה״כ זיכוי' : d.docType === 400 || d.docType === 320 ? 'סה״כ שולם' : 'סה״כ לתשלום'}</td><td>${d.total.toFixed(2)} ₪</td></tr></table>
${pays ? `<table><tr><th>אמצעי תשלום</th><th>תאריך</th><th>סכום</th></tr>${pays}</table>` : ''}
${d.notes ? `<p>${esc(d.notes)}</p>` : ''}${bank}${i.note ? `<p class="muted">${esc(i.note)}</p>` : ''}
<p class="muted">הופק: ${esc(formatIL(d.issuedAt))} · מסמך ממוחשב · Dream Promotion ${esc(SOFTWARE.version)}${SOFTWARE.regNumber !== '00000000' ? ` · תוכנה רשומה מס׳ ${esc(SOFTWARE.regNumber)}` : ''}</p>`;
}
const docHtml = (d: Doc, b: Business, mark: string) => page(`${DOC_LABEL[d.docType]} ${d.docNumber}`, docBody(d, b, mark));

function summaryHtml(r: ReturnType<typeof buildOpenFormat> & { startedAt: string }, b: Business, from: string, to: string) {
  const names: Record<string, string> = { A100: 'רשומת פתיחה', C100: 'כותרת מסמך', D110: 'פרטי מסמך', D120: 'פרטי קבלות', Z900: 'רשומת סיום' };
  const t = israelParts(new Date(r.startedAt));
  return page('הפקת קבצים במבנה אחיד', `<h2>הפקת קבצים במבנה אחיד עבור:</h2>
<p>מספר עוסק מורשה: ${esc(b.dealerNumber)}<br>שם בית העסק: ${esc(b.name)}</p><p><strong>ביצוע ממשק פתוח הסתיים בהצלחה.</strong></p>
<p>הנתונים נשמרו בנתיב הבא: <span dir="ltr">${esc(r.dir)}</span></p><p>טווח תאריכים: מתאריך ${from.split('-').reverse().join('')} ועד תאריך ${to.split('-').reverse().join('')}</p>
<table><tr><th>קוד רשומה</th><th>תיאור רשומה</th><th>סך רשומות</th></tr>${Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => `<tr><td>${k}</td><td>${names[k] ?? ''}</td><td>${n}</td></tr>`).join('')}</table>
<p>הנתונים הופקו באמצעות תוכנת: ${esc(SOFTWARE.name)}, מספר תעודת הרישום: ${esc(SOFTWARE.regNumber)} בתאריך ${t.date.split('-').reverse().map((x, i) => (i === 2 ? x.slice(2) : x)).join('/')} בשעה: ${t.time}.</p>`);
}
function reportHtml(rep: ReturnType<typeof docTypeReport>, b: Business, from: string, to: string) {
  return page('דוח מסמכים לפי סוג', `<h2>${esc(b.name)} · ע.מ ${esc(b.dealerNumber)}</h2><p>דוח מסמכים לפי סוג · ${ddmmyyyy(from)} – ${ddmmyyyy(to)}</p>
<table><tr><th>מספר המסמך</th><th>סוג המסמך</th><th>סה״כ כמותי</th><th>סה״כ כספי (בש״ח)</th></tr>${rep.map((x) => `<tr><td>${x.code}</td><td>${esc(x.name)}</td><td>${x.count}</td><td>${x.total.toFixed(2)}</td></tr>`).join('')}</table>`);
}
