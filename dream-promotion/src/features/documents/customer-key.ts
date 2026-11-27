/**
 * 2.121 — a customer's key: field 1225 of its C100 records (openformat.ts, customerKeyField) and the key of its account in the
 * books (gl_accounts.key, migration 20261128007100 — public.gl_customer_key). The two must be the same key, so that in stage 4ה
 * the B110 accounts written from the books (1403) are the accounts the C100 records point at (1225).
 *
 * Source: the official instructions 1.31 ("הוראות להפקת קבצים במבנה אחיד", 01/05/2009) — field 1225 "מפתח הלקוח אצל המוכר"
 * X(15), §4.3 (p. 12); field 1403 "מפתח החשבון" X(15) of B110, §4.7 (p. 16), unique in the file ("חד חד ערכי"). The rule of
 * WHICH value is the key is ours, not the spec's (the spec only asks that 1225 is an account of the file): the phone, else the
 * name, else 'CASH' — as customerKeyField wrote it before 2.121. Checked against the migration's text 27.11.2026.
 *
 * Exactly the SQL of public.gl_customer_key / public.gl_key_reserved (db-agent, 27.11.2026 — do not change one without the
 * other; tests/openformat-customer-key.test.ts has the examples of tests/sql/books-core.check.sql and of the brain's list):
 *   1. each of the phone and the name (null → '') as the file writes text (isoText, openformat.ts): every run of CR / LF → one
 *      space, then the characters isoText drops (DROP — direction marks and embeddings, zero-width characters, the BOM, Hebrew
 *      points; U+05BE maqaf is kept) removed, then plain spaces trimmed at both ends;
 *   2. the cleaned phone, else the cleaned name, else 'CASH' (the first not empty after step 1);
 *   3. its first 15 characters, trailing spaces trimmed ('' → 'CASH');
 *   4. gl_key_reserved(k) = k ~ '^[0-9]{4}(-[0-9]{1,2})?$' or upper(btrim(k)) = 'BANK' → 'C-' || k, again 15 characters, rtrim.
 * In Postgres left() counts characters (code points — not UTF-16 units as String.slice does), rtrim / btrim remove plain spaces
 * only (not a tab or a non-breaking space), and [0-9] is the ASCII digits. So here: Array.from, / +$/, the ASCII class.
 * A system key (four digits, with "-n" for a location's account, or BANK — the bank, and the unified file's deposit, 420) is never
 * a customer's: a customer whose key looks like one gets "C-" in front.
 * The file writes the key through X(…, 15) (isoText again — nothing left for it to drop, so the 15 characters stay 15).
 */
const left = (s: string, n: number) => Array.from(s).slice(0, n).join('');
const rtrim = (s: string) => s.replace(/ +$/, '');
const btrim = (s: string) => s.replace(/^ +| +$/g, '');

/** a key of the system's own accounts (gl_key_reserved): four digits (a location's: "-n") or BANK */
export const glKeyReserved = (k: string): boolean => /^[0-9]{4}(-[0-9]{1,2})?$/.test(k) || btrim(k).toUpperCase() === 'BANK';

/** the characters isoText drops (openformat.ts DROP — the same class; a test holds the two equal, character by character) */
const DROP = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF\u0591-\u05BD\u05BF-\u05C7]/g;
/** step 1: a phone / a name as the file writes text — CR / LF runs → a space, DROP removed, plain spaces trimmed */
const clean = (s: string | null | undefined) => btrim((s ?? '').replace(/[\r\n]+/g, ' ').replace(DROP, ''));

/** a customer's key (gl_customer_key): the cleaned phone, else the cleaned name, else 'CASH'; 15 characters; "C-" when it looks
 *  like a system key */
export function glCustomerKey(phone: string | null | undefined, name: string | null | undefined): string {
  const ph = clean(phone), nm = clean(name);
  const src = ph || nm || 'CASH';                              // nullif(…, '') — after cleaning
  const k = rtrim(left(src, 15)) || 'CASH';
  return glKeyReserved(k) ? rtrim(left(`C-${k}`, 15)) : k;
}
