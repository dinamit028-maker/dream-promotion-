/**
 * Business-type rules — one place that says what a business may issue and whether it charges VAT.
 * The database enforces the same matrix on every document (entity_doc_types() in migration 20261004003100);
 * tests/finance-engine.test.ts keeps the two in line.
 *   עוסק פטור (exempt dealer) and מלכ"ר / עמותה (non-profit): no VAT, never a tax invoice — 300 / 400 only
 *   עוסק מורשה, חברה בע"מ, שותפות: VAT, every type — 305 / 320 / 330 / 300 / 400
 * 2.95 (migration 20261011005000): both kinds may also issue an order (100), a delivery note (200) and a return note (210) — once
 * the business turned on "selling products" (the database checks the switch: d_documents_goods); goodsDocTypes below.
 */
export type EntityType = 'exempt_dealer' | 'licensed_dealer' | 'company' | 'partnership' | 'nonprofit';

export const ENTITY_TYPES: { id: EntityType; label: string; hint: string }[] = [
  { id: 'licensed_dealer', label: 'עוסק מורשה', hint: 'גובה מע״מ ומפיק חשבוניות מס' },
  { id: 'company', label: 'חברה בע״מ', hint: 'גובה מע״מ ומפיק חשבוניות מס (ח.פ)' },
  { id: 'partnership', label: 'שותפות', hint: 'גובה מע״מ ומפיק חשבוניות מס' },
  { id: 'exempt_dealer', label: 'עוסק פטור', hint: 'לא גובה מע״מ — מפיק קבלות וחשבוניות עסקה בלבד' },
  { id: 'nonprofit', label: 'עמותה / מלכ״ר', hint: 'לא גובה מע״מ — מפיק קבלות וחשבוניות עסקה בלבד' },
];

const KNOWN = new Set<string>(ENTITY_TYPES.map((e) => e.id));
/** the explicit entity, else the register's exempt / licensed switch (businesses from before 2.51) */
export function entityOf(entity: string | null | undefined, businessType?: string | null): EntityType {
  if (entity && KNOWN.has(entity)) return entity as EntityType;
  return businessType === 'exempt' ? 'exempt_dealer' : 'licensed_dealer';
}
export const chargesVat = (e: EntityType) => e !== 'exempt_dealer' && e !== 'nonprofit';
/** the register's switch for an entity (register_settings.business_type) */
export const businessTypeOf = (e: EntityType): 'exempt' | 'licensed' => (chargesVat(e) ? 'licensed' : 'exempt');

/** document types in the order the screens offer them */
export const allowedDocTypes = (e: EntityType): number[] => (chargesVat(e) ? [305, 320, 330, 300, 400] : [300, 400]);
export const canIssue = (e: EntityType, docType: number) => allowedDocTypes(e).includes(docType);
/** the document of a paid register sale */
export const saleDocType = (e: EntityType) => (chargesVat(e) ? 320 : 400);
/** the document an accepted quote becomes */
export const invoiceDocType = (e: EntityType) => (chargesVat(e) ? 305 : 300);

export const DOC_INFO: Record<number, { label: string; what: string; receivable: boolean; receipt: boolean; tax: boolean }> = {
  305: { label: 'חשבונית מס', what: 'חשבונית על עסקה, התשלום יגיע אחר כך (נכנס לחייבים)', receivable: true, receipt: false, tax: true },
  320: { label: 'חשבונית מס / קבלה', what: 'חשבונית ותשלום יחד — שולם עכשיו', receivable: false, receipt: true, tax: true },
  330: { label: 'חשבונית מס זיכוי', what: 'ביטול מלא או חלקי של חשבונית מס', receivable: false, receipt: false, tax: true },
  300: { label: 'חשבונית עסקה', what: 'דרישת תשלום (לא חשבונית מס) — נכנסת לחייבים', receivable: true, receipt: false, tax: false },
  400: { label: 'קבלה', what: 'אישור על תשלום שהתקבל', receivable: false, receipt: true, tax: false },
  // 2.95 (T10): a business that sells products — not tax documents; in the unified file with their own codes
  100: { label: 'הזמנה', what: 'הזמנה של לקוח — לא מסמך מס, לא יורדת מהמלאי. ממנה מפיקים תעודת משלוח או חשבונית', receivable: false, receipt: false, tax: false },
  200: { label: 'תעודת משלוח', what: 'הסחורה יצאה ללקוח (יורדת מהמלאי). ממנה מפיקים חשבונית בלחיצה', receivable: false, receipt: false, tax: false },
  210: { label: 'תעודת החזרה', what: 'סחורה שחזרה מתעודת משלוח (חוזרת למלאי)', receivable: false, receipt: false, tax: false },
};
/** the goods documents the composer offers once "selling products" is on (a return note is made from its delivery note) */
export const goodsDocTypes = (sellsProducts: boolean): number[] => (sellsProducts ? [100, 200] : []);

/** how the issuer is named on its documents: "עוסק פטור 123456789", "ח.פ 514…", never "עוסק מורשה" for an exempt dealer */
export function issuerIdLine(i: { entityType?: string | null; dealerNumber?: string; companyNumber?: string | null }, businessType?: string | null): string {
  const e = entityOf(i.entityType, businessType);
  const dealer = i.dealerNumber ?? '';
  switch (e) {
    case 'company': return i.companyNumber && i.companyNumber !== dealer ? `ח.פ ${i.companyNumber} · עוסק מורשה ${dealer}` : `ח.פ ${i.companyNumber || dealer}`;
    case 'exempt_dealer': return `עוסק פטור ${dealer}`;
    case 'nonprofit': return `ע״ר / מלכ״ר ${i.companyNumber || dealer}`;
    case 'partnership': return `שותפות · עוסק מורשה ${dealer}`;
    default: return `עוסק מורשה ${dealer}`;
  }
}
