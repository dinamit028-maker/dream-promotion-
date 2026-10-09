/**
 * Health declarations (docs/CLIENT FILE ENGINEERING HE.md §5). Pure rules, shared by the editor, the customer's page and
 * the server (which checks again — never trusting the page): the shape of a template's fields, what the customer must
 * answer, and the answers that are kept.
 * The wording is the clinic's (checked by its lawyer): nothing here adds, removes or changes a word of it.
 */
export type FollowUpType = 'text' | 'longtext' | 'date' | 'choice';
export type FieldType = 'yesno' | 'text' | 'longtext' | 'choice' | 'multi' | 'date' | 'meds' | 'id_number' | 'phone' | 'email' | 'heading' | 'info' | 'marketing';
export interface FollowUp { key: string; type: FollowUpType; label: string; required: boolean; options?: string[] }
export interface Field {
  key: string; type: FieldType; label: string; required: boolean; options?: string[];
  /** a grey example inside an empty text box (the clinic's, e.g. "אינסטגרם, המלצה...") — never an answer */
  placeholder?: string;
  /** yes/no only: fields that open under the question when the answer is showFollowUpsWhen */
  followUps?: FollowUp[]; showFollowUpsWhen?: 'yes' | 'no';
  /** yes/no only: "כן" is marked for the owner and the practitioner (a contraindication) — the wording is unchanged */
  flag?: boolean;
}
export type Answer = string | string[];
export type Answers = Record<string, Answer>;

export const FIELD_TYPES: { id: FieldType; label: string }[] = [
  { id: 'yesno', label: 'כן / לא' },
  { id: 'text', label: 'טקסט קצר' },
  { id: 'longtext', label: 'טקסט ארוך' },
  { id: 'choice', label: 'בחירה אחת' },
  { id: 'multi', label: 'בחירה מרובה' },
  { id: 'date', label: 'תאריך' },
  { id: 'meds', label: 'רשימת תרופות' },
  { id: 'id_number', label: 'תעודת זהות' },
  { id: 'phone', label: 'טלפון' },
  { id: 'email', label: 'אימייל' },
  { id: 'heading', label: 'כותרת (בלי תשובה)' },
  { id: 'info', label: 'פסקת טקסט (בלי תשובה)' },
  { id: 'marketing', label: 'הסכמה לשימוש בתמונות לפרסום' },
];
export const FOLLOW_UP_TYPES: { id: FollowUpType; label: string }[] = [
  { id: 'text', label: 'טקסט קצר' }, { id: 'longtext', label: 'טקסט ארוך' }, { id: 'date', label: 'תאריך' }, { id: 'choice', label: 'בחירה אחת' },
];
/** a starting label the owner may change (the clinic's wording wins) */
export const MARKETING_LABEL = 'אני מסכים/ה לשימוש בתמונות שלי לפרסום (ברשתות, באתר ובחומרי שיווק).';
/** the line above every signature (the doc, §5.1ב) */
export const CONFIRM_LINE = 'קראתי את ההצהרה, התשובות נכונות ומלאות, ואני מאשר/ת אותן בחתימתי.';

export const LIMITS = { fields: 200, label: 1000, options: 30, option: 200, acks: 50, ack: 1000, text: 500, longtext: 3000, meds: 3000, title: 200 } as const;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** text the customer reads and does not answer: a heading or a paragraph */
export const isTextOnly = (t: FieldType) => t === 'info' || t === 'heading';

/** an Israeli ID number: up to 9 digits (padded with zeros) and a valid check digit — the 9 digits, or null */
export function israeliId(v: string): string | null {
  const d = v.replace(/[\s-]/g, '');
  if (!/^\d{5,9}$/.test(d)) return null;
  const id = d.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) { let x = Number(id[i]) * ((i % 2) + 1); if (x > 9) x -= 9; sum += x; }
  return sum % 10 === 0 && id !== '000000000' ? id : null;
}
/** an email address (simple shape check, lower-cased) — or null */
export function emailAddress(v: string): string | null {
  const e = v.trim().toLowerCase();
  return e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}
/** the field types a grey example may be shown in */
export const TAKES_PLACEHOLDER: FieldType[] = ['text', 'longtext', 'meds', 'phone', 'email'];

/** an Israeli phone (mobile or landline), as digits starting with 0 — or null */
export function israeliPhone(v: string): string | null {
  let d = v.replace(/[\s()-]/g, '');
  if (d.startsWith('+972')) d = `0${d.slice(4)}`; else if (d.startsWith('972') && d.length >= 11) d = `0${d.slice(3)}`;
  return /^0\d{8,9}$/.test(d) ? d : null;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const cleanOptions = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((o) => str(o, LIMITS.option)).filter(Boolean))].slice(0, LIMITS.options) : []);

/** a template's fields as the editor sent them → the stored shape, or the first problem (in Hebrew) */
export function cleanFields(v: unknown): { ok: true; fields: Field[] } | { ok: false; error: string } {
  if (!Array.isArray(v)) return { ok: false, error: 'רשימת השדות לא תקינה.' };
  if (v.length > LIMITS.fields) return { ok: false, error: `עד ${LIMITS.fields} שדות להצהרה.` };
  const keys = new Set<string>();
  const out: Field[] = [];
  const takeKey = (k: unknown) => { const s = typeof k === 'string' ? k : ''; if (!KEY.test(s) || keys.has(s)) return null; keys.add(s); return s; };
  for (const [i, raw] of v.entries()) {
    const f = (raw ?? {}) as Record<string, unknown>;
    const n = i + 1;
    const type = FIELD_TYPES.find((t) => t.id === f.type)?.id;
    if (!type) return { ok: false, error: `שדה ${n}: סוג לא מוכר.` };
    const key = takeKey(f.key);
    if (!key) return { ok: false, error: `שדה ${n}: מזהה חסר או כפול.` };
    const label = str(f.label, LIMITS.label);
    if (!label) return { ok: false, error: `שדה ${n}: חסר נוסח.` };
    const field: Field = { key, type, label, required: isTextOnly(type) || type === 'marketing' ? false : f.required !== false };
    const ph = str(f.placeholder, 100);
    if (ph && TAKES_PLACEHOLDER.includes(type)) field.placeholder = ph;
    if (type === 'choice' || type === 'multi') {
      field.options = cleanOptions(f.options);
      if (field.options.length < 2) return { ok: false, error: `שדה ${n}: צריך לפחות שתי אפשרויות.` };
    }
    if (type === 'yesno') {
      field.showFollowUpsWhen = f.showFollowUpsWhen === 'no' ? 'no' : 'yes';
      if (f.flag === true) field.flag = true;
      const ups: FollowUp[] = [];
      for (const [j, u0] of (Array.isArray(f.followUps) ? f.followUps : []).entries()) {
        const u = (u0 ?? {}) as Record<string, unknown>;
        const ut = FOLLOW_UP_TYPES.find((t) => t.id === u.type)?.id;
        const uk = takeKey(u.key);
        const ul = str(u.label, LIMITS.label);
        if (!ut || !uk || !ul) return { ok: false, error: `שדה ${n}, שדה המשך ${j + 1}: חסר סוג, מזהה או נוסח.` };
        const up: FollowUp = { key: uk, type: ut, label: ul, required: u.required !== false };
        if (ut === 'choice') { up.options = cleanOptions(u.options); if (up.options.length < 2) return { ok: false, error: `שדה ${n}, שדה המשך ${j + 1}: צריך לפחות שתי אפשרויות.` }; }
        ups.push(up);
      }
      if (ups.length) field.followUps = ups.slice(0, 10);
    }
    out.push(field);
  }
  return { ok: true, fields: out };
}

export function cleanAcks(v: unknown): { ok: true; acks: string[] } | { ok: false; error: string } {
  if (!Array.isArray(v)) return { ok: false, error: 'רשימת האישורים לא תקינה.' };
  const acks = v.map((a) => str(a, LIMITS.ack)).filter(Boolean);
  if (acks.length > LIMITS.acks) return { ok: false, error: `עד ${LIMITS.acks} אישורים להצהרה.` };
  return { ok: true, acks };
}

/** a declaration that can be approved: at least one question or one confirmation (a paragraph alone is not one) */
export const canApprove = (fields: Field[], acks: string[]) => acks.length > 0 || fields.some((f) => !isTextOnly(f.type));

/** do the follow-ups of this yes/no question show, for this answer? (no answer yet: no) */
export const followUpsOpen = (f: Field, a: Answer | undefined) => f.type === 'yesno' && Boolean(f.followUps?.length) && a === (f.showFollowUpsWhen ?? 'yes');

/** every key the customer is asked, in order, with whether it must be answered now */
export function asked(fields: Field[], answers: Answers): { key: string; label: string; required: boolean; type: FieldType | FollowUpType; options?: string[] }[] {
  const out: { key: string; label: string; required: boolean; type: FieldType | FollowUpType; options?: string[] }[] = [];
  for (const f of fields) {
    if (isTextOnly(f.type)) continue;
    out.push({ key: f.key, label: f.label, required: f.required, type: f.type, options: f.options });
    if (followUpsOpen(f, answers[f.key])) for (const u of f.followUps!) out.push({ key: u.key, label: u.label, required: u.required, type: u.type, options: u.options });
  }
  return out;
}

/** "8 מתוך 15 נענו": the required questions open now, and how many have a VALID answer (a half-typed email is not one) */
export function progress(fields: Field[], answers: Answers): { done: number; total: number } {
  const req = asked(fields, answers).filter((q) => q.required);
  return { done: req.filter((q) => cleanOne(q.type, q.options, answers[q.key]) !== undefined).length, total: req.length };
}

/** one answer, by the field's type: what is kept, or undefined when it is not a valid answer */
function cleanOne(type: FieldType | FollowUpType, options: string[] | undefined, a: unknown): Answer | undefined {
  if (a == null) return undefined;
  switch (type) {
    case 'yesno': case 'marketing': return a === 'yes' || a === 'no' ? a : undefined;
    case 'text': return typeof a === 'string' ? str(a, LIMITS.text) || undefined : undefined;
    case 'longtext': return typeof a === 'string' ? str(a, LIMITS.longtext) || undefined : undefined;
    case 'meds': return typeof a === 'string' ? str(a, LIMITS.meds) || undefined : undefined;
    case 'id_number': return typeof a === 'string' ? israeliId(a) ?? undefined : undefined;
    case 'phone': return typeof a === 'string' ? israeliPhone(a) ?? undefined : undefined;
    case 'email': return typeof a === 'string' ? emailAddress(a) ?? undefined : undefined;
    case 'date': return typeof a === 'string' && DATE.test(a) && !Number.isNaN(Date.parse(a)) ? a : undefined;
    case 'choice': return typeof a === 'string' && options?.includes(a) ? a : undefined;
    case 'multi': {
      if (!Array.isArray(a)) return undefined;
      const picked = [...new Set(a.filter((x): x is string => typeof x === 'string' && Boolean(options?.includes(x))))];
      return picked.length ? options!.filter((o) => picked.includes(o)) : undefined;
    }
    default: return undefined;
  }
}

/**
 * The customer's answers checked against the template: every required question answered by the customer (nothing is
 * ever pre-selected), every open follow-up filled, every confirmation ticked. What is kept: only answers to questions
 * that were asked — the follow-ups of a question answered the other way are dropped, never sent on.
 */
export function checkAnswers(fields: Field[], acks: string[], answers: unknown, ackTicks: unknown):
  { ok: true; answers: Answers; marketingOk: boolean } | { ok: false; missing: string; message: string } {
  const given = (answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {}) as Record<string, unknown>;
  const kept: Answers = {};
  for (const f of fields) {
    if (isTextOnly(f.type)) continue;
    const a = cleanOne(f.type, f.options, given[f.key]);
    if (a === undefined) {
      if (f.required) {
        const said = given[f.key];
        const typed = typeof said === 'string' && said.trim() !== '';
        const message = f.type === 'id_number' && typed ? `מספר תעודת הזהות לא תקין: ${f.label}`
          : f.type === 'phone' && typed ? `מספר הטלפון לא תקין: ${f.label}`
            : f.type === 'email' && typed ? `כתובת האימייל לא תקינה: ${f.label}` : `לא נענתה השאלה: ${f.label}`;
        return { ok: false, missing: f.key, message };
      }
      continue;
    }
    kept[f.key] = a;
    if (followUpsOpen(f, a)) {
      for (const u of f.followUps!) {
        const b = cleanOne(u.type, u.options, given[u.key]);
        if (b === undefined) {
          if (u.required) return { ok: false, missing: u.key, message: `חסר פירוט: ${u.label}` };
          continue;
        }
        kept[u.key] = b;
      }
    }
  }
  const ticks = Array.isArray(ackTicks) ? ackTicks : [];
  const first = acks.findIndex((_, i) => ticks[i] !== true);
  if (first >= 0) return { ok: false, missing: `ack_${first}`, message: `צריך לסמן: ${acks[first]}` };
  const marketingOk = fields.some((f) => f.type === 'marketing' && kept[f.key] === 'yes');
  return { ok: true, answers: kept, marketingOk };
}

/** the lines of a signed declaration, as the PDF and the card show them: each question with the answer chosen */
export function answerLines(fields: Field[], acks: string[], answers: Answers): { text: string; answer?: string; indent?: boolean; info?: boolean; heading?: boolean; flagged?: boolean }[] {
  const show = (a: Answer | undefined) => (a === undefined ? '—' : Array.isArray(a) ? a.join(', ') : a === 'yes' ? 'כן' : a === 'no' ? 'לא' : a);
  const out: { text: string; answer?: string; indent?: boolean; info?: boolean; heading?: boolean; flagged?: boolean }[] = [];
  for (const f of fields) {
    if (f.type === 'heading') { out.push({ text: f.label, heading: true }); continue; }
    if (f.type === 'info') { out.push({ text: f.label, info: true }); continue; }
    out.push({ text: f.label, answer: show(answers[f.key]), ...(f.flag && answers[f.key] === 'yes' ? { flagged: true } : {}) });
    if (followUpsOpen(f, answers[f.key])) {
      for (const u of f.followUps!) if (answers[u.key] !== undefined) out.push({ text: u.label, answer: show(answers[u.key]), indent: true });
    }
  }
  for (const a of acks) out.push({ text: a, answer: 'סומן ✓' });
  return out;
}

/** the questions marked for attention (a contraindication) that the customer answered "כן" — their wording, in order */
export const flagged = (fields: Field[], answers: Answers) => fields.filter((f) => f.type === 'yesno' && f.flag && answers[f.key] === 'yes').map((f) => f.label);

/** a new field's key (the editor): unique among the template's keys */
export function newKey(fields: Field[], base = 'q'): string {
  const used = new Set(fields.flatMap((f) => [f.key, ...(f.followUps ?? []).map((u) => u.key)]));
  let i = used.size + 1;
  while (used.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

/** a declaration is valid on a day when it has no end, or its end is that day or later (Israeli calendar dates) */
export const validOn = (validUntil: string | null, day: string) => validUntil === null || validUntil >= day;

export type TemplateStatus = 'draft' | 'approved' | 'archived';
export const STATUS_LABEL: Record<TemplateStatus, string> = { draft: 'טיוטה', approved: 'מאושרת', archived: 'בארכיון' };
export type RequestStatus = 'sent' | 'opened' | 'signed' | 'expired' | 'cancelled';
export const REQUEST_LABEL: Record<RequestStatus, string> = { sent: 'נשלח', opened: 'נפתח', signed: 'נחתם', expired: 'פג תוקף', cancelled: 'בוטל' };
/** a link past its time is "פג תוקף" also before anything marked it so */
export const requestState = (r: { status: RequestStatus; expires_at: string }, now = Date.now()): RequestStatus =>
  (r.status === 'sent' || r.status === 'opened') && Date.parse(r.expires_at) <= now ? 'expired' : r.status;

/** the WhatsApp message with the link (the business's name and the customer's first name) */
export function declarationMessage(business: string, firstName: string, link: string, count: number): string {
  const hi = firstName ? `היי ${firstName}, ` : 'היי, ';
  const what = count > 1 ? `${count} הצהרות בריאות` : 'הצהרת בריאות';
  return `${hi}לפני הטיפול ב${business || 'קליניקה'} נשמח שתמלא/י ${what} ותחתום/י בטלפון:\n${link}\nהקישור תקף ל-7 ימים.`;
}
export const firstName = (name: string) => (name || '').trim().split(/\s+/)[0] ?? '';

/**
 * The booking warning (§5.4): does this customer have a valid declaration for this appointment? The appointment's service
 * is matched to one of the clinic's treatment types by name ("לייזר רגליים" → "לייזר"); then a declaration of that type,
 * or a general one, counts. A service no type matches: any valid declaration counts. Days are Israeli calendar dates.
 */
export function declarationGap(
  serviceName: string, day: string,
  types: { id: string; name: string }[],
  signed: { template_types: string[]; valid_until: string | null }[],
): { ok: true } | { ok: false; type: string | null } {
  const s = serviceName.trim().toLowerCase();
  const type = s ? [...types].sort((a, b) => b.name.length - a.name.length).find((t) => t.name.trim() && s.includes(t.name.trim().toLowerCase())) ?? null : null;
  const valid = signed.filter((d) => validOn(d.valid_until, day));
  const ok = type ? valid.some((d) => !d.template_types.length || d.template_types.includes(type.id)) : valid.length > 0;
  return ok ? { ok: true } : { ok: false, type: type?.name ?? null };
}
