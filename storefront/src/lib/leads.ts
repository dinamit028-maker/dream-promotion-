/**
 * A request from the site (2.102, migration 20261017005400): "בקשת הצעת מחיר" of a product sold by a quote, or the contact form.
 * It becomes a contact in the business's leads (sf_lead_request), and the business's server sends it on to the person responsible
 * on WhatsApp. What the shopper typed is checked here first — the same rules as sf_lead_request, which checks it all again — so
 * the form says what to fix at once. Pure, no import (tests/unit/leads.test.ts): the forms carry nothing else to the browser.
 */
export type LeadKind = 'quote' | 'contact';
export interface LeadInput {
  kind: LeadKind;
  /** made by the shopper's browser for this one request: sending it again (a retry, a double tap) is the same request */
  request: string;
  item: string | null;
  name: string; phone: string; email: string; qty: string; topic: string; notes: string; model: string; page: string;
}
export type LeadField = 'name' | 'phone' | 'email' | 'qty' | 'topic' | 'notes' | 'model';
export type LeadRead = { ok: true; input: LeadInput } | { ok: false; error: 'bad_request' } | { ok: false; error: 'details'; fields: LeadField[] };

/** what to fix, under each field */
export const FIELD_ERRORS: Record<LeadField, string> = {
  name: 'נא לכתוב שם (2–80 תווים).',
  phone: 'נא לכתוב מספר טלפון תקין.',
  email: 'כתובת האימייל לא תקינה.',
  qty: 'הכמות צריכה להיות מספר שלם, מ-1 ומעלה.',
  topic: 'הנושא ארוך מדי.',
  notes: 'ההודעה ארוכה מדי (עד 1,000 תווים).',
  model: 'קוד הדגם לא תקין.',
};
/** the answer of a request that was not recorded */
export const LEAD_ERRORS: Record<string, string> = {
  bad_request: 'משהו השתבש. נסו שוב.',
  bot: 'משהו השתבש. נסו שוב.',
  rate: 'נשלחו הרבה פניות בזמן קצר. נסו שוב בעוד כמה דקות.',
  too_many: 'נשלחו הרבה פניות בזמן קצר. נסו שוב בעוד כמה דקות.',
  store: 'האתר לא מקבל פניות כרגע.',
  item: 'אי אפשר לבקש הצעת מחיר על המוצר הזה כרגע.',
  details: 'יש פרטים שצריך לתקן.',
  error: 'לא הצלחנו לשלוח. נסו שוב בעוד רגע.',
};
export const LEAD_SENT: Record<LeadKind, string> = {
  quote: 'הבקשה התקבלה. נחזור אליכם עם הצעת מחיר בהקדם.',
  contact: 'הפנייה התקבלה. נחזור אליכם בהקדם.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** a model's code as the contact form takes it from its address (?design=bag-032) — letters, digits, ".", "_", "/", "-" */
export const MODEL = /^[A-Za-z0-9א-ת][A-Za-z0-9א-ת ._/-]{0,79}$/;
const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const line = (v: unknown) => text(v).replace(/\s+/g, ' ').trim();

/** a phone the business can call back: 050-1234567, +972 50 123 4567, 03-1234567, or international (+…) — the checkout's rule */
export function phoneOk(raw: string): boolean {
  let p = raw.replace(/[^0-9+]/g, '');
  if (/^\+?972\d{8,9}$/.test(p)) p = p.replace(/^\+?972/, '0');
  return /^0\d{8,9}$/.test(p) || /^\+\d{9,15}$/.test(p);
}

/** a request's body → what goes to the database, or what to fix */
export function readLead(body: Record<string, unknown>): LeadRead {
  const kind = body.kind === 'quote' || body.kind === 'contact' ? body.kind : null;
  const request = text(body.request);
  const item = kind === 'quote' ? text(body.item) : '';
  if (!kind || !UUID.test(request) || (kind === 'quote' && !UUID.test(item))) return { ok: false, error: 'bad_request' };
  const input: LeadInput = {
    kind, request: request.toLowerCase(), item: kind === 'quote' ? item.toLowerCase() : null,
    name: line(body.name), phone: line(body.phone), email: line(body.email).toLowerCase(), qty: line(body.qty).replace(/[,\s]/g, ''),
    topic: line(body.topic), notes: text(body.notes).replace(/\r\n/g, '\n').trim(), model: kind === 'contact' ? line(body.model) : '',
    page: line(body.page),
  };
  const fields: LeadField[] = [];
  if (input.name.length < 2 || input.name.length > 80) fields.push('name');
  if (!phoneOk(input.phone)) fields.push('phone');
  if (input.email && (input.email.length > 120 || !EMAIL.test(input.email))) fields.push('email');
  if (input.qty && (!/^\d{1,8}$/.test(input.qty) || Number(input.qty) < 1 || Number(input.qty) > 10_000_000)) fields.push('qty');
  if (input.topic.length > 60) fields.push('topic');
  if (input.notes.length > 1000) fields.push('notes');
  if (input.model && !MODEL.test(input.model)) fields.push('model');
  if (fields.length) return { ok: false, error: 'details', fields };
  if (!/^\/[^\s]*$/.test(input.page) || input.page.length > 300) input.page = '';
  return { ok: true, input };
}

/** the topics a contact form offers ("סורסינג ומוצרים, אריזה למותג, אחר" in the section's settings), at most 6 */
export const topicsOf = (s: string) => [...new Set(s.split(/[,\n]/).map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length <= 60))].slice(0, 6);
