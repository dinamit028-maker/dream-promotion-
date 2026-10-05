/**
 * The financial audit log, in Hebrew. The log itself is written only by the database (triggers and a few functions),
 * is append-only, and every row's hash covers the previous one (finance_audit_verify() recomputes the chain).
 */
export interface AuditRow { id: number; actorId: string | null; actorKind: 'member' | 'super_admin' | 'server'; action: string; entity: string; entityId: string; details: Record<string, any>; at: string }
export const toAuditRow = (r: any): AuditRow => ({
  id: Number(r.id), actorId: r.actor_id ?? null, actorKind: r.actor_kind, action: r.action, entity: r.entity ?? '', entityId: r.entity_id ?? '', details: r.details ?? {}, at: r.at,
});
export const AUDIT_ACTION_HE: Record<string, string> = {
  'document.issued': 'מסמך הופק', 'document.printed': 'מסמך הודפס', 'document.cancelled': 'מסמך בוטל', 'document.sent': 'מסמך נשלח ללקוח',
  'draft.created': 'טיוטה נוצרה', 'draft.updated': 'טיוטה עודכנה', 'draft.deleted': 'טיוטה נמחקה',
  'quote.created': 'הצעת מחיר נוצרה', 'quote.updated': 'הצעת מחיר עודכנה', 'quote.status': 'סטטוס הצעת מחיר השתנה', 'quote.sent': 'הצעת מחיר נשלחה',
  'payment.in': 'תשלום נכנס', 'payment.out': 'תשלום יצא', 'refund.recorded': 'החזר בקופה', 'sale.cancelled': 'מכירה בוטלה',
  'expense.created': 'הוצאה נרשמה', 'expense.confirmed': 'הוצאה אושרה', 'expense.paid': 'הוצאה שולמה', 'expense.updated': 'הוצאה עודכנה', 'expense.voided': 'הוצאה בוטלה',
  'allocation.requested': 'נשלחה בקשה למספר הקצאה', 'allocation.approved': 'התקבל מספר הקצאה', 'allocation.rejected': 'בקשה למספר הקצאה נדחתה',
  'allocation.error': 'שגיאה בבקשה למספר הקצאה', 'allocation.manual': 'מספר הקצאה הוזן ידנית',
  'period.locked': 'תקופה נסגרה', 'settings.business': 'פרטי העסק שונו', 'settings.finance_profile': 'הגדרות הכספים שונו',
  'support.access_opened': 'מנהל-על פתח גישה לנתונים הכספיים', 'support.access_closed': 'מנהל-על סגר את הגישה',
  'export.open_format': 'הופק ממשק פתוח', 'export.csv': 'יוצא קובץ', 'export.package': 'הופקה חבילה לרו״ח', 'reminder.sent': 'נשלחה תזכורת תשלום', 'report.printed': 'דוח הודפס',
};
export const ACTOR_HE: Record<AuditRow['actorKind'], string> = { member: 'משתמש בעסק', super_admin: 'מנהל-על', server: 'המערכת' };
const n = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN);
const ils = (v: unknown) => (Number.isFinite(n(v)) ? `₪${n(v).toLocaleString('he-IL', { maximumFractionDigits: 2 })}` : '');
/** one line per event: "מסמך הופק · 320-15 · ₪236" */
export function auditLine(r: AuditRow): string {
  const d = r.details ?? {};
  const parts = [AUDIT_ACTION_HE[r.action] ?? r.action];
  if (d.type && d.number) parts.push(`${d.type}-${d.number}`);
  else if (d.number) parts.push(`מס׳ ${d.number}`);
  if (d.total !== undefined) parts.push(ils(d.total));
  if (d.amount !== undefined) parts.push(ils(d.amount));
  if (d.from && d.to) parts.push(`${d.from} ← ${d.to}`);
  if (d.reason) parts.push(`סיבה: ${String(d.reason).slice(0, 80)}`);
  if (d.until) parts.push(`עד ${String(d.until).slice(0, 16).replace('T', ' ')}`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * The "seal" put in the accountant's package: how many rows the log had, whether the chain checked out, and the last
 * row's hash. The chain shows a changed row — but someone with full control of the database could rewrite all of it
 * consistently; a copy of the last hash kept OUTSIDE the system (the accountant's package) shows that too.
 */
export interface AuditSeal { business: string; from: string; to: string; madeAt: string; rows: number; ok: boolean; firstBad?: number; lastId: number | null; lastHash: string; lastAt: string }
export function auditSeal(s: AuditSeal): string {
  const lines = [
    `חותמת יומן הפעולות הכספיות — ${s.business}`,
    `הופקה: ${s.madeAt}`,
    `תקופת החבילה: ${s.from} עד ${s.to}`,
    `רשומות ביומן (כל התקופות): ${s.rows}`,
    `בדיקת שלמות: ${s.ok ? 'לא נמצא שינוי — כל רשומה משורשרת (hash) לקודמת' : `נמצאה רשומה שהשתנתה (מס׳ ${s.firstBad ?? '?'})`}`,
  ];
  if (s.lastId === null) lines.push('היומן ריק.');
  else lines.push(`רשומה אחרונה: מס׳ ${s.lastId} · ${s.lastAt}`, `Hash של הרשומה האחרונה: ${s.lastHash}`);
  lines.push('', 'כדאי לשמור את הקובץ הזה מחוץ למערכת. אם בעתיד היומן יציג Hash אחר לאותה רשומה — היומן שוּנה אחרי הפקת החבילה.',
    'השרשור מגלה שינוי של רשומה; הוא לא מונע שינוי ממי ששולט ישירות במסד הנתונים — ולכן העותק שמחוץ למערכת חשוב.');
  return lines.join('\r\n') + '\r\n';
}
