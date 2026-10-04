import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import bidiFactory from 'bidi-js';
import { DOC_LABEL, PAY_LABEL } from '@/features/documents/documents';
import type { Business, Doc } from '@/features/documents/openformat';

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

export async function buildDocPdf(d: Doc, b: Business, o: { mark: string; software: string; signed: boolean }): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fb = fontBytes();
  const font = await pdf.embedFont(fb.regular, { subset: true });
  const bold = await pdf.embedFont(fb.bold, { subset: true });
  forceLtr(font); forceLtr(bold);
  pdf.setTitle(`${DOC_LABEL[d.docType] ?? 'מסמך'} ${d.docNumber}`);
  pdf.setAuthor(b.name); pdf.setCreator(o.software); pdf.setProducer(o.software); pdf.setLanguage('he-IL');

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
  text(b.name, { right: W - M }, 16, bold);
  text(o.mark, { left: M }, 10, bold);
  page.drawRectangle({ x: M - 4, y: y - 4, width: width(o.mark, 10, bold) + 8, height: 16, borderColor: ink, borderWidth: 0.8 });
  y -= 18;
  text(`עוסק מורשה / ח.פ ${b.dealerNumber}`, { right: W - M });
  text(`${DOC_LABEL[d.docType] ?? 'מסמך'} מס׳ ${d.docNumber}`, { left: M }, 15, bold);
  y -= 15;
  const addr = [b.street, b.houseNo, b.city].filter(Boolean).join(' ');
  if (addr) text(addr, { right: W - M }, 10, font, muted);
  text(`תאריך: ${ddmmyyyy(d.docDate)}`, { left: M });
  y -= 26;

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
  const totals: [string, string, boolean?][] = [['סה״כ לפני הנחה', money(d.beforeDiscount)]];
  if (d.discount) totals.push(['הנחה', `-${money(d.discount)}`]);
  totals.push(['סה״כ לפני מע״מ', money(d.afterDiscount)], [`מע״מ ${d.lines[0]?.vatRate ?? 0}%`, money(d.vatAmount)], ['סה״כ לתשלום', `${money(d.total)} ₪`, true]);
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
      text(`${PAY_LABEL[p.method] ?? 'אחר'} · ${ddmmyyyy(p.date)}`, { right: W - M - 5 });
      text(money(p.amount), { left: M + 5 });
      y -= 16;
    }
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
