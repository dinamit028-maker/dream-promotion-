/**
 * An invoice to a business ("חשבונית לעסק"): the name on the document, its dealer / company number
 * (עוסק מורשה / ח.פ — 9 digits with the Israeli check digit) and its address.
 * Saved on the sale (so a document issued later still has it) and on the contact (next time it is filled in).
 */
export interface Billing { name: string; dealer: string; street: string; city: string }
export const EMPTY_BILLING: Billing = { name: '', dealer: '', street: '', city: '' };

export const dealerDigits = (v: string) => String(v ?? '').replace(/\D/g, '').slice(0, 9);

/** ת.ז / ע.מ / ח.פ check digit: weights 1,2,1,2… on 9 digits, two-digit products summed, total divisible by 10 */
export function validIsraeliId(v: string): boolean {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d || d.length > 9) return false;
  const p = d.padStart(9, '0');
  if (/^0+$/.test(p)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) { let x = Number(p[i]) * ((i % 2) + 1); if (x > 9) x -= 9; sum += x; }
  return sum % 10 === 0;
}

/** what is wrong with the form, in Hebrew — or null when the invoice can be issued */
export function billingError(b: Billing): string | null {
  if (!b.name.trim()) return 'חסר שם העסק לחשבונית';
  const d = dealerDigits(b.dealer);
  if (d.length !== 9) return 'מספר עוסק / ח.פ — 9 ספרות';
  if (!validIsraeliId(d)) return 'מספר העוסק / ח.פ לא תקין (ספרת הביקורת לא מתאימה) — כדאי לבדוק שוב';
  return null;
}

/** the sale's columns for a billing form (all empty when the sale is not to a business) */
export const billingColumns = (b: Billing | null) => ({
  billing_name: b ? b.name.trim().slice(0, 120) : '', customer_dealer: b ? dealerDigits(b.dealer) : '',
  customer_street: b ? b.street.trim().slice(0, 120) : '', customer_city: b ? b.city.trim().slice(0, 60) : '',
});
