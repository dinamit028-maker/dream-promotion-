'use client';
import { useEffect, useMemo, useState } from 'react';
import JSZip from 'jszip';
import { supabase } from '@/lib/supabase/client';
import { Button, Card, Chip, Field, Input } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { formatIL, israelParts } from '@/lib/il-time';
import { ils } from '@/features/register/money';
import { buildOpenFormat, docTypeReport, toIso88598, type Business, type Doc, type SoftwareInfo } from './openformat';
import { loadDocCodes } from './doc-codes';
import { bothScopes, confirmNoGaps, loadExportScope, type ExportScope } from './export-scope';
import { ScopeNote } from './ScopeNote';
import { multiLocation } from '@/features/locations/locations';
import { useLocations } from '@/features/locations/store';
import { DOC_LABEL, RECEIVED_LINE, baseDocLine, creditFor, docPayLabel, creditedTotals, isRefundReceipt, issuerFor, issuerLocationLine, toDoc, totalLabel, type DocRow } from './documents';
import { issuerIdLine } from '@/features/finance/rules';
import { issueDocumentRow } from '@/features/finance/api';
import { deliveryState, keepOriginal, recordDelivery, staffPdf, stateAllocationLine } from './deliver';
import { AWAITING_STAFF, type DeliveryState } from '@/features/finance/delivery';

/** Legal documents: list, view & print (original / true copy), credit invoice, and the "ממשק פתוח" export. */
export { toDoc, type DocRow } from './documents';
export const docInsertRow = (userId: string, d: Omit<Doc, 'docNumber' | 'linkNo' | 'issuedAt'>, extra: { saleId?: string | null; leadId?: string | null; vatRate: number }) => ({
  user_id: userId, doc_type: d.docType, doc_number: 0, doc_date: d.docDate, customer_name: d.customerName, customer_phone: d.customerPhone ?? '',
  customer_dealer: d.customerDealer ?? '', customer_street: d.customerStreet ?? '', customer_city: d.customerCity ?? '', lines: d.lines, payments: d.payments,
  before_discount: d.beforeDiscount, discount: d.discount, after_discount: d.afterDiscount, vat_amount: d.vatAmount, total: d.total, vat_rate: extra.vatRate,
  base_doc_type: d.baseDocType ?? null, base_doc_number: d.baseDocNumber ?? null, sale_id: extra.saleId ?? null, lead_id: extra.leadId ?? null, issued_by: d.issuedBy ?? '',
});
/** a real registration number of the software (8 digits from the Tax Authority) — none yet: "00000000" goes into the file only */
export const softwareRegistered = (n = process.env.NEXT_PUBLIC_SOFTWARE_REG_NUMBER) => Boolean(n && /^\d{8}$/.test(n) && n !== '00000000');
/**
 * The software in the unified file (INI.TXT, A000 — spec p. 10, checked 22.11.2026): 1006 registration number 9(8), 1007 name X(20),
 * 1008 version X(20), 1009 the software vendor's VAT number 9(9), 1010 the vendor's name X(20). The vendor's number and name come
 * from Vercel only (NEXT_PUBLIC_SOFTWARE_VENDOR_VAT / NEXT_PUBLIC_SOFTWARE_VENDOR_NAME) — never written in the code; a ״ in the name
 * is written " in the file (isoText). Without them — zeros and "Dream Promotion", as before. The file only: no document shows them.
 */
export const SOFTWARE: SoftwareInfo = {
  regNumber: process.env.NEXT_PUBLIC_SOFTWARE_REG_NUMBER || '00000000', name: 'Dream Promotion',
  version: process.env.NEXT_PUBLIC_APP_VERSION || '', vendorVat: process.env.NEXT_PUBLIC_SOFTWARE_VENDOR_VAT || '000000000',
  vendorName: process.env.NEXT_PUBLIC_SOFTWARE_VENDOR_NAME?.trim() || 'Dream Promotion',
};
/**
 * Before migration 20261126006900 (no document_delivery_record): count a print, then print — the first print is "מקור" and every
 * later one "העתק נאמן למקור". The count moves only from the value this screen saw (two screens printing at once never both get
 * "מקור"); if another screen printed meanwhile, the fresh count is taken once more.
 */
export async function countPrint(d: DocRow): Promise<DocRow | null> {
  let seen = d.printCount;
  for (let i = 0; i < 2; i++) {
    const { data } = await supabase().from('documents').update({ print_count: seen + 1 }).eq('id', d.id).eq('print_count', seen).select('*').maybeSingle();
    if (data) return toDoc(data);
    const now = await supabase().from('documents').select('print_count').eq('id', d.id).maybeSingle();
    if (!now.data) return null;
    seen = Number(now.data.print_count ?? 0);
  }
  return null;
}
export type PrintResult = { ok: true; doc: DocRow } | { ok: false; message: string };
/**
 * print a document: the window opens on the tap (iPhone blocks a window opened after waiting for the database).
 * 2.119 (the accountant's answers 1 and 6): the print is a delivery — document_delivery_record(doc, 'print') moves the print count
 * and says whether it is the original; refused while the document waits for its allocation number (the message says so). The
 * printed page carries the real allocation number when there is one, and the original's PDF is kept on the server.
 */
export async function printDocRow(d: DocRow, business: Business): Promise<PrintResult> {
  const w = window.open('', '_blank');
  const r = await recordDelivery(d.id, 'print');
  if (!r.ok && r.reason === 'missing') {
    const fresh = await countPrint(d);
    if (!fresh) { w?.close(); return { ok: false, message: 'ההדפסה לא נרשמה. נסו שוב.' }; }
    if (w) { w.document.write(docHtml(fresh, business, fresh.printCount === 1 ? 'מקור' : 'העתק נאמן למקור')); w.document.close(); }
    return { ok: true, doc: fresh };
  }
  if (!r.ok) { w?.close(); return { ok: false, message: r.message }; }
  const fresh: DocRow = { ...d, printCount: r.delivery.printCount || d.printCount + 1 };
  const st = await deliveryState(d.id);
  if (w) { w.document.write(docHtml(fresh, business, r.delivery.mark, stateAllocationLine(st.ok ? st.state : null))); w.document.close(); }
  keepOriginal(r.delivery);
  return { ok: true, doc: fresh };
}
/** was the document delivered already (2.119: any delivery — the link, a PDF, a print); before migration 6900 — a print */
export const wasDelivered = (d: Pick<DocRow, 'printCount'>, s: DeliveryState | null) => (s ? s.delivered || d.printCount > 0 : d.printCount > 0);
/** the screen's preview mark: what the next delivery will be — the same words as DocView's */
export const previewMark = (d: Pick<DocRow, 'printCount'>, s: DeliveryState | null) =>
  wasDelivered(d, s) ? 'העתק נאמן למקור' : s ? 'מקור (טרם נמסר)' : 'מקור (טרם הודפס)';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/**
 * an amount as written on the document; anything that is not a number prints nothing (never raw text). 2.118: an amount below zero
 * (a refund receipt's) is left to right — "-80.00", not "80.00-" in the RTL page; an amount above zero is written as before, byte
 * for byte (tests/cpa-rules-stage1.test.ts — the HTML of a document issued before 2.118)
 */
export const n2 = (v: unknown) => { const n = Number(v); return !Number.isFinite(n) ? '' : n < 0 ? `<span dir="ltr">${n.toFixed(2)}</span>` : n.toFixed(2); };
const ddmmyyyy = (d: unknown) => String(d ?? '').split('-').reverse().join('/');

export function DocumentsTab({ userId, business, licensed, onError }: { userId: string; business: Business & { ready: boolean }; licensed: boolean; onError: (m: string) => void }) {
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [open, setOpen] = useState<DocRow | null>(null);
  // 2.119: the open document's deliveries and allocation rule (document_delivery_state) — null before migration 6900, as before it
  const [openState, setOpenState] = useState<DeliveryState | null>(null);
  useEffect(() => {
    setOpenState(null);
    if (!open) return;
    let alive = true;
    void deliveryState(open.id).then((r) => { if (alive) setOpenState(r.ok ? r.state : null); });
    return () => { alive = false; };
  }, [open]);
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
    const r = await printDocRow(d, business);
    if (!r.ok) return onError(r.message);
    setDocs((all) => (all ?? []).map((x) => (x.id === d.id ? r.doc : x))); setOpen(r.doc);
  }
  const [crediting, setCrediting] = useState(false);
  async function credit(d: DocRow) {
    if (crediting) return;
    if (!window.confirm(`להפיק חשבונית מס זיכוי על ${DOC_LABEL[d.docType]} מס׳ ${d.docNumber} (${ils(d.total)})? המסמך המקורי נשאר כמו שהוא.`)) return;
    const c = creditFor(d, israelParts(Date.now()).date);
    setCrediting(true);
    // through the one engine, with one key: crediting the whole document once (2.52.1 — was a direct insert without a key)
    const out = await issueDocumentRow({ ...docInsertRow(userId, c, { saleId: d.saleId, vatRate: d.lines[0]?.vatRate ?? 0 }), idempotency_key: `credit:${d.id}:full` });
    setCrediting(false);
    if (!out.ok) return onError(`לא הצלחנו להפיק את הזיכוי: ${out.error}`);
    await load(); setOpen(null);
  }

  if (!business.ready) return <Card className="p-4 text-sm">כדי להפיק מסמכים צריך למלא את פרטי העסק (מספר עוסק, שם, כתובת) ב<strong>הגדרות</strong>.</Card>;
  if (docs === null) return <div className="py-8 text-center"><Spinner /></div>;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Chip on={view === 'list'} onClick={() => setView('list')}>מסמכים</Chip>
        <a href="/finance/accountant" className="inline-flex min-h-9 items-center rounded-full border border-line px-3 text-sm font-semibold hover:border-primary">ממשק פתוח (מבנה אחיד) ← חבילת רואה החשבון</a>
        <a href="/finance/documents" className="ms-auto text-sm font-semibold text-primary">מרכז המסמכים בכספים ←</a>
      </div>
      {!softwareRegistered() && (
        <p className="mb-3 rounded-2xl bg-surface-2 p-3 text-xs text-ink-2">התוכנה עוד לא רשומה ברשות המסים כתוכנה להפקת מסמכים. עד הרישום ובדיקת יועץ מס — השתמשו במסמכים לבדיקה בלבד.</p>
      )}
      {view === 'list' && (
        <div className="grid grid-cols-1 gap-2">
          {docs.map((d) => (
            <button key={d.id} type="button" onClick={() => setOpen(d)} className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-start text-sm hover:border-primary">
              <span className="min-w-0 flex-1"><strong className="block truncate">{DOC_LABEL[d.docType]} {d.docNumber}{isRefundReceipt(d) ? ' · החזר כספי' : ''} · {d.customerName || 'לקוח מזדמן'}</strong>
                <span className="text-xs text-muted">{ddmmyyyy(d.docDate)}{creditNote(d)}{d.printCount ? ` · הודפס ${d.printCount}` : ''}</span></span>
              <strong className="tabular-nums">{ils(d.total)}</strong>
            </button>
          ))}
          {!docs.length && <p className="py-6 text-center text-sm text-muted">עוד לא הופקו מסמכים. מסמך מופק אוטומטית בכל מכירה ששולמה.</p>}
        </div>
      )}

      <Modal open={Boolean(open)} onClose={() => setOpen(null)} wide>
        {open && <>
          <div className="max-h-[60vh] overflow-auto rounded-xl bg-white p-2 text-black" dangerouslySetInnerHTML={{ __html: docBody(open, business, previewMark(open, openState), { allocation: stateAllocationLine(openState) }) }} />
          {openState?.allocation.awaiting && <p role="status" className="mt-3 rounded-2xl border border-red-500/50 p-3 text-sm font-bold">{AWAITING_STAFF}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" disabled={Boolean(openState?.allocation.awaiting)} onClick={() => printDoc(open)}>{wasDelivered(open, openState) ? 'הדפסת העתק' : 'הדפסת מקור'}</Button>
            {licensed && (open.docType === 320 || open.docType === 305) && !credited.has(`${open.docType}:${open.docNumber}`) &&
              <Button variant="ghost" disabled={crediting} onClick={() => credit(open)}>{crediting ? 'מפיק…' : 'חשבונית מס זיכוי'}</Button>}
            <Button variant="ghost" disabled={Boolean(openState?.allocation.awaiting)} title="קובץ PDF למסירה ללקוח — נרשם כמסירה (הראשונה: מקור)"
              onClick={() => void staffPdf(open).then((e) => { if (e) onError(e); void deliveryState(open.id).then((r) => setOpenState(r.ok ? r.state : null)); })}>📄 PDF</Button>
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
  // 2.118: the file and its printouts are the whole business's — only when every location is seen (export-scope.ts)
  const [scope, setScope] = useState<ExportScope | null>(null);
  useEffect(() => { let alive = true; void loadExportScope().then((s) => { if (alive) setScope(s); }); return () => { alive = false; }; }, []);
  async function run() {
    setBusy(true);
    // the documents here were read when the screen opened: the scope then (scope) and now must both be "every location", and no hole
    let now = bothScopes(scope ?? await loadExportScope(), await loadExportScope());
    if (now.ok) now = await confirmNoGaps(docs.filter((d) => d.docDate >= from && d.docDate <= to), (t) => DOC_LABEL[t] ?? `מסמך ${t}`, multiLocation(useLocations.getState().state));
    setScope(now);
    if (!now.ok) { setResult(null); setBusy(false); return; }
    const codes = await loadDocCodes();   // field 1233 (2.117) — none before migration 20261122006700
    const startedAt = new Date().toISOString();
    const f = buildOpenFormat(business, SOFTWARE, docs, { from, to, startedAt, codes });
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
  const printReport = () => { if (!scope?.ok) return; const w = window.open('', '_blank'); if (w) { w.document.write(reportHtml(report, business, from, to)); w.document.close(); } };
  return (
    <Card className="p-4">
      <p className="mb-3 text-sm text-ink-2">הפקת קבצים במבנה אחיד (INI.TXT + BKMVDATA) לפי הוראות רשות המסים, לרואה החשבון או לביקורת.</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="מתאריך"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="עד תאריך"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={run} disabled={busy || from > to || scope?.ok === false}>{busy ? 'מפיק…' : 'הפקת קבצים'}</Button>
        <Button variant="ghost" onClick={printReport} disabled={!scope?.ok}>דוח מסמכים לפי סוג (2.6)</Button>
      </div>
      <ScopeNote scope={scope} />
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
  const rows = d.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.qty)}</td><td>${n2(l.unitPriceExVat)}</td><td>${n2(l.totalExVat)}</td></tr>`).join('');
  const cheque = (p: Doc['payments'][number]) => (p.cheque?.number ? ` · צ׳ק ${esc(p.cheque.number)}${p.cheque.bank ? ` · בנק ${esc(p.cheque.bank)}` : ''}${p.cheque.branch ? ` · סניף ${esc(p.cheque.branch)}` : ''}${p.cheque.dueDate ? ` · פירעון ${esc(ddmmyyyy(p.cheque.dueDate))}` : ''}` : '');
  const pays = d.payments.map((p) => `<tr><td>${esc(docPayLabel(p))}${cheque(p)}</td><td>${esc(ddmmyyyy(p.date))}</td><td>${n2(p.amount)}</td></tr>`).join('');
  const contact = [i.phone, i.email].filter(Boolean).join(' · ');
  const rate = d.lines[0]?.vatRate ?? 0;
  const vatRow = d.vatAmount || rate ? `<tr><td>מע״מ ${esc(rate)}%</td><td>${n2(d.vatAmount)}</td></tr>` : '';
  const bank = (d.docType === 305 || d.docType === 300) && i.bankAccount ? `<p>לתשלום בהעברה: ${esc([i.bankName, i.bankBranch ? `סניף ${i.bankBranch}` : '', `חשבון ${i.bankAccount}`].filter(Boolean).join(' · '))}</p>` : '';
  const where = issuerLocationLine(i);
  return `<div class="h"><div><strong style="font-size:18px">${esc(i.name)}</strong>${i.tradingName ? `<br>${esc(i.tradingName)}` : ''}<br>${esc(issuerIdLine(i))}<br>${esc([i.street, i.houseNo, i.city].filter(Boolean).join(' '))}${contact ? `<br>${esc(contact)}` : ''}${where ? `<br>${esc(where)}` : ''}</div>
<div style="text-align:left"><span class="mark">${esc(mark)}</span>${d.cancelled ? ' <span class="mark" style="color:#b00;border-color:#b00">בוטל</span>' : ''}<br><strong style="font-size:18px">${esc(DOC_LABEL[d.docType])} מס׳ ${esc(d.docNumber)}</strong><br>תאריך: ${esc(ddmmyyyy(d.docDate))}${d.dueDate ? `<br>לתשלום עד: ${esc(ddmmyyyy(d.dueDate))}` : ''}${extra.allocation ? `<br>${esc(extra.allocation)}` : ''}</div></div>
<p>לכבוד: <strong>${esc(d.customerName || 'לקוח מזדמן')}</strong>${d.customerDealer ? ` · ע.מ / ח.פ ${esc(d.customerDealer)}` : ''}${d.customerPhone ? ` · ${esc(d.customerPhone)}` : ''}${d.customerStreet || d.customerCity ? `<br>${esc([d.customerStreet, d.customerCity].filter(Boolean).join(', '))}` : ''}</p>
${baseDocLine(d) ? `<p>${esc(baseDocLine(d))}</p>` : ''}
<table><tr><th>תיאור</th><th>כמות</th><th>מחיר ליחידה (לפני מע״מ)</th><th>סה״כ (לפני מע״מ)</th></tr>${rows}</table>
<table><tr><td>סה״כ לפני הנחה</td><td>${n2(d.beforeDiscount)}</td></tr>${d.discount ? `<tr><td>הנחה</td><td>-${n2(d.discount)}</td></tr>` : ''}
<tr><td>${vatRow ? 'סה״כ לפני מע״מ' : 'סה״כ'}</td><td>${n2(d.afterDiscount)}</td></tr>${vatRow}
<tr class="tot"><td>${esc(totalLabel(d.docType, d.total))}</td><td>${n2(d.total)} ₪</td></tr></table>
${pays ? `<table><tr><th>אמצעי תשלום</th><th>תאריך</th><th>סכום</th></tr>${pays}</table>` : ''}
${d.notes ? `<p>${esc(d.notes)}</p>` : ''}${bank}${d.docType === 200 ? `<p style="margin-top:28px">${esc(RECEIVED_LINE)}</p>` : ''}${i.note ? `<p class="muted">${esc(i.note)}</p>` : ''}
<p class="muted">הופק: ${esc(formatIL(d.issuedAt))} · מסמך ממוחשב · Dream Promotion ${esc(SOFTWARE.version)}${softwareRegistered(SOFTWARE.regNumber) ? ` · תוכנה רשומה מס׳ ${esc(SOFTWARE.regNumber)}` : ''}</p>`;
}
const docHtml = (d: Doc, b: Business, mark: string, allocation: string | null = null) => page(`${DOC_LABEL[d.docType]} ${d.docNumber}`, docBody(d, b, mark, { allocation }));

/** נספח 4: the summary of an open-format run (also in the accountant's package, 2.52.1) */
export function summaryHtml(r: ReturnType<typeof buildOpenFormat> & { startedAt: string }, b: Business, from: string, to: string) {
  const names: Record<string, string> = { A100: 'רשומת פתיחה', B110: 'חשבון בהנהלת חשבונות', C100: 'כותרת מסמך', D110: 'פרטי מסמך', D120: 'פרטי קבלות', Z900: 'רשומת סיום' };
  const t = israelParts(new Date(r.startedAt));
  return page('הפקת קבצים במבנה אחיד', `<h2>הפקת קבצים במבנה אחיד עבור:</h2>
<p>מספר עוסק מורשה: ${esc(b.dealerNumber)}<br>שם בית העסק: ${esc(b.name)}</p><p><strong>ביצוע ממשק פתוח הסתיים בהצלחה.</strong></p>
<p>הנתונים נשמרו בנתיב הבא: <span dir="ltr">${esc(r.dir)}</span></p><p>טווח תאריכים: מתאריך ${from.split('-').reverse().join('')} ועד תאריך ${to.split('-').reverse().join('')}</p>
<table><tr><th>קוד רשומה</th><th>תיאור רשומה</th><th>סך רשומות</th></tr>${Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => `<tr><td>${k}</td><td>${names[k] ?? ''}</td><td>${n}</td></tr>`).join('')}</table>
<p>הנתונים הופקו באמצעות תוכנת: ${esc(SOFTWARE.name)}, מספר תעודת הרישום: ${softwareRegistered(SOFTWARE.regNumber) ? esc(SOFTWARE.regNumber) : 'טרם נרשמה'} בתאריך ${t.date.split('-').reverse().map((x, i) => (i === 2 ? x.slice(2) : x)).join('/')} בשעה: ${t.time}.</p>`);
}
/** 2.6(ב): documents by type for the period (also in the accountant's package, 2.52.1) */
export function reportHtml(rep: ReturnType<typeof docTypeReport>, b: Business, from: string, to: string) {
  return page('דוח מסמכים לפי סוג', `<h2>${esc(b.name)} · ע.מ ${esc(b.dealerNumber)}</h2><p>דוח מסמכים לפי סוג · ${ddmmyyyy(from)} – ${ddmmyyyy(to)}</p>
<table><tr><th>מספר המסמך</th><th>סוג המסמך</th><th>סה״כ כמותי</th><th>סה״כ כספי (בש״ח)</th></tr>${rep.map((x) => `<tr><td>${x.code}</td><td>${esc(x.name)}</td><td>${x.count}</td><td>${x.total.toFixed(2)}</td></tr>`).join('')}</table>`);
}
