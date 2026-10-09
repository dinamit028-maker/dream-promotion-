import { createHash, randomBytes } from 'node:crypto';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import sharp from 'sharp';
import { fontBytes, forceLtr, ilDateTime, visual } from './doc-pdf';
import { answerLines, CONFIRM_LINE, type Answers, type Field } from '@/features/client-file/declarations';

/**
 * Health declarations on the server (docs/CLIENT FILE ENGINEERING HE.md §5.2–5.3): the link's token (32 random bytes;
 * only its sha-256 is kept), the customer's finger signature (a real line, not a dot), and the signed PDF.
 */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
}
export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
export const isToken = (t: unknown): t is string => typeof t === 'string' && /^[0-9a-f]{64}$/.test(t);
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export const MAX_SIGNATURE_BYTES = 400 * 1024;

/**
 * The signature as the page drew it (a PNG of the canvas, data URL): a PNG, not too big, and a real stroke — its ink
 * spans at least 40px one way and has enough points (a tap is a dot, not a signature). Returns the PNG bytes.
 */
export async function checkSignature(dataUrl: unknown): Promise<{ ok: true; png: Buffer } | { ok: false; message: string }> {
  const m = typeof dataUrl === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
  if (!m) return { ok: false, message: 'חסרה חתימה.' };
  const png = Buffer.from(m[1], 'base64');
  if (png.byteLength > MAX_SIGNATURE_BYTES) return { ok: false, message: 'החתימה גדולה מדי. נקו ונסו שוב.' };
  if (!(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) return { ok: false, message: 'החתימה לא תקינה.' };
  try {
    const { data, info } = await sharp(png, { limitInputPixels: 4_000_000 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width > 2000 || info.height > 1000) return { ok: false, message: 'החתימה לא תקינה.' };
    let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, ink = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 4;
        // ink: a visible pixel that is not (near) white
        if (data[i + 3] > 64 && data[i] + data[i + 1] + data[i + 2] < 600) {
          ink++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (ink < 60 || Math.max(maxX - minX, maxY - minY) < 40) return { ok: false, message: 'החתימה קצרה מדי — חתמו בקו, לא בנקודה.' };
    return { ok: true, png };
  } catch {
    return { ok: false, message: 'החתימה לא תקינה.' };
  }
}

export interface DeclarationPdfInput {
  business: string; templateTitle: string; templateVersion: number; number: string; requestId: string;
  fields: Field[]; acks: string[]; answers: Answers; marketingOk: boolean | null;
  signerName: string; signaturePng: Uint8Array; signedAt: string; ip: string; userAgent: string; software: string;
}

/** the signed declaration as a PDF (A4, Hebrew, right to left): every question with the answer chosen, the
 *  confirmations, the signature, the server's time, IP, user agent and the declaration's number */
export async function buildDeclarationPdf(d: DeclarationPdfInput): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fb = fontBytes();
  const font = await pdf.embedFont(fb.regular, { subset: true });
  const bold = await pdf.embedFont(fb.bold, { subset: true });
  forceLtr(font); forceLtr(bold);
  pdf.setTitle(`${d.templateTitle} — ${d.signerName}`);
  pdf.setAuthor(d.business); pdf.setCreator(d.software); pdf.setProducer(d.software); pdf.setLanguage('he-IL');
  pdf.setCreationDate(new Date(d.signedAt)); pdf.setModificationDate(new Date(d.signedAt));

  const W = 595.28, H = 841.89, M = 40, maxW = W - 2 * M;
  const ink = rgb(0.07, 0.07, 0.07), muted = rgb(0.4, 0.4, 0.4), line = rgb(0.8, 0.8, 0.8);
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;
  const known = new Set(font.getCharacterSet());
  const clean = (t: string) => Array.from(String(t ?? '')).filter((c) => known.has(c.codePointAt(0)!) || c === ' ').join('');
  const width = (t: string, size: number, f: PDFFont) => f.widthOfTextAtSize(visual(clean(t)), size);
  const room = (need: number) => { if (y - need < M + 30) { page = pdf.addPage([W, H]); y = H - M; } };
  /** right-aligned text, wrapped by words; returns nothing, moves y */
  const para = (t: string, size: number, f: PDFFont, color = ink, indent = 0, gap = 4) => {
    const lh = size * 1.45;
    for (const raw of String(t).split('\n')) {
      const words = raw.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      let cur = '';
      const flush = () => { room(lh); const v = visual(clean(cur)); page.drawText(v, { x: W - M - indent - f.widthOfTextAtSize(v, size), y, size, font: f, color }); y -= lh; };
      for (const w of words) {
        const next = cur ? `${cur} ${w}` : w;
        if (cur && width(next, size, f) > maxW - indent) { flush(); cur = w; } else cur = next;
      }
      if (cur) flush();
    }
    y -= gap;
  };

  para(d.business, 16, bold, ink, 0, 2);
  para(`${d.templateTitle} · גרסה ${d.templateVersion}`, 13, bold, ink, 0, 2);
  para(`הצהרה מס׳ ${d.number}`, 9, font, muted, 0, 10);
  page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 0.6, color: line });
  y -= 8;

  for (const l of answerLines(d.fields, d.acks, d.answers)) {
    if (l.info) { para(l.text, 10, font, ink, 0, 6); continue; }
    para(l.text, 10, l.indent ? font : bold, ink, l.indent ? 16 : 0, 1);
    para(`תשובה: ${l.answer ?? '—'}`, 10, font, ink, l.indent ? 16 : 8, 7);
  }
  if (d.marketingOk !== null) para(`שימוש בתמונות לפרסום: ${d.marketingOk ? 'מסכים/ה' : 'לא מסכים/ה'}`, 10, font, ink, 0, 8);

  y -= 6;
  room(150);
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.6, color: line });
  y -= 6;
  para(CONFIRM_LINE, 10, bold, ink, 0, 6);
  para(`שם מלא: ${d.signerName}`, 11, bold, ink, 0, 4);
  const img = await pdf.embedPng(d.signaturePng);
  const s = Math.min(220 / img.width, 80 / img.height, 1);
  room(img.height * s + 10);
  page.drawImage(img, { x: W - M - img.width * s, y: y - img.height * s, width: img.width * s, height: img.height * s });
  y -= img.height * s + 10;
  para(`נחתם: ${ilDateTime(d.signedAt)} (שעון השרת, ישראל)`, 9, font, muted, 0, 1);
  para(`כתובת IP: ${d.ip || 'לא ידועה'}`, 9, font, muted, 0, 1);
  para(`דפדפן: ${d.userAgent.slice(0, 300) || 'לא ידוע'}`, 8, font, muted, 0, 1);
  para(`קישור: ${d.requestId}`, 8, font, muted, 0, 1);

  const foot = `${d.software} · הנוסח של העסק ובאחריותו · נשמר כפי שנחתם`;
  for (const [i, p] of pdf.getPages().entries()) {
    const v = visual(clean(foot));
    p.drawText(v, { x: W - M - font.widthOfTextAtSize(v, 7), y: M - 14, size: 7, font, color: muted });
    p.drawText(`${i + 1}/${pdf.getPageCount()}`, { x: M, y: M - 14, size: 7, font, color: muted });
  }
  return pdf;
}
