/**
 * 2.123 — CSV injection: every report file of the money module is made by reports.ts csv(); a text cell that a spreadsheet would run
 * as a formula (= + - @, a tab, a CR at its start) gets a leading apostrophe; numbers — also negative ones, as our money helpers
 * write them — stay numbers. Demo data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csv, csvSafe } from '../src/features/finance/reports';
import { tableCsv } from '../src/features/finance/statements';

test('a formula in a text cell is neutralized; numbers stay numbers', () => {
  for (const bad of ['=HYPERLINK("http://example.test","לחצו")', '+972501234567', '-cmd', '@SUM(A1)', '\tתו', '\rשורה']) {
    assert.equal(csvSafe(bad), `'${bad}`, JSON.stringify(bad));
  }
  for (const ok of ['-90.00', '1180.10', '0', '-5', 'דנה כהן', '−₪50', '02/12/2026', '', 'a=b']) assert.equal(csvSafe(ok), ok, ok);
  assert.equal(csvSafe(-90), '-90', 'a number is never touched');
  assert.equal(csvSafe(null), '');
});

test('a customer named "=HYPERLINK(...)" in a report file — text in the spreadsheet, the totals as numbers', () => {
  const name = '=HYPERLINK("http://example.test/x","לקוח")';
  const file = tableCsv({ title: 'לפי לקוח', columns: [{ label: 'לקוח', type: 'text' }, { label: 'סכום', type: 'money' }],
    rows: [[name, -90], ['@לקוח', 1180.1]], total: ['סה״כ', 1090.1] });
  const lines = file.split('\r\n');
  assert.equal(lines[1], `"'=HYPERLINK(""http://example.test/x"",""לקוח"")","-90.00"`);
  assert.equal(lines[2], `"'@לקוח","1180.10"`);
  assert.equal(lines[3], '"סה״כ","1090.10"');
  assert.equal(csv(['א'], [['=1+1']]).split('\r\n')[1], `"'=1+1"`);
});
