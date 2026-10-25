import { validIsraeliId } from './people';

/**
 * טופס 101 (docs/FORM101_REQUIREMENTS_HE.md; tests/attendance-form101.test.ts) — the employee's card for the tax year, as the
 * official form 0101/130 of 2026 ("מעודכן ל-11.2025") has it: the same sections א–י, the same fields, the same words — nothing
 * added, nothing left out. The employee fills it on the phone (the personal link), signs on the screen, and it is kept in the
 * employee's file, a new one every tax year (the owner of the system, 24–25.10.2026). The accountant reviews it and enters it in
 * the payroll: the system never chooses for the employee, never computes credit points and never advises — it shows the form's own
 * words, marks a field that is missing, and reminds of an attachment a section asks for.
 * Pure: the same checks in the employee's browser and on the server (/api/f101/<token>).
 */
export const FORM = { code: '0101/130', updated: '11.2025', taxYear: 2026, title: 'כרטיס עובד ובקשה להקלה ולתיאום מס על ידי המעסיק' } as const;

export type IncomeKind = 'monthly' | 'additional' | 'partial' | 'daily' | 'pension' | 'stipend';
/** חלק ד / ה — the form's words, with its explanation number */
export const INCOME_LABEL: Record<IncomeKind, string> = {
  monthly: 'משכורת חודש', additional: 'משכורת בעד משרה נוספת', partial: 'משכורת חלקית', daily: 'שכר עבודה (עובד יומי)', pension: 'קצבה', stipend: 'מלגה',
};
export const INCOME_KINDS = Object.keys(INCOME_LABEL) as IncomeKind[];
export type Gender = 'male' | 'female';
export const GENDER_LABEL: Record<Gender, string> = { male: 'זכר', female: 'נקבה' };
export type Marital = 'single' | 'married' | 'divorced' | 'widowed' | 'separated';
export const MARITAL_LABEL: Record<Marital, string> = { single: 'רווק/ה', married: 'נשוי/אה', divorced: 'גרוש/ה', widowed: 'אלמן/ה', separated: 'פרוד/ה' };
export type Kibbutz = 'no' | 'transferred' | 'not_transferred';
export const KIBBUTZ_LABEL: Record<Kibbutz, string> = {
  no: 'לא', transferred: 'כן. הכנסותיי ממעסיק זה מועברות לקיבוץ', not_transferred: 'כן. הכנסותיי ממעסיק זה אינן מועברות לקיבוץ',
};

export interface Person { idNumber: string; passport: string; lastName: string; firstName: string; birthDate: string; aliyahDate: string }
export interface Child { name: string; idNumber: string; birthDate: string; inCustody: boolean; allowance: boolean }
export interface ChildCounts { born: string; age1to2: string; age3: string; age4to5: string; age6to17: string; age18: string }
export interface OtherPayer { name: string; address: string; fileNumber: string; kind: string; monthly: string; taxDeducted: string }

export interface Form101Data {
  /** ב */
  employee: Person & {
    street: string; houseNumber: string; city: string; zip: string; phone: string; mobile: string; email: string;
    gender: Gender | ''; marital: Marital | ''; resident: boolean | null; kibbutz: Kibbutz | ''; hmo: boolean | null; hmoName: string;
  };
  /** ג */
  children: Child[];
  /** ד */
  income: { kinds: IncomeKind[]; startDate: string };
  /** ה */
  other: { has: boolean | null; kinds: IncomeKind[]; creditsHere: boolean; creditsElsewhere: boolean; noStudyFund: boolean; noPension: boolean };
  /** ו */
  spouse: Person & { hasIncome: boolean | null; incomeWork: boolean; incomeOther: boolean };
  /** ח */
  credits: {
    resident: boolean;
    disabled: boolean; disabledAllowance: boolean;
    settlement: boolean; settlementFrom: string; settlementName: string;
    immigrant: boolean; immigrantFrom: string; immigrantNoIncomeUntil: string;
    spouseNoIncome: boolean;
    singleParentFamily: boolean;
    childrenInCustody: boolean; custodyCounts: ChildCounts;
    childrenOther: boolean; otherCounts: ChildCounts;
    singleParent: boolean;
    childrenNotInCustody: boolean;
    disabledChildren: boolean; disabledChildrenCount: string;
    alimony: boolean;
    age16to18: boolean;
    discharged: boolean; serviceFrom: string; serviceTo: string;
    degree: boolean;
    reserveCombat: boolean; reserveDays: string;
  };
  /** ט */
  coordination: { noIncomeSinceYearStart: boolean; hasOthers: boolean; others: OtherPayer[]; assessorApproved: boolean };
  /** ז — what changed, on a form sent during the year (an update of the details) */
  changeNote: string;
}

const PERSON: Person = { idNumber: '', passport: '', lastName: '', firstName: '', birthDate: '', aliyahDate: '' };
const COUNTS: ChildCounts = { born: '', age1to2: '', age3: '', age4to5: '', age6to17: '', age18: '' };
export function emptyForm(): Form101Data {
  return {
    employee: { ...PERSON, street: '', houseNumber: '', city: '', zip: '', phone: '', mobile: '', email: '', gender: '', marital: '', resident: null, kibbutz: '', hmo: null, hmoName: '' },
    children: [],
    income: { kinds: [], startDate: '' },
    other: { has: null, kinds: [], creditsHere: false, creditsElsewhere: false, noStudyFund: false, noPension: false },
    spouse: { ...PERSON, hasIncome: null, incomeWork: false, incomeOther: false },
    credits: {
      resident: false, disabled: false, disabledAllowance: false, settlement: false, settlementFrom: '', settlementName: '',
      immigrant: false, immigrantFrom: '', immigrantNoIncomeUntil: '', spouseNoIncome: false, singleParentFamily: false,
      childrenInCustody: false, custodyCounts: { ...COUNTS }, childrenOther: false, otherCounts: { ...COUNTS }, singleParent: false,
      childrenNotInCustody: false, disabledChildren: false, disabledChildrenCount: '', alimony: false, age16to18: false,
      discharged: false, serviceFrom: '', serviceTo: '', degree: false, reserveCombat: false, reserveDays: '',
    },
    coordination: { noIncomeSinceYearStart: false, hasOthers: false, others: [], assessorApproved: false },
    changeNote: '',
  };
}

// ---- reading what arrived (the browser's JSON — never trusted) ----------------------------------------------------------------
const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const bool = (v: unknown) => v === true;
const tri = (v: unknown) => (v === true ? true : v === false ? false : null);
const oneOf = <T extends string>(v: unknown, keys: readonly T[]): T | '' => (typeof v === 'string' && (keys as readonly string[]).includes(v) ? (v as T) : '');
const kinds = (v: unknown) => (Array.isArray(v) ? INCOME_KINDS.filter((k) => v.includes(k)) : []);
const date = (v: unknown) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : ''; };
const digits = (v: unknown, max: number) => str(v, 40).replace(/\D/g, '').slice(0, max);
const person = (p: any): Person => ({
  idNumber: digits(p?.idNumber, 9), passport: str(p?.passport, 20), lastName: str(p?.lastName, 60), firstName: str(p?.firstName, 60),
  birthDate: date(p?.birthDate), aliyahDate: date(p?.aliyahDate),
});
const counts = (c: any): ChildCounts => Object.fromEntries((Object.keys(COUNTS) as (keyof ChildCounts)[]).map((k) => [k, digits(c?.[k], 2)])) as unknown as ChildCounts;

/** whatever arrived → a Form101Data with only known keys, every value clipped and typed */
export function cleanForm(raw: unknown): Form101Data {
  const r = (raw ?? {}) as any, e = r.employee ?? {}, o = r.other ?? {}, s = r.spouse ?? {}, c = r.credits ?? {}, t = r.coordination ?? {};
  return {
    employee: {
      ...person(e), street: str(e.street, 80), houseNumber: str(e.houseNumber, 10), city: str(e.city, 60), zip: digits(e.zip, 7),
      phone: str(e.phone, 20), mobile: str(e.mobile, 20), email: str(e.email, 120),
      gender: oneOf(e.gender, Object.keys(GENDER_LABEL) as Gender[]), marital: oneOf(e.marital, Object.keys(MARITAL_LABEL) as Marital[]),
      resident: tri(e.resident), kibbutz: oneOf(e.kibbutz, Object.keys(KIBBUTZ_LABEL) as Kibbutz[]), hmo: tri(e.hmo), hmoName: str(e.hmoName, 40),
    },
    children: (Array.isArray(r.children) ? r.children : []).slice(0, 20).map((x: any) => ({
      name: str(x?.name, 60), idNumber: digits(x?.idNumber, 9), birthDate: date(x?.birthDate), inCustody: bool(x?.inCustody), allowance: bool(x?.allowance),
    })).filter((x: Child) => x.name || x.idNumber || x.birthDate),
    income: { kinds: kinds(r.income?.kinds), startDate: date(r.income?.startDate) },
    other: { has: tri(o.has), kinds: kinds(o.kinds), creditsHere: bool(o.creditsHere), creditsElsewhere: bool(o.creditsElsewhere), noStudyFund: bool(o.noStudyFund), noPension: bool(o.noPension) },
    spouse: { ...person(s), hasIncome: tri(s.hasIncome), incomeWork: bool(s.incomeWork), incomeOther: bool(s.incomeOther) },
    credits: {
      resident: bool(c.resident), disabled: bool(c.disabled), disabledAllowance: bool(c.disabledAllowance),
      settlement: bool(c.settlement), settlementFrom: date(c.settlementFrom), settlementName: str(c.settlementName, 60),
      immigrant: bool(c.immigrant), immigrantFrom: date(c.immigrantFrom), immigrantNoIncomeUntil: date(c.immigrantNoIncomeUntil),
      spouseNoIncome: bool(c.spouseNoIncome), singleParentFamily: bool(c.singleParentFamily),
      childrenInCustody: bool(c.childrenInCustody), custodyCounts: counts(c.custodyCounts), childrenOther: bool(c.childrenOther), otherCounts: counts(c.otherCounts),
      singleParent: bool(c.singleParent), childrenNotInCustody: bool(c.childrenNotInCustody),
      disabledChildren: bool(c.disabledChildren), disabledChildrenCount: digits(c.disabledChildrenCount, 2), alimony: bool(c.alimony), age16to18: bool(c.age16to18),
      discharged: bool(c.discharged), serviceFrom: date(c.serviceFrom), serviceTo: date(c.serviceTo), degree: bool(c.degree),
      reserveCombat: bool(c.reserveCombat), reserveDays: digits(c.reserveDays, 3),
    },
    coordination: {
      noIncomeSinceYearStart: bool(t.noIncomeSinceYearStart), hasOthers: bool(t.hasOthers), assessorApproved: bool(t.assessorApproved),
      others: (Array.isArray(t.others) ? t.others : []).slice(0, 10).map((x: any) => ({
        name: str(x?.name, 80), address: str(x?.address, 120), fileNumber: digits(x?.fileNumber, 9), kind: str(x?.kind, 30), monthly: str(x?.monthly, 20), taxDeducted: str(x?.taxDeducted, 20),
      })).filter((x: OtherPayer) => x.name || x.fileNumber || x.monthly),
    },
    changeNote: str(r.changeNote, 500),
  };
}

// ---- what is missing, what the form warns of, which attachments it asks for --------------------------------------------------
export type Step = 'personal' | 'children' | 'income' | 'other' | 'spouse' | 'credits' | 'coordination' | 'sign';
export const STEPS: { key: Step; title: string }[] = [
  { key: 'personal', title: 'פרטים אישיים' }, { key: 'children', title: 'ילדים' }, { key: 'income', title: 'הכנסות ממעסיק זה' },
  { key: 'other', title: 'הכנסות אחרות' }, { key: 'spouse', title: 'בן/בת הזוג' }, { key: 'credits', title: 'פטור או זיכוי ממס' },
  { key: 'coordination', title: 'תיאום מס' }, { key: 'sign', title: 'הצהרה וחתימה' },
];
export interface Problem { step: Step; field: string; message: string }
export const married = (d: Form101Data) => d.employee.marital === 'married';

/** what must be filled before signing — the identity and the choices the form asks for; never a credit the employee did not ask for */
export function problems(d: Form101Data): Problem[] {
  const out: Problem[] = [];
  const add = (step: Step, field: string, message: string) => out.push({ step, field, message });
  const e = d.employee;
  if (!e.idNumber && !e.passport) add('personal', 'idNumber', 'חסר מספר זהות (או מספר דרכון למי שאין מספר זהות).');
  else if (e.idNumber && !validIsraeliId(e.idNumber)) add('personal', 'idNumber', 'מספר הזהות לא תקין (9 ספרות, כולל ספרת ביקורת).');
  if (!e.lastName) add('personal', 'lastName', 'חסר שם משפחה.');
  if (!e.firstName) add('personal', 'firstName', 'חסר שם פרטי.');
  if (!e.birthDate) add('personal', 'birthDate', 'חסר תאריך לידה.');
  if (!e.street || !e.city) add('personal', 'address', 'חסרה כתובת פרטית (רחוב ועיר/ישוב).');
  if (!e.gender) add('personal', 'gender', 'חסר מין.');
  if (!e.marital) add('personal', 'marital', 'חסר מצב משפחתי.');
  if (e.resident === null) add('personal', 'resident', 'חסר: תושב/ת ישראל — כן או לא.');
  if (!e.kibbutz) add('personal', 'kibbutz', 'חסר: חבר/ת קיבוץ / מושב שיתופי.');
  if (e.hmo === null) add('personal', 'hmo', 'חסר: חבר/ת בקופת חולים — כן או לא.');
  else if (e.hmo && !e.hmoName) add('personal', 'hmoName', 'חסר שם הקופה.');
  for (const [i, c] of d.children.entries()) {
    if (!c.name || !c.birthDate) add('children', `child${i}`, `ילד/ה ${i + 1}: חסרים שם ותאריך לידה.`);
    else if (c.idNumber && !validIsraeliId(c.idNumber)) add('children', `child${i}`, `ילד/ה ${i + 1}: מספר הזהות לא תקין.`);
  }
  if (!d.income.kinds.length) add('income', 'kinds', 'יש לסמן מה מקבלים ממעסיק זה.');
  if (d.other.has === null) add('other', 'has', 'יש לסמן אם יש הכנסות אחרות.');
  else if (d.other.has && !d.other.kinds.length) add('other', 'kinds', 'יש לסמן אילו הכנסות אחרות.');
  if (married(d)) {
    const s = d.spouse;
    if (!s.firstName || !s.lastName) add('spouse', 'name', 'חסר שם בן/בת הזוג.');
    if (s.idNumber && !validIsraeliId(s.idNumber)) add('spouse', 'idNumber', 'מספר הזהות של בן/בת הזוג לא תקין.');
    if (s.hasIncome === null) add('spouse', 'hasIncome', 'יש לסמן אם לבן/בת הזוג יש הכנסה.');
  }
  if (d.coordination.hasOthers && !d.coordination.others.length) add('coordination', 'others', 'יש לפרט את ההכנסות הנוספות ממשכורת.');
  return out;
}

/** the form's own explanations, when the answers call for them (דברי ההסבר (7)–(10), (14), סעיף 2א) */
export function warnings(d: Form101Data): string[] {
  const out: string[] = [];
  if (d.other.has) {
    if (!d.other.creditsHere && !d.other.creditsElsewhere)
      out.push('(7) אם העובד לא מילא משבצת זו — המעסיק מנוע מלנכות מס לפי לוח הניכויים ויש לנכות מס מירבי לפי התקנות מכל תשלומי המעסיק.');
    if (d.other.creditsElsewhere)
      out.push('(8) אם העובד מילא משבצת זו — המעסיק מנוע מלנכות מס לפי לוח הניכויים ויש לנכות מס מירבי לפי התקנות מכל תשלומי המעסיק.');
    if (!d.other.noStudyFund)
      out.push('(9) אם העובד לא מילא משבצת זו — על המעסיק לצרף למשכורת את סכומי ההפרשות לקרן השתלמות ולנכות מס לפי התקנות או לפעול לפי אישור תיאום מס מפקיד השומה.');
    if (!d.other.noPension)
      out.push('(10) אם העובד לא מילא משבצת זו — על המעסיק לצרף למשכורת את סכומי ההפרשות לקצבה/לאובדן כושר עבודה ולנכות מס לפי התקנות או לפעול לפי אישור תיאום מס מפ"ש.');
  }
  if (d.credits.disabledAllowance && !d.credits.disabled) out.push('(14) עובד ימלא משבצת זו (2ב׳) — רק בתנאי שמילא את המשבצת בסעיף 2א׳ ורק כך יהיה זכאי לתקרת הפטור הגבוהה.');
  if (d.credits.disabled && d.other.has !== false) out.push('אם לא סומן בחלק ה כי "אין לי הכנסות אחרות ממשכורת, מקצבה וממלגה" העובד יופנה לפקיד השומה לעריכת תיאום מס.');
  if (d.income.kinds.includes('partial')) out.push('(4) ממשכורת חלקית ינוכה מס בשיעור מירבי אלא אם כן זו הכנסה יחידה שאז ינוכה מס לפי לוח הניכויים.');
  if (d.income.kinds.includes('daily')) out.push('(5) משכר עבודה ינוכה מס לפי לוח יומי אלא אם כן זו הכנסה יחידה שאז ינוכה מס לפי לוח הניכויים.');
  return out;
}

export type AttachKind = 'id' | 'passport' | 'separated' | 'disabled' | 'disabledAllowance' | 'settlement' | 'immigrant' | 'disabledChild'
  | 'alimony' | 'discharge' | 'degree' | 'reserve' | 'noIncome' | 'payslips' | 'assessor' | 'other';
/** what the form says to attach, by what was marked (the form's words) */
export const ATTACH_LABEL: Record<AttachKind, string> = {
  id: 'צילום תעודת זהות כולל ספח', passport: 'צילום דרכון ואישור / רשיון שהייה בישראל (רשות האוכלוסין וההגירה)', separated: 'אישור פקיד השומה (פרוד/ה)',
  disabled: 'אישור משרד הביטחון / האוצר / פקיד השומה / תעודת עיוור', disabledAllowance: 'אישור על קבלת תגמול', settlement: 'אישור הרשות על גבי טופס 1312א',
  immigrant: 'תעודת עולה', disabledChild: 'אישור גמלת ילד נכה מהמוסד לביטוח לאומי לשנה הנוכחית', alimony: 'פסק דין', discharge: 'צילום תעודת שחרור / סיום שירות',
  degree: 'הצהרה בטופס 119', reserve: 'אישור מצה"ל על זכאות בעד שירות מילואים כלוחם', noIncome: 'הוכחה (כגון אישור משטרת הגבולות, אישור מחלה)',
  payslips: 'תלושי שכר של ההכנסות הנוספות', assessor: 'אישור תיאום מפקיד השומה', other: 'מסמך אחר',
};
export function attachmentsAsked(d: Form101Data): AttachKind[] {
  const c = d.credits, out: AttachKind[] = [d.employee.idNumber || !d.employee.passport ? 'id' : 'passport'];
  if (d.employee.marital === 'separated') out.push('separated');
  if (c.disabled) out.push('disabled');
  if (c.disabledAllowance) out.push('disabledAllowance');
  if (c.settlement) out.push('settlement');
  if (c.immigrant) out.push('immigrant');
  if (c.disabledChildren) out.push('disabledChild');
  if (c.alimony) out.push('alimony');
  if (c.discharged) out.push('discharge');
  if (c.degree) out.push('degree');
  if (c.reserveCombat) out.push('reserve');
  if (d.coordination.noIncomeSinceYearStart) out.push('noIncome');
  if (d.coordination.hasOthers) out.push('payslips');
  if (d.coordination.assessorApproved) out.push('assessor');
  return out;
}
/** asked for and not attached — said in the employee's file, never a reason to refuse the form (the accountant decides) */
export const missingAttachments = (d: Form101Data, attached: AttachKind[]) => attachmentsAsked(d).filter((k) => !attached.includes(k));

// ---- the declaration (חלק י), word for word -----------------------------------------------------------------------------------
export const DECLARATION = 'אני מצהיר/ה כי הפרטים שמסרתי בטופס זה הינם מלאים ונכונים. ידוע לי שהשמטה או מסירת פרטים לא נכונים הינה עבירה על פקודת מס הכנסה. אני מתחייב/ת להודיע למעסיק על כל שינוי שיחול בפרטיי האישיים ובפרטים דלעיל תוך שבוע ימים מתאריך השינוי.';

// ---- the tax year, renewal, the prefill -----------------------------------------------------------------------------------------
/** the tax year of a day (Israel: the calendar year) */
export const taxYearOf = (day: string) => Number(day.slice(0, 4));
/** a new form every tax year: employees without a submitted form for the year (active ones only) */
export function withoutForm<E extends { id: string; active: boolean }>(employees: E[], submitted: { employeeId: string; taxYear: number }[], year: number): E[] {
  const has = new Set(submitted.filter((s) => s.taxYear === year).map((s) => s.employeeId));
  return employees.filter((e) => e.active && !has.has(e.id));
}
/**
 * a new form starts from the last one the employee signed (any year) — the employee confirms or changes; the tax-year parts that
 * belong to a year (income start date, the year's credits and coordination) start empty in a new year
 */
export function prefill(base: Partial<{ name: string; phone: string; idNumber: string; startDate: string | null }>, last: Form101Data | null, year: number, lastYear: number | null): Form101Data {
  const d = last ? cleanForm(last) : emptyForm();
  if (!last) {
    const [first, ...rest] = (base.name ?? '').trim().split(/\s+/);
    d.employee.firstName = first ?? ''; d.employee.lastName = rest.join(' ');
    d.employee.mobile = base.phone ?? ''; d.employee.idNumber = (base.idNumber ?? '').replace(/\D/g, '');
  }
  if (lastYear !== year) {
    const fresh = emptyForm();
    d.income = fresh.income; d.coordination = fresh.coordination; d.changeNote = '';
    d.credits = { ...fresh.credits, resident: d.credits.resident };
  }
  if (!d.income.startDate && base.startDate && taxYearOf(base.startDate) === year) d.income.startDate = base.startDate;
  return d;
}

/** the link the employee gets on WhatsApp — the form only, nothing of Dream */
export const form101Text = (name: string, business: string, link: string, year: number, update: boolean) =>
  `שלום ${name.split(' ')[0]}, ${update ? 'זה הקישור לעדכון פרטים בטופס 101' : `זה הקישור למילוי טופס 101 לשנת המס ${year}`}${business ? ` של ${business}` : ''}:\n${link}\nממלאים בטלפון, מצרפים צילום תעודת זהות, וחותמים בסוף. הפרטים נשמרים רק אצל המעסיק ורואה החשבון.`;

export type RequestStatus = 'sent' | 'opened' | 'submitted' | 'cancelled' | 'expired';
export const REQUEST_LABEL: Record<RequestStatus, string> = { sent: 'נשלח', opened: 'נפתח', submitted: 'מולא ונחתם', cancelled: 'בוטל', expired: 'פג תוקף' };
/** a link is good for this long */
export const LINK_DAYS = 30;
