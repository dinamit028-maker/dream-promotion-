import type { MonthReport } from './hours-engine';

/**
 * The dashboard's numbers (tests/attendance-dashboard.test.ts) — read from the same monthly reports as every other screen
 * (hours-engine.ts), never counted another way.
 */
export interface PersonMonth<E = { id: string; active: boolean }> { employee: E; report: MonthReport }

export type DailyKey = 'working' | 'reported' | 'notReported' | 'absent' | 'late' | 'openOld';
/** today, of every active employee: working now, reported (closed shifts), not reported (a work day, nothing), absent, late;
 *  and an open shift of an earlier day (forgot to clock out) */
export function dailyStatus<E extends { id: string; active: boolean }>(list: PersonMonth<E>[], today: string): Record<DailyKey, E[]> {
  const out: Record<DailyKey, E[]> = { working: [], reported: [], notReported: [], absent: [], late: [], openOld: [] };
  for (const { employee: e, report } of list) {
    if (!e.active) continue;
    const d = report.days.find((x) => x.date === today);
    if (report.days.some((x) => x.date < today && x.status === 'open')) out.openOld.push(e);
    if (!d) continue;
    if (d.shifts.some((s) => s.open)) out.working.push(e);
    else if (d.shifts.length) out.reported.push(e);
    else if (d.absence) out.absent.push(e);
    else if (d.standard > 0) out.notReported.push(e);
    if (d.late > 0) out.late.push(e);
  }
  return out;
}

export interface MonthlyStatus { paid: number; expectedDays: number; missingDays: number; missingPct: number; active: number; inactive: number; openShifts: number }
/** a month of the business: the hours, the share of missing work days (up to today), active / inactive employees */
export function monthlyStatus<E extends { id: string; active: boolean }>(list: PersonMonth<E>[], today: string): MonthlyStatus {
  let paid = 0, expected = 0, missing = 0, open = 0;
  for (const { employee: e, report } of list) {
    paid += report.totals.paid; open += report.totals.openShifts;
    if (!e.active) continue;
    for (const d of report.days) {
      if (d.date >= today || d.standard <= 0 || (d.absence && !d.shifts.length)) continue;
      expected += 1;
      if (d.status === 'missing') missing += 1;
    }
  }
  return {
    paid, expectedDays: expected, missingDays: missing, missingPct: expected ? Math.round((missing / expected) * 1000) / 10 : 0,
    active: list.filter((x) => x.employee.active).length, inactive: list.filter((x) => !x.employee.active).length, openShifts: open,
  };
}
