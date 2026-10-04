import type { PDFDocument } from 'pdf-lib';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { P12Signer } from '@signpdf/signer-p12';
import signpdf from '@signpdf/signpdf';
import forge from 'node-forge';

/**
 * Digital signature of documents sent to customers (PAdES-style: adbe.pkcs7.detached inside the PDF).
 * The certificate is the platform's (like other invoicing services), set once in Vercel:
 *   DOC_SIGN_P12_BASE64    the .p12 / .pfx file, base64
 *   DOC_SIGN_P12_PASSWORD  its password
 * Use a certificate from a licensed Israeli certification authority for a legally recognised signature —
 * see REGISTRATION.md. Without these variables the PDF is produced unsigned (and says so).
 */
export function signingConfig(env: Record<string, string | undefined> = process.env): { p12: Buffer; passphrase: string } | null {
  const b64 = (env.DOC_SIGN_P12_BASE64 ?? '').replace(/\s+/g, '');
  if (!b64) return null;
  return { p12: Buffer.from(b64, 'base64'), passphrase: env.DOC_SIGN_P12_PASSWORD ?? '' };
}

/** whose certificate it is and until when — for the settings screen (never the key itself) */
export function certificateInfo(env: Record<string, string | undefined> = process.env): { configured: boolean; subject?: string; validTo?: string; error?: string } {
  const cfg = signingConfig(env);
  if (!cfg) return { configured: false };
  try {
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(cfg.p12.toString('binary'))), cfg.passphrase);
    const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
    const cert = bags[0]?.cert;
    if (!cert) return { configured: false, error: 'אין תעודה בקובץ' };
    const cn = cert.subject.getField('CN')?.value ?? cert.subject.getField('O')?.value ?? '';
    if (cert.validity.notAfter.getTime() < Date.now()) return { configured: false, subject: cn, validTo: cert.validity.notAfter.toISOString(), error: 'פג תוקף התעודה' };
    return { configured: true, subject: cn, validTo: cert.validity.notAfter.toISOString() };
  } catch (e: any) {
    return { configured: false, error: /password|mac/i.test(String(e?.message)) ? 'הסיסמה של התעודה לא נכונה' : 'קובץ התעודה לא תקין' };
  }
}

/** the finished PDF: signed when a certificate is configured, plain otherwise */
export async function signedPdfBytes(pdfDoc: PDFDocument, o: { name: string; reason: string; location?: string; contactInfo?: string }, env: Record<string, string | undefined> = process.env): Promise<{ bytes: Uint8Array; signed: boolean }> {
  const cfg = signingConfig(env);
  if (!cfg || !certificateInfo(env).configured) return { bytes: await pdfDoc.save(), signed: false };
  pdflibAddPlaceholder({
    pdfDoc, reason: o.reason, contactInfo: o.contactInfo ?? '', name: o.name, location: o.location ?? 'Israel',
    signatureLength: 16384, appName: 'Dream Promotion',
  });
  const unsigned = await pdfDoc.save({ useObjectStreams: false });
  const signer = new P12Signer(cfg.p12, { passphrase: cfg.passphrase });
  const signed = await signpdf.sign(Buffer.from(unsigned), signer);
  return { bytes: new Uint8Array(signed), signed: true };
}
