import { israelParts, israelToIso } from '@/lib/il-time';
import type { PackageUse } from '@/features/finance/packages';

/**
 * Client file — sessions: a treatment given, recorded from the card by the owner and the practitioners the owner marked
 * (client_sessions of migration 4100; recording and cancelling from 20261010004200). Pure rules, shared by the card and the
 * tests. A session is never deleted: cancelling it is final, and the database gives back in the same statement the
 * treatment it took from a package (docs/FINANCE ADDITIONS HE.md, T1).
 */
export interface SessionRow {
  id: string; treatmentId: string; leadId: string; at: string; notes: string; byUser: string | null; cancelledAt: string | null; cancelReason: string;
}
export const SESSION_COLUMNS = 'id, treatment_id, lead_id, at, notes, by_user, cancelled_at, cancel_reason';
export const toSession = (r: any): SessionRow => ({
  id: String(r.id), treatmentId: String(r.treatment_id), leadId: String(r.lead_id), at: String(r.at ?? ''), notes: String(r.notes ?? ''),
  byUser: r.by_user ?? null, cancelledAt: r.cancelled_at ?? null, cancelReason: String(r.cancel_reason ?? ''),
});
export const MAX_SESSION_NOTES = 2000;

/**
 * The moment of a session from the day picked in the form (an Israeli date): today → now; an earlier day → noon of that day
 * in Israel (the database refuses a session in the future). An empty or bad day → now.
 */
export function sessionAt(day: string, now = Date.now()): string {
  const today = israelParts(now).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= today) return new Date(now).toISOString();
  return israelToIso(day, '12:00');
}

/** a session's deduction that still counts (not given back) — at most one, the database keeps it so */
export const activeUseOf = <U extends Pick<PackageUse, 'sessionId' | 'returnedAt'>>(sessionId: string, uses: U[]): U | null =>
  uses.find((u) => u.sessionId === sessionId && !u.returnedAt) ?? null;

/** the sessions of a treatment, newest first (cancelled ones stay in the list, marked) */
export const sessionsOf = (list: SessionRow[], treatmentId: string) =>
  list.filter((s) => s.treatmentId === treatmentId).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
/** how many sessions of a treatment were given (not cancelled) */
export const givenCount = (list: SessionRow[], treatmentId: string) => list.filter((s) => s.treatmentId === treatmentId && !s.cancelledAt).length;
