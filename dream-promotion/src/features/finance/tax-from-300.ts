/**
 * 2.121 — answer 19 of stage 4 (docs/ita-registration/STAGE4_PLAN_HE.md, the owner, 27.11.2026): a licensed dealer issues a tax
 * invoice (305) FROM a transaction invoice (300) — "הפקת חשבונית מס" in the 300's view. The 305 is the 300 as it was (its lines,
 * discount, VAT and total — the 300's own fields, never computed again, as a credit invoice mirrors its invoice — creditFor), the
 * same customer, dated today (d_documents_issue_day), and linked to the 300; in the books it closes 1310 against the customer, who
 * is charged once.
 * THE LINK (which field of documents carries it) is the database's contract — db-agent, migration 7100. Until it is set here
 * (TAX_FROM_300_LINK), the button is not shown: 'base' — base_doc_type 300 / base_doc_number (as a credit invoice names its
 * invoice); 'paid' — paid_document_id (as a receipt names the invoice it pays).
 * VAT (vat.ts / the business's settings): the 305 carries the 300's rate; when the business's rate today is another one, the 305
 * is not issued from here — a question to the accountant (CLAUDE.md: a past rate is never changed by the app).
 * Stock: the 300 already moved it — the database moves nothing for a 305 made from a 300 (documents_after_insert of 7100); the
 * lines are the 300's exactly (with their items, for the reports).
 */
import { DOC_LABEL, docNumberLabel } from '@/features/documents/documents';
import type { Doc } from '@/features/documents/openformat';
import { chargesVat, type EntityType } from './rules';
import type { ComposeResult, NewDoc } from './compose';

export type TaxFrom300Link = 'base' | 'paid';
/** the database's contract (db-agent, migration 7100 — documents_validate: base_doc_type 300 + its number, fields 1256 / 1257);
 *  the screens offer it only once 7100 is in the database (booksReady) — before it the old check refuses a 305 with a base 300 */
export const TAX_FROM_300_LINK: TaxFrom300Link | null = 'base';
/** one 305 per 300: retries and two devices share it */
export const taxFrom300Key = (id: string) => `tax300:${id}`;

const ag = (n: number) => Math.round(n * 100);
const sh = (a: number) => a / 100;

export const TAX_FROM_300_NOT_VAT = 'חשבונית מס מפיק עוסק מורשה / חברה — לא עוסק פטור.';
export const TAX_FROM_300_RATE = 'שיעור המע״מ של חשבון העסקה שונה מהשיעור בהגדרות היום — לא מפיקים מכאן; לבירור עם רואה החשבון.';

/** the 305 of a 300 — Hebrew errors, none when fine (the database checks again) */
export function composeTaxFrom300(base: Doc, o: { entity: EntityType; vatRate: number; docDate: string; link: TaxFrom300Link; cancelled?: boolean; notes?: string }): ComposeResult {
  const e: string[] = [];
  if (!chargesVat(o.entity)) e.push(TAX_FROM_300_NOT_VAT);
  if (base.docType !== 300) e.push('חשבונית מס מפיקים כאן מחשבון עסקה (300) בלבד.');
  if (o.cancelled) e.push('חשבון העסקה בוטל — לא מפיקים ממנו חשבונית מס.');
  const rates = new Set(base.lines.map((l) => Number(l.vatRate)));
  if (rates.size !== 1 || !rates.has(Number(o.vatRate))) e.push(TAX_FROM_300_RATE);
  if (!(ag(base.total) > 0)) e.push('בחשבון העסקה אין סכום לחיוב.');
  if (e.length) return { ok: false, errors: e };
  const ref = `${DOC_LABEL[300]} מס׳ ${docNumberLabel(base)}`;
  const notes = [`על פי ${ref}`, (o.notes ?? '').trim()].filter(Boolean).join(' — ').slice(0, 1000);
  const doc: NewDoc = {
    docType: 305, docDate: o.docDate, customerName: base.customerName, customerPhone: base.customerPhone ?? '', customerDealer: base.customerDealer ?? '',
    customerStreet: base.customerStreet ?? '', customerCity: base.customerCity ?? '',
    beforeDiscount: base.beforeDiscount, discount: base.discount, afterDiscount: base.afterDiscount, vatAmount: base.vatAmount, total: base.total,
    // the 300's lines as they were (never "restock" — that is a credit's)
    lines: base.lines.map(({ restock: _r, ...l }) => l),
    payments: [], issuedBy: '', notes,
    ...(o.link === 'base' ? { baseDocType: 300, baseDocNumber: base.docNumber } : {}),
  };
  const rate = Number(o.vatRate);
  return { ok: true, doc, totals: { subtotal: base.total, discount: base.discount, beforeDiscount: base.beforeDiscount, discountExVat: base.discount,
    afterDiscount: base.afterDiscount, vatRate: rate, vatAmount: base.vatAmount, total: sh(ag(base.total)) } };
}
/** the issue's extra of the link 'paid' (paid_document_id); 'base' is on the document itself */
export const taxFrom300Extra = (link: TaxFrom300Link, baseId: string) => (link === 'paid' ? { paidDocumentId: baseId } : {});
