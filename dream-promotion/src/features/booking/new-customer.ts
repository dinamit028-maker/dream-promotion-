import { phoneDigits } from '@/features/crm/crm';

/**
 * The customer of a new appointment: an existing lead (the same phone — or, with no phone typed, the same name), else a new one.
 * 2.109: a calendar member ("יומן ולידים") never opens a new customer without a phone (the owner of the system, 28.10.2026) —
 * the database refuses it too (a_leads_calendar_phone, migration 20261028006000). An existing customer is chosen as before.
 */
type LeadLike = { id: string; name: string; phone: string };
export function matchLead<T extends LeadLike>(leads: T[], c: { name: string; phone: string }): T | undefined {
  const digits = phoneDigits(c.phone);
  return leads.find((l) => digits && phoneDigits(l.phone) === digits) ?? leads.find((l) => !c.phone.trim() && l.name === c.name.trim());
}

/** a phone that can be called: at least 9 digits */
export const callablePhone = (p: string) => phoneDigits(p).length >= 9;

/** what stops saving the customer, or null */
export function customerProblem(leads: LeadLike[], c: { name: string; phone: string }, phoneRequired: boolean): string | null {
  if (!c.name.trim()) return 'חסר שם הלקוח/ה.';
  if (!phoneRequired || matchLead(leads, c)) return null; // everyone else: as before 2.109
  if (!c.phone.trim()) return 'לקוח/ה חדש/ה נשמר/ת רק עם מספר טלפון.';
  if (!callablePhone(c.phone)) return 'מספר הטלפון לא שלם.';
  return null;
}
