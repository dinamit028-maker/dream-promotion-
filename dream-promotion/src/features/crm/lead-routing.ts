import { phoneDigits, waLink } from './crm';
import { ilPhone, type MappedLead } from './meta-leads';
import { formatIL } from '@/lib/il-time';

/**
 * Lead departments (2.99): which department a new lead from a Meta form belongs to, who on the team gets it, and the five
 * values of the WhatsApp template (NEW_LEAD_TEMPLATE). Pure (no database, no network) — tested on its own (tests/lead-routing.test.ts).
 * The number of the business (Dream's WhatsApp number) writes to the TEAM only: the recipient is always a person of
 * lead_staff — never a customer's phone (the customer's phone is only a value inside the message).
 */

/**
 * The approved template: 5 values — {{1}} department, {{2}} name, {{3}} phone, {{4}} the form's details, {{5}} a wa.me link.
 * Its category in Meta must be UTILITY ("שירות ציבורי"): Meta may not deliver a MARKETING template to a person who has not
 * written to the number in the last 24 hours. new_lead, which Meta made MARKETING, was accepted and never arrived (12.10.2026);
 * lead_assigned is the same 5 values as UTILITY (2.100.2).
 */
export const NEW_LEAD_TEMPLATE = { name: 'lead_assigned', language: 'he', params: 5 } as const;
/** {{4}}: one line, at most this long */
export const DETAILS_MAX = 900;
/** a lead older than this is assigned but not sent (a Page's first sync brings a month back) */
export const FRESH_HOURS = 24;
export const NO_DEPARTMENT = 'ללא מחלקה';
export const WA_NOT_CONNECTED = 'וואטסאפ לא מחובר';

export type RuleKind = 'form' | 'campaign' | 'answer';
export type DeptRule = { kind: RuleKind; formId?: string; formName?: string; campaign?: string; question?: string; answer?: string };
export type RoutingDept = { id: string; name: string; staffId: string; position: number; rules: DeptRule[] };
export type LeadFacts = {
  formId: string; formName: string; campaignId: string; campaignName: string;
  fields: { key: string; label: string; values: string[] }[];
};
export type Routed = {
  departmentId: string | null; departmentName: string; staffId: string | null;
  /** why — shown on the contact ("טופס: …"); empty with no department */
  by: string;
  /** no department matched and the business set a default recipient */
  viaDefault: boolean;
};

/** "איזה טיפול מעניין אותך?" ~ "איזה_טיפול_מעניין_אותך" ~ " איזה  טיפול מעניין אותך " — case, "_", spaces and a closing mark aside */
export function norm(s: string | null | undefined): string {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/[_\s]+/g, ' ').trim().replace(/[\s?？!.:;,"'״׳]+$/u, '').trim();
}

export const leadFacts = (m: MappedLead, formName: string): LeadFacts => ({
  formId: m.formId, formName, campaignId: m.campaignId, campaignName: m.campaignName, fields: m.fields,
});

/** a question of the form and its answer: the question by what the customer saw (label) or by its key, any of the answer's values */
function answerMatches(rule: DeptRule, facts: LeadFacts): boolean {
  const q = norm(rule.question), a = norm(rule.answer);
  if (!q || !a) return false;
  return facts.fields.some((f) => (norm(f.label) === q || norm(f.key) === q) && f.values.some((v) => norm(v) === a));
}
/** a campaign: its id exactly (digits), or its name contains the text */
function campaignMatches(rule: DeptRule, facts: LeadFacts): boolean {
  const c = String(rule.campaign ?? '').trim();
  if (!c) return false;
  if (/^\d{6,30}$/.test(c)) return facts.campaignId === c;
  const n = norm(c);
  return Boolean(n) && norm(facts.campaignName).includes(n);
}

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The department of a lead. When several rules match, the most specific wins: a question and its answer (what the customer
 * asked for), then the form, then the campaign; within the same kind, the department that is first in the list.
 * No department → the default recipient when the business set one (the lead is marked "ללא מחלקה" either way).
 */
export function routeLead(depts: RoutingDept[], facts: LeadFacts, defaultStaffId: string | null = null): Routed {
  const ordered = [...depts].sort((a, b) => a.position - b.position);
  const tries: [RuleKind, (r: DeptRule) => boolean, (r: DeptRule) => string][] = [
    ['answer', (r) => answerMatches(r, facts), (r) => `שאלה בטופס: ${String(r.question).trim()} — ${String(r.answer).trim()}`],
    ['form', (r) => Boolean(r.formId) && r.formId === facts.formId, (r) => `טופס: ${facts.formName || r.formName || r.formId}`],
    ['campaign', (r) => campaignMatches(r, facts), () => `קמפיין: ${facts.campaignName || facts.campaignId}`],
  ];
  for (const [kind, hit, why] of tries) {
    for (const d of ordered) {
      const rule = d.rules.find((r) => r.kind === kind && hit(r));
      if (rule) return { departmentId: d.id, departmentName: d.name, staffId: d.staffId, by: cut(why(rule), 300), viaDefault: false };
    }
  }
  return { departmentId: null, departmentName: NO_DEPARTMENT, staffId: defaultStaffId, by: '', viaDefault: Boolean(defaultStaffId) };
}

/** a lead Meta created more than FRESH_HOURS ago is not sent (no date = new) */
export function isFresh(createdAt: string | null | undefined, now = Date.now()): boolean {
  if (!createdAt) return true;
  const t = Date.parse(createdAt);
  return Number.isNaN(t) || now - t <= FRESH_HOURS * 3600e3;
}

// ---------------------------------------------------------------------------------------------- the template's values --

/**
 * One line for a value of the template: WhatsApp refuses a value with a line break, a tab or more than 4 spaces in a row
 * (and an empty one) — every run of white space becomes one space; cut to max with "…".
 */
export function oneLine(s: string | null | undefined, max: number): string {
  return cut(String(s ?? '').replace(/\s+/g, ' ').trim(), max);
}

/** {{4}} — the form's details in one line: the form, the email, every answer ("שאלה: תשובה · …"), at most 900 characters */
export function detailsLine(p: { formName?: string; email?: string; answers: { q: string; a: string }[] }, max = DETAILS_MAX): string {
  const parts = [
    p.formName ? `טופס: ${p.formName}` : '',
    p.email ? `אימייל: ${p.email}` : '',
    ...p.answers.map(({ q, a }) => `${q}: ${a}`),
  ].map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return oneLine(parts.join(' · '), max) || '—';
}

/**
 * the five values of the template for a lead — the customer's phone is a value in the message, never the recipient.
 * {{4}}: the form's answers, or (a lead moved by the owner) the contact's notes, a line each joined by " · "
 */
export function leadTemplateParams(p: {
  department: string; name: string; phone: string; formName?: string; email?: string; answers?: { q: string; a: string }[]; details?: string;
}, detailsMax = DETAILS_MAX): string[] {
  return [
    oneLine(p.department, 60) || NO_DEPARTMENT,
    oneLine(p.name, 100) || 'ללא שם',
    oneLine(ilPhone(p.phone) || p.phone, 30) || '—',
    p.details !== undefined ? oneLine(p.details.replace(/\s*\n+\s*/g, ' · '), detailsMax) || '—' : detailsLine({ ...p, answers: p.answers ?? [] }, detailsMax),
    waLink(p.phone) || 'אין מספר טלפון',
  ];
}

/** the test message of a person of the team: their own number as the phone and the link, and a line that says it is a test */
export function testTemplateParams(staff: { phone: string }, department: string): string[] {
  return [
    oneLine(department, 60) || 'בדיקה',
    'הודעת בדיקה',
    staffPhoneShow(staff.phone),
    'בדיקה מ-Dream: אם ההודעה הגיעה, השליחה בוואטסאפ מחוברת. אין כאן ליד אמיתי.',
    `https://wa.me/${staff.phone}`,
  ];
}

// ------------------------------------------------------------------------------------------------- the team's numbers --

/**
 * A WhatsApp number of the team as Meta wants it: international digits, no "+": 050-1234567 → 972501234567,
 * +1 555 010 0123 → 15550100123; 501234567 (an Israeli mobile without its 0) → 972501234567. null when it can not be one.
 */
export function staffPhone(raw: string): string | null {
  let d = phoneDigits(raw);
  if (/^5\d{8}$/.test(d)) d = `972${d}`;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}
/** 972501234567 → 050-1234567; 15550100123 → +15550100123 */
export const staffPhoneShow = (d: string) => (d.startsWith('972') ? ilPhone(d) : `+${d}`);

// ---------------------------------------------------------------------------------------------------- Meta's answers --

export type WaError = {
  /** Meta's code ("131030"), or ours: not_connected / timeout / network / invalid_recipient / no_message_id */
  code: string; subcode: string; message: string; type: string; details: string; fbtrace: string; http: number;
};

/** Meta's error object ({ error: { message, type, code, error_subcode, error_data: { details }, fbtrace_id } }) as one shape */
export function parseWaError(body: unknown, http: number): WaError {
  const e = (body as any)?.error ?? {};
  return {
    code: e.code != null ? String(e.code) : `http_${http}`,
    subcode: e.error_subcode != null ? String(e.error_subcode) : '',
    message: String(e.error_user_msg || e.message || e.error_user_title || '').slice(0, 500),
    type: String(e.type ?? ''),
    details: String(e.error_data?.details ?? '').slice(0, 500),
    fbtrace: String(e.fbtrace_id ?? ''),
    http,
  };
}
/** "131030", or "100/33" with its subcode */
export const waErrorCode = (e: Pick<WaError, 'code' | 'subcode'>) => (e.subcode ? `${e.code}/${e.subcode}` : e.code);

const HINTS: Record<string, string> = {
  not_connected: 'וואטסאפ לא מחובר: חסר המפתח הקבוע (WHATSAPP_TOKEN) בהגדרות השרת ב-Vercel.',
  timeout: 'Meta לא ענתה בזמן. ייתכן שההודעה בכל זאת הגיעה — כדאי לבדוק לפני ששולחים שוב.',
  network: 'לא היה חיבור ל-Meta.',
  invalid_recipient: 'מספר הוואטסאפ ברשימת הצוות לא תקין.',
  no_message_id: 'Meta ענתה בלי מזהה הודעה. ייתכן שההודעה בכל זאת הגיעה.',
  staff_removed: 'מי שהיה אמור לקבל את ההודעה כבר לא ברשימת הצוות.',
  '0': 'המפתח של וואטסאפ לא תקף. צריך מפתח קבוע חדש ב-Vercel.',
  '190': 'המפתח של וואטסאפ לא תקף (פג או בוטל). צריך מפתח קבוע חדש ב-Vercel.',
  '10': 'למפתח אין הרשאה לשלוח מהמספר הזה (whatsapp_business_messaging).',
  '200': 'למפתח אין הרשאה לשלוח מהמספר הזה (whatsapp_business_messaging).',
  '100/33': 'מזהה המספר (WHATSAPP_PHONE_NUMBER_ID) לא נכון, או שלמפתח אין גישה אליו.',
  '100': 'Meta דחתה את הבקשה (ערך לא תקין). הפרטים המלאים למטה.',
  '4': 'יותר מדי פניות ל-Meta בזמן קצר. כדאי לנסות שוב בעוד כמה דקות.',
  '80007': 'יותר מדי פניות ל-Meta בזמן קצר. כדאי לנסות שוב בעוד כמה דקות.',
  '130429': 'יותר מדי הודעות בזמן קצר. כדאי לנסות שוב בעוד כמה דקות.',
  '131056': 'יותר מדי הודעות לאותו מספר בזמן קצר.',
  '131048': 'Meta הגבילה את השליחה בגלל דיווחי ספאם.',
  '131030': 'מספר הבדיקה של Meta שולח רק למספרים שברשימה המאושרת שלו (עד 5). מוסיפים את המספר ב-Meta: WhatsApp ← API Setup ← "To".',
  '131026': 'אי אפשר למסור: אין וואטסאפ במספר הזה, או שצריך לעדכן בו את האפליקציה ולאשר את התנאים.',
  '131047': 'עברו יותר מ-24 שעות מההודעה האחרונה — אפשר לשלוח רק תבנית מאושרת.',
  '131021': 'אי אפשר לשלוח מהמספר אל עצמו.',
  '131031': 'החשבון העסקי בוואטסאפ נעול.',
  '131042': 'בעיית תשלום בחשבון העסקי בוואטסאפ (אמצעי התשלום ב-Meta).',
  '131037': 'שם התצוגה של המספר עוד לא אושר ב-Meta.',
  '131008': 'חסר משתנה בתבנית.',
  '131009': 'ערך לא תקין באחד המשתנים.',
  '131051': 'סוג ההודעה לא נתמך.',
  '131000': 'תקלה זמנית אצל Meta.',
  '131016': 'השירות של Meta לא זמין כרגע.',
  '133004': 'השרת של Meta לא זמין כרגע.',
  '1': 'תקלה זמנית אצל Meta.',
  '2': 'השירות של Meta לא זמין כרגע.',
  '132000': `מספר המשתנים לא תואם לתבנית ${NEW_LEAD_TEMPLATE.name} (צריך 5).`,
  '132001': `התבנית ${NEW_LEAD_TEMPLATE.name} לא קיימת בעברית (he), או שעוד לא אושרה.`,
  '132005': 'הטקסט ארוך מדי לתבנית.',
  '132007': 'התוכן מפר את כללי התבניות של Meta.',
  '132012': 'אחד המשתנים לא בפורמט שהתבנית מצפה לו.',
  '132015': `התבנית ${NEW_LEAD_TEMPLATE.name} מושהית ב-Meta (איכות נמוכה).`,
  '132016': `התבנית ${NEW_LEAD_TEMPLATE.name} מושבתת ב-Meta.`,
  '133010': 'המספר השולח לא רשום ב-WhatsApp Cloud API.',
  '130497': 'אי אפשר לשלוח למספרים במדינה הזו.',
  '368': 'החשבון חסום זמנית בגלל הפרת מדיניות של Meta.',
};
/** a short Hebrew explanation of a code ('' when there is none — Meta's own message is shown anyway) */
export function waErrorHint(code: string): string {
  return HINTS[code] ?? HINTS[code.split('/')[0]] ?? '';
}

/** the owner's screen, under the template's state: a warning when Meta keeps it as MARKETING ('' when the category is fine) */
export function templateCategoryWarning(category: string): string {
  return String(category ?? '').toUpperCase() === 'MARKETING'
    ? 'הקטגוריה ב-Meta היא "שיווק": Meta עלולה לא למסור את ההודעה למי שלא כתב למספר ב-24 השעות האחרונות. להודעות לצוות צריך "שירות ציבורי".'
    : '';
}

// ---------------------------------------------------------------------------------------------- a message on the card --

export type NoticeStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';
export type Notice = {
  status: NoticeStatus; reason: string; staffName: string; errorCode: string;
  sentAt: string | null; claimedAt: string | null; kind: 'lead' | 'move';
};
const STALE_SENDING_MS = 15 * 60_000;

/** what the card says about one message, and whether the owner may send it (again) */
export function noticeLine(n: Notice, now = Date.now()): { tone: 'ok' | 'wait' | 'bad' | 'off'; text: string; hint: string; resend: boolean } {
  const to = n.staffName || 'הצוות';
  const when = (iso: string | null) => (iso ? formatIL(iso, { dateStyle: 'short', timeStyle: 'short' }) : '');
  const moved = n.kind === 'move' ? ' (העברה)' : '';
  switch (n.status) {
    case 'sent': return { tone: 'ok', text: `💬 נשלח בוואטסאפ ל${to}${moved} · ${when(n.sentAt)}`, hint: '', resend: false };
    case 'queued': return { tone: 'wait', text: `⏳ בתור לשליחה ל${to}${moved}`, hint: '', resend: false };
    case 'sending': {
      const stale = n.claimedAt ? now - Date.parse(n.claimedAt) > STALE_SENDING_MS : false;
      return stale
        ? { tone: 'bad', text: `❓ לא ידוע אם ההודעה ל${to} נשלחה (השליחה נקטעה)`, hint: 'כדאי לבדוק לפני ששולחים שוב.', resend: false }
        : { tone: 'wait', text: `⏳ נשלח עכשיו ל${to}…`, hint: '', resend: false };
    }
    case 'failed': return { tone: 'bad', text: `❌ לא נשלח ל${to}${moved} · קוד ${n.errorCode || '—'}`, hint: waErrorHint(n.errorCode), resend: true };
    case 'skipped': {
      if (n.reason === 'not_connected') return { tone: 'off', text: `⏸️ לא נשלח ל${to} — ${WA_NOT_CONNECTED}`, hint: '', resend: true };
      if (n.reason === 'old_lead') return { tone: 'off', text: `⏸️ לא נשלח ל${to} — הליד נוצר לפני יותר מ-${FRESH_HOURS} שעות`, hint: '', resend: true };
      if (n.reason === 'staff_removed') return { tone: 'off', text: `⏸️ לא נשלח — ${to} כבר לא ברשימת הצוות`, hint: '', resend: false };
      return { tone: 'off', text: `⏸️ לא נשלח ל${to}`, hint: '', resend: true };
    }
  }
}

// --------------------------------------------------------------------------------------- what the screens get (the API) --

export type StaffView = { id: string; name: string; active: boolean; memberUserId: string | null; phone?: string; phoneShown?: string };
export type RuleView = { kind: RuleKind; formId: string; formName: string; campaign: string; question: string; answer: string };
export type DeptView = { id: string; name: string; staffId: string; position: number; active: boolean; rules?: RuleView[] };
/** GET /api/leads/departments — names for every member; the numbers and the rules for the owner only */
export type RoutingView = {
  ready: true; connected: boolean; owner: boolean;
  /** the caller's own person(s) on the team — "הלידים שלי" */
  me: string[];
  staff: StaffView[]; departments: DeptView[];
  defaultStaffId: string | null;
};
/** a message about a lead, as the card and the screen show it */
export type NoticeView = {
  id: string; leadId: string; leadName?: string; staffId: string; staffName: string; kind: 'lead' | 'move';
  status: NoticeStatus; reason: string; attempts: number; errorCode: string;
  error: { message: string; details: string; fbtrace: string; type: string } | null;
  sentAt: string | null; claimedAt: string | null; createdAt: string;
  hint?: string; raw?: unknown;
};
