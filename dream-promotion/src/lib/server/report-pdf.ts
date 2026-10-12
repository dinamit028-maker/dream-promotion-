import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { fontBytes, forceLtr, ilDateTime, visual } from './doc-pdf';

/**
 * A report of the money screens as a PDF (2.94, docs/FINANCE_ADDITIONS_HE.md T8: "every report — CSV and PDF"): the business, the
 * report's title and period, and its table — drawn right to left in Hebrew, the header row again on every page, the total last.
 * The screen sends the table as it shows it (src/features/finance/statements.ts → pdfBody); the business's name and number come
 * from the database. A working paper, and it says so on every page — not a filing.
 */
export interface ReportPdfInput { title: string; subtitle: string; columns: { label: string; numeric: boolean }[]; rows: string[][]; total: string[] | null; note: string }
export const REPORT_PDF_LIMITS = { rows: 3000, columns: 10, cell: 160, title: 120, subtitle: 200, note: 500 } as const;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').slice(0, max) : null);
/** what the screen sent → the input, or why not (every field checked: strings only, within the limits) */
export function reportPdfInput(body: unknown): { ok: true; input: ReportPdfInput } | { ok: false; error: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return { ok: false, error: 'לא התקבל דוח.' };
  const title = text(b.title, REPORT_PDF_LIMITS.title), subtitle = text(b.subtitle ?? '', REPORT_PDF_LIMITS.subtitle), note = text(b.note ?? '', REPORT_PDF_LIMITS.note);
  if (!title?.trim() || subtitle == null || note == null) return { ok: false, error: 'לדוח חסרה כותרת.' };
  if (!Array.isArray(b.columns) || !b.columns.length || b.columns.length > REPORT_PDF_LIMITS.columns) return { ok: false, error: 'עמודות הדוח לא תקינות.' };
  const columns = b.columns.map((c: any) => ({ label: text(c?.label, 60), numeric: c?.numeric === true }));
  if (columns.some((c) => c.label == null)) return { ok: false, error: 'עמודות הדוח לא תקינות.' };
  const n = columns.length;
  const row = (r: unknown) => (Array.isArray(r) && r.length === n ? r.map((v) => text(v, REPORT_PDF_LIMITS.cell)) : null);
  if (!Array.isArray(b.rows) || b.rows.length > REPORT_PDF_LIMITS.rows) return { ok: false, error: `הדוח ארוך מדי ל-PDF (עד ${REPORT_PDF_LIMITS.rows} שורות) — אפשר להוריד CSV.` };
  const rows = b.rows.map(row);
  if (rows.some((r) => !r || r.some((v) => v == null))) return { ok: false, error: 'שורות הדוח לא תקינות.' };
  const total = b.total == null ? null : row(b.total);
  if (b.total != null && (!total || total.some((v) => v == null))) return { ok: false, error: 'שורת הסיכום לא תקינה.' };
  return { ok: true, input: { title: title.trim(), subtitle, note, columns: columns as ReportPdfInput['columns'], rows: rows as string[][], total: total as string[] | null } };
}

export async function buildReportPdf(r: ReportPdfInput, business: { name: string; dealerNumber: string }, o: { software: string; at: string }): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fb = fontBytes();
  const font = await pdf.embedFont(fb.regular, { subset: true });
  const bold = await pdf.embedFont(fb.bold, { subset: true });
  forceLtr(font); forceLtr(bold);
  pdf.setTitle(r.title); pdf.setAuthor(business.name || 'Dream Promotion'); pdf.setCreator(o.software); pdf.setProducer(o.software); pdf.setLanguage('he-IL');

  // many columns: the page lies on its side
  const wide = r.columns.length > 6;
  const W = wide ? 841.89 : 595.28, H = wide ? 595.28 : 841.89, M = 36;
  const size = r.columns.length > 8 ? 8 : 9;
  const ink = rgb(0.07, 0.07, 0.07), muted = rgb(0.4, 0.4, 0.4), line = rgb(0.78, 0.78, 0.78), shade = rgb(0.94, 0.94, 0.94);
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;
  const known = new Set(font.getCharacterSet());
  const clean = (t: string) => Array.from(String(t ?? '')).filter((c) => known.has(c.codePointAt(0)!) || c === ' ').join('');
  // a number, a date, a percent: left to right as it is; Hebrew text: through the bidi algorithm (doc-pdf.ts visual)
  const shape = (t: string, numeric: boolean) => (numeric ? clean(t) : visual(clean(t)));
  const widthOf = (t: string, numeric: boolean, s: number, f: PDFFont) => f.widthOfTextAtSize(shape(t, numeric), s);
  const fit = (t: string, numeric: boolean, s: number, f: PDFFont, max: number) => {
    let x = clean(t);
    if (widthOf(x, numeric, s, f) <= max) return x;
    while (x.length > 1 && widthOf(`${x}…`, numeric, s, f) > max) x = x.slice(0, -1);
    return `${x}…`;
  };
  const draw = (t: string, at: { right?: number; left?: number }, s = size, f: PDFFont = font, color = ink, numeric = false) => {
    const v = shape(t, numeric);
    const x = at.right != null ? at.right - f.widthOfTextAtSize(v, s) : at.left!;
    page.drawText(v, { x, y, size: s, font: f, color });
  };

  // ---- the columns' widths: what their longest cell needs (up to a third of the page), then the page's width shared ----
  const avail = W - 2 * M, pad = 8;
  const all = [...r.rows, ...(r.total ? [r.total] : [])];
  const need = r.columns.map((c, i) => Math.min(avail / 3, Math.max(
    widthOf(c.label, false, size, bold),
    ...all.slice(0, 400).map((row) => widthOf(row[i] ?? '', c.numeric, size, row === r.total ? bold : font)),
  ) + pad * 2));
  const sum = need.reduce((a, x) => a + x, 0);
  // too wide: every column shrinks in proportion (a long text is cut with "…"); narrower: the text columns take the rest
  const texts = r.columns.map((c, i) => (c.numeric ? 0 : need[i])).reduce((a, x) => a + x, 0);
  const widths = sum > avail ? need.map((x) => (x * avail) / sum)
    : need.map((x, i) => (texts ? (r.columns[i].numeric ? x : x + ((avail - sum) * x) / texts) : (x * avail) / sum));

  // ---- the header of the report (first page) ----
  draw(business.name || '', { right: W - M }, 14, bold);
  if (business.dealerNumber) draw(`ע.מ / ח.פ ${business.dealerNumber}`, { left: M }, 10, font, muted);
  y -= 20;
  draw(r.title, { right: W - M }, 13, bold);
  y -= 16;
  if (r.subtitle) { draw(r.subtitle, { right: W - M }, 10, font, muted); y -= 16; }
  y -= 6;

  const rowH = size + 9;
  const drawRow = (cells: string[], kind: 'head' | 'row' | 'total') => {
    const f = kind === 'row' ? font : bold;
    if (kind !== 'row') page.drawRectangle({ x: M, y: y - 5, width: avail, height: rowH, color: shade });
    let right = W - M;
    cells.forEach((c, i) => {
      const w = widths[i];
      const numeric = kind === 'head' ? false : r.columns[i].numeric;
      draw(fit(c, numeric, size, f, w - pad * 2), { right: right - pad }, size, f, ink, numeric);
      right -= w;
    });
    page.drawLine({ start: { x: M, y: y - 5 }, end: { x: W - M, y: y - 5 }, thickness: 0.5, color: line });
    y -= rowH;
  };
  const head = r.columns.map((c) => c.label);
  const room = (h: number) => { if (y - h < M + 24) { page = pdf.addPage([W, H]); y = H - M; drawRow(head, 'head'); } };
  drawRow(head, 'head');
  for (const row of r.rows) { room(rowH); drawRow(row, 'row'); }
  if (!r.rows.length) { room(rowH); draw('אין נתונים לתקופה הזו.', { right: W - M - pad }, size, font, muted); y -= rowH; }
  if (r.total) { room(rowH); drawRow(r.total, 'total'); }

  // ---- the note (wrapped by words, right to left) ----
  if (r.note) {
    y -= 8;
    const words = r.note.split(' ');
    let lineText = '';
    for (const w of words) {
      const next = lineText ? `${lineText} ${w}` : w;
      if (widthOf(next, false, 9, font) > avail && lineText) { room(13); draw(lineText, { right: W - M }, 9, font, muted); y -= 13; lineText = w; } else lineText = next;
    }
    if (lineText) { room(13); draw(lineText, { right: W - M }, 9, font, muted); y -= 13; }
  }

  // ---- the footer on every page ----
  const foot = `הופק: ${ilDateTime(o.at)} · ${o.software} · דוח עבודה — לא דוח שהוגש לרשות המסים`;
  for (const [i, p] of pdf.getPages().entries()) {
    page = p; y = M - 12;
    draw(foot, { right: W - M }, 8, font, muted);
    draw(`${i + 1}/${pdf.getPageCount()}`, { left: M }, 8, font, muted, true);
  }
  return pdf;
}
