/**
 * Pilot tracking for the super admin: how far each business got — only dates (the first row of each kind), never a name,
 * a phone, an amount or a document's content. Order = the path a new business walks.
 */
export const MILESTONES = [
  { key: 'created', label: 'העסק נפתח' },
  { key: 'onboarded', label: 'הגדרת העסק הושלמה' },
  { key: 'firstLead', label: 'לקוח ראשון' },
  { key: 'firstAppointment', label: 'תור ראשון' },
  { key: 'firstSale', label: 'מכירה ראשונה' },
  { key: 'firstDocument', label: 'מסמך ראשון' },
  { key: 'firstExpense', label: 'הוצאה ראשונה' },
  { key: 'firstQuote', label: 'הצעת מחיר ראשונה' },
] as const;
export type MilestoneKey = (typeof MILESTONES)[number]['key'];
export type Milestones = Partial<Record<MilestoneKey, string | null>>;

/** the table and the time column of each "first …" (the first row of the business, by that column) */
export const FIRST_OF: Record<Exclude<MilestoneKey, 'created' | 'onboarded'>, { table: string; column: string }> = {
  firstLead: { table: 'leads', column: 'created_at' },
  firstAppointment: { table: 'appointments', column: 'created_at' },
  firstSale: { table: 'sales', column: 'created_at' },
  firstDocument: { table: 'documents', column: 'issued_at' },
  firstExpense: { table: 'expenses', column: 'created_at' },
  firstQuote: { table: 'quotes', column: 'created_at' },
};

/** "5 / 8" — how many milestones a business reached */
export const milestoneCount = (m: Milestones) => MILESTONES.filter((x) => Boolean(m[x.key])).length;
