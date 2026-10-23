/**
 * What an employee may ask from their personal link (2.107; tests/attendance-server.test.ts) — checked here before the database
 * checks it again: a request to complete a report, or an absence. Only these fields, only these values.
 */
export type ClockRequest =
  | { type: 'request'; id: string; kind: 'missing_in' | 'missing_out' | 'shift' | 'fix'; entryId: string | null; clockIn: string | null; clockOut: string | null; note: string }
  | { type: 'absence'; id: string; kind: 'vacation' | 'sick' | 'reserve' | 'other'; from: string; to: string; minutes: number | null; note: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /T/.test(v) ? new Date(v).toISOString() : null);
const note = (v: unknown) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) : '');

export function clockRequestInput(b: any): { ok: true; input: ClockRequest } | { ok: false; error: string } {
  if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !UUID.test(b.id)) return { ok: false, error: 'בקשה לא תקינה.' };
  if (b.type === 'request') {
    const kind = b.kind;
    if (!['missing_in', 'missing_out', 'shift', 'fix'].includes(kind)) return { ok: false, error: 'סוג הבקשה לא תקין.' };
    const entryId = typeof b.entryId === 'string' && UUID.test(b.entryId) ? b.entryId : null;
    const clockIn = iso(b.clockIn), clockOut = iso(b.clockOut);
    if ((kind === 'missing_out' || kind === 'fix') && !entryId) return { ok: false, error: 'חסרה המשמרת.' };
    if (!clockOut || (kind !== 'missing_out' && !clockIn)) return { ok: false, error: 'חסרות שעות.' };
    if (clockIn && clockOut <= clockIn) return { ok: false, error: 'שעת היציאה חייבת להיות אחרי שעת הכניסה.' };
    return { ok: true, input: { type: 'request', id: b.id, kind, entryId: kind === 'shift' || kind === 'missing_in' ? null : entryId, clockIn: kind === 'missing_out' ? null : clockIn, clockOut, note: note(b.note) } };
  }
  if (b.type === 'absence') {
    if (!['vacation', 'sick', 'reserve', 'other'].includes(b.kind)) return { ok: false, error: 'סוג ההיעדרות לא תקין.' };
    const from = typeof b.from === 'string' && DAY.test(b.from) ? b.from : null;
    const to = typeof b.to === 'string' && DAY.test(b.to) ? b.to : from;
    if (!from || !to || to < from) return { ok: false, error: 'התאריכים לא תקינים.' };
    const minutes = b.minutes == null ? null : Number.isInteger(b.minutes) && b.minutes > 0 && b.minutes <= 1440 ? b.minutes : undefined;
    if (minutes === undefined || (minutes != null && to !== from)) return { ok: false, error: 'שעות היעדרות — ביום אחד בלבד.' };
    return { ok: true, input: { type: 'absence', id: b.id, kind: b.kind, from, to, minutes, note: note(b.note) } };
  }
  return { ok: false, error: 'בקשה לא תקינה.' };
}
