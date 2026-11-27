/**
 * 2.123 — CSV injection: a cell a spreadsheet would run as a formula (text that starts with = + - @, a tab or a CR — a customer's
 * name from the online store, a note, an employee's name) gets a leading apostrophe, so Excel / Sheets show it as text. Only text:
 * a number (a JS number, or a plain decimal as our money helpers write it — "-90.00", "1180.10") stays a number, so totals still
 * add up. Every CSV builder of the app escapes its cells through csvCell (tests/csv-safe.test.ts).
 */
const NUMERIC_CELL = /^-?\d+(\.\d+)?$/;
export const csvSafe = (v: unknown): string => {
  const t = String(v ?? '');
  return typeof v !== 'number' && !NUMERIC_CELL.test(t) && /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
};
/** a quoted CSV cell, safe */
export const csvCell = (v: unknown) => `"${csvSafe(v).replace(/"/g, '""')}"`;
