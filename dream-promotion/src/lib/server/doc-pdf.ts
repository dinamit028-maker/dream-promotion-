import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import bidiFactory from 'bidi-js';
import { DOC_LABEL, PAY_LABEL, issuerFor, type DocRow } from '@/features/documents/documents';
import type { Business, Doc } from '@/features/documents/openformat';
import { issuerIdLine } from '@/features/finance/rules';

/**
 * A legal document as a PDF (A4, Hebrew, right to left) — the file that is signed digitally (sign-pdf.ts).
 * Same content as the printed HTML (docBody): business, document type and number, customer, lines,
 * totals before VAT / VAT / total, payments, issue time. pdf-lib draws left to right, so every line goes
 * through the Unicode bidi algorithm first (Hebrew reversed, numbers and Latin kept, brackets mirrored).
 */
const bidi = bidiFactory();
const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');
let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
const fontBytes = () => (fontCache ??= { regular: readFileSync(path.join(FONT_DIR, 'Rubik-Regular.ttf')), bold: readFileSync(path.join(FONT_DIR, 'Rubik-Bold.ttf')) });

/** logical text → the order to draw it in (left to right), for a right-to-left paragraph */
export function visual(text: string): string {
  const s = text.replace(/[\r\n\t]+/g, ' ');
  if (!s) return s;
  const levels = bidi.getEmbeddingLevels(s, 'rtl');
  const chars = Array.from(s); // code points (UTF-16 surrogates never split)
  if (chars.length !== s.length) return s; // astral characters (emoji) are removed before we get here
  for (const [i, m] of bidi.getMirroredCharactersMap(s, levels.levels)) chars[i] = m;
  for (const [a, b] of bidi.getReorderSegments(s, levels)) {
    const part = chars.slice(a, b + 1).reverse();
    chars.splice(a, b - a + 1, ...part);
  }
  return chars.join('');
}

/**
 * pdf-lib lets fontkit guess each string's script and reverse a "Hebrew" string by itself — numbers inside it
 * included. Our text is already in visual order (visual() above), so the layout is always left to right.
 */
function forceLtr(f: PDFFont) {
  const fk = (f as any).embedder?.font;
  if (!fk?.layout) return;
  const layout = fk.layout.bind(fk);
  fk.layout = (s: string, features?: unknown) => layout(s, Array.isArray(features) ? features : [], 'latn', 'dflt', 'ltr');
}

const ddmmyyyy = (d: string) => d.split('-').reverse().join('/');
const money = (n: number) => n.toFixed(2);
/** "05/10/2026 10:30" in Israel time */
const ilDateTime = (iso: string) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
};

export async function buildDocPdf(d: Doc & Partial<Pick<DocRow, 'issuer' | 'dueDate' | 'notes'>>, b: Business & { entityType?: string },
  o: { mark: string; software: string; signed: boolean; allocation?: string | null }): Promise<PDFDocument> {
  const iss = issuerFor(d, b);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fb = fontBytes();
  const font = await pdf.embedFont(fb.regular, { subset: true });
  const bold = await pdf.embedFont(fb.bold, { subset: true });
  forceLtr(font); forceLtr(bold);
  pdf.setTitle(`${DOC_LABEL[d.docType] ?? 'מסמך'} ${d.docNumber}`);
  pdf.setAuthor(iss.name); pdf.setCreator(o.software); pdf.setProducer(o.software); pdf.setLanguage('he-IL');

  const W = 595.28, H = 841.89, M = 40;
  const ink = rgb(0.07, 0.07, 0.07), muted = rgb(0.4, 0.4, 0.4), line = rgb(0.75, 0.75, 0.75), shade = rgb(0.95, 0.95, 0.95);
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;
  // characters the font can not draw (emoji…) are left out rather than breaking the file
  const known = new Set(font.getCharacterSet());
  const clean = (t: string) => Array.from(String(t ?? '')).filter((c) => known.has(c.codePointAt(0)!) || c === ' ').join('');
  const width = (t: string, size: number, f: PDFFont) => f.widthOfTextAtSize(visual(clean(t)), size);
  /** the longest start of t that fits — with "…" when cut */
  const fit = (t: string, size: number, f: PDFFont, max: number) => {
    let s = clean(t);
    if (width(s, size, f) <= max) return s;
    while (s.length > 1 && width(`${s}…`, size, f) > max) s = s.slice(0, -1);
    return `${s}…`;
  };
  /** draw right-aligned at xRight (the RTL default), or left-aligned at xLeft */
  const text = (t: string, at: { right?: number; left?: number }, size = 10, f: PDFFont = font, color = ink) => {
    const v = visual(clean(t));
    const x = at.right != null ? at.right - f.widthOfTextAtSize(v, size) : at.left!;
    page.drawText(v, { x, y, size, font: f, color });
  };
  const newPageIfNeeded = (need: number) => { if (y - need < M + 40) { page = pdf.addPage([W, H]); y = H - M; } };

  // ---- header: business (right) · document (left) ----
  text(iss.name, { right: W - M }, 16, bold);
  text(o.mark, { left: M }, 10, bold);
  page.drawRectangle({ x: M - 4, y: y - 4, width: width(o.mark, 10, bold) + 8, height: 16, borderColor: ink, borderWidth: 0.8 });
  y -= 18;
  const right: string[] = [iss.tradingName ?? '', issuerIdLine(iss), [iss.street, iss.houseNo, iss.city].filter(Boolean).join(' '), [iss.phone, iss.email].filter(Boolean).join(' · ')].filter(Boolean);
  const left: [string, number, PDFFont][] = [[`${DOC_LABEL[d.docType] ?? 'מסמך'} מס׳ ${d.docNumber}`, 15, bold], [`תאריך: ${ddmmyyyy(d.docDate)}`, 10, font]];
  if (d.dueDate) left.push([`לתשלום עד: ${ddmmyyyy(d.dueDate)}`, 10, font]);
  if (o.allocation) left.push([o.allocation, 9, bold]);
  for (let k = 0; k < Math.max(right.length, left.length); k++) {
    if (right[k]) text(right[k], { right: W - M }, 10, font, k === 0 && iss.tradingName ? ink : muted);
    if (left[k]) text(left[k][0], { left: M }, left[k][1], left[k][2]);
    y -= k === 0 ? 15 : 13;
  }
  y -= 12;

  // ---- customer ----
  const to = [`לכבוד: ${d.customerName || 'לקוח מזדמן'}`, d.customerDealer ? `ע.מ / ח.פ ${d.customerDealer}` : '', d.customerPhone ?? ''].filter(Boolean).join(' · ');
  text(to, { right: W - M }, 11, bold);
  y -= 15;
  const cAddr = [d.customerStreet, d.customerCity].filter(Boolean).join(', ');
  if (cAddr) { text(cAddr, { right: W - M }); y -= 15; }
  if (d.baseDocNumber) { text(`זיכוי עבור ${DOC_LABEL[d.baseDocType ?? 0] ?? ''} מס׳ ${d.baseDocNumber}`, { right: W - M }, 10, bold); y -= 15; }
  y -= 6;

  // ---- lines ----
  const cols = [ // right to left: description, qty, unit before VAT, total before VAT
    { title: 'תיאור', w: 228 }, { title: 'כמות', w: 42 }, { title: 'מחיר ליחידה (לפני מע״מ)', w: 130 }, { title: 'סה״כ (לפני מע״מ)', w: W - 2 * M - 400 },
  ];
  const rowH = 20;
  const drawRow = (cells: string[], head = false) => {
    newPageIfNeeded(rowH);
    if (head) page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: rowH, color: shade });
    let right = W - M;
    cells.forEach((c, i) => {
      const w = cols[i].w;
      const t = fit(c, head ? 9 : 10, head ? bold : font, w - 10);
      text(t, { right: right - 5 }, head ? 9 : 10, head ? bold : font);
      right -= w;
    });
    page.drawLine({ start: { x: M, y: y - 6 }, end: { x: W - M, y: y - 6 }, thickness: 0.5, color: line });
    y -= rowH;
  };
  drawRow(cols.map((c) => c.title), true);
  for (const l of d.lines) drawRow([l.name, String(l.qty), money(l.unitPriceExVat), money(l.totalExVat)]);
  y -= 10;

  // ---- totals ----
  const rate = d.lines[0]?.vatRate ?? 0;
  const withVat = Boolean(d.vatAmount || rate);
  const totals: [string, string, boolean?][] = [['סה״כ לפני הנחה', money(d.beforeDiscount)]];
  if (d.discount) totals.push(['הנחה', `-${money(d.discount)}`]);
  totals.push([withVat ? 'סה״כ לפני מע״מ' : 'סה״כ', money(d.afterDiscount)]);
  if (withVat) totals.push([`מע״מ ${rate}%`, money(d.vatAmount)]);
  totals.push([d.docType === 330 ? 'סה״כ זיכוי' : d.docType === 400 || d.docType === 320 ? 'סה״כ שולם' : 'סה״כ לתשלום', `${money(d.total)} ₪`, true]);
  for (const [k, v, strong] of totals) {
    newPageIfNeeded(18);
    text(k, { right: W - M - 5 }, strong ? 12 : 10, strong ? bold : font);
    text(v, { left: M + 5 }, strong ? 12 : 10, strong ? bold : font);
    page.drawLine({ start: { x: M, y: y - 6 }, end: { x: W - M, y: y - 6 }, thickness: 0.5, color: line });
    y -= 18;
  }

  // ---- payments ----
  if (d.payments.length) {
    y -= 12;
    newPageIfNeeded(18);
    text('אמצעי תשלום', { right: W - M }, 11, bold); y -= 18;
    for (const p of d.payments) {
      newPageIfNeeded(16);
      const cheque = p.cheque?.number ? ` · צ׳ק ${p.cheque.number}${p.cheque.bank ? ` · בנק ${p.cheque.bank}` : ''}${p.cheque.branch ? ` · סניף ${p.cheque.branch}` : ''}${p.cheque.dueDate ? ` · פירעון ${ddmmyyyy(p.cheque.dueDate)}` : ''}` : '';
      text(fit(`${PAY_LABEL[p.method] ?? 'אחר'} · ${ddmmyyyy(p.date)}${cheque}`, 10, font, W - 2 * M - 110), { right: W - M - 5 });
      text(money(p.amount), { left: M + 5 });
      y -= 16;
    }
  }

  // ---- notes, payment instructions, the business's note ----
  const bank = (d.docType === 305 || d.docType === 300) && iss.bankAccount
    ? `לתשלום בהעברה: ${[iss.bankName, iss.bankBranch ? `סניף ${iss.bankBranch}` : '', `חשבון ${iss.bankAccount}`].filter(Boolean).join(' · ')}` : '';
  for (const [t, f, c] of [[d.notes ?? '', font, ink], [bank, font, ink], [iss.note ?? '', font, muted]] as [string, PDFFont, typeof ink][]) {
    if (!t) continue;
    y -= 6;
    // long text wraps by words (right to left), at most 6 lines each
    const words = t.replace(/\s+/g, ' ').trim().split(' ');
    let lineText = '', lines = 0;
    for (const w of words) {
      const next = lineText ? `${lineText} ${w}` : w;
      if (width(next, 10, f) > W - 2 * M && lineText) { newPageIfNeeded(14); text(lineText, { right: W - M }, 10, f, c); y -= 14; lineText = w; if (++lines >= 6) break; }
      else lineText = next;
    }
    if (lineText && lines < 6) { newPageIfNeeded(14); text(lineText, { right: W - M }, 10, f, c); y -= 14; }
  }

  // ---- footer on every page ----
  const foot = `הופק: ${ilDateTime(d.issuedAt)} · מסמך ממוחשב${o.signed ? ' · חתום דיגיטלית' : ''} · ${o.software}`;
  for (const [i, p] of pdf.getPages().entries()) {
    page = p; y = M - 10;
    text(foot, { right: W - M }, 8, font, muted);
    text(`${i + 1}/${pdf.getPageCount()}`, { left: M }, 8, font, muted);
  }
  return pdf;
}
