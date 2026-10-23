import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectImportColumns, planImport, sheetDate } from '../src/features/attendance/import';

const grid = [
  ['דוח עובדים', '', '', '', '', ''],
  ['קוד עובד', 'שם עובד', 'מחלקה', 'תואר', 'טלפון נייד', 'תאריך תחילת עבודה', 'ת.ז'],
  ['101', 'דנה כהן', 'מטבח', 'טבחית', '050-1111111', '01/03/2024', '123456782'],
  ['102', 'אבי לוי', 'שירות', 'מלצר', '0502222222', '45383', '123456789'],
  ['103', 'קיים במספר', 'מטבח', '', '', '', ''],
  ['', 'קיים בטלפון', '', '', '+972-50-3333333', '', ''],
  ['104', '', '', '', '', '', ''],
  ['', '', '', '', '', '', ''],
  ['105', 'דנה כפולה', 'מטבח', '', '0501111111', '', ''],
];

test('attendance import: finds the header row and the columns (the previous system\'s Hebrew names)', () => {
  const m = detectImportColumns(grid)!;
  assert.equal(m.header, 1);
  assert.equal(m.code, 0); assert.equal(m.name, 1); assert.equal(m.department, 2); assert.equal(m.title, 3); assert.equal(m.phone, 4); assert.equal(m.startDate, 5); assert.equal(m.idNumber, 6);
  const split = detectImportColumns([['מס׳ עובד', 'שם פרטי', 'שם משפחה', 'פלאפון'], ['7', 'רון', 'שחר', '0541234567']])!;
  assert.equal(split.first, 1); assert.equal(split.last, 2); assert.equal(split.code, 0);
  assert.equal(detectImportColumns([['a', 'b'], ['1', '2']]), null);
});

test('attendance import: only adds — what exists (code or phone) and what repeats in the file is skipped, with why', () => {
  const plan = planImport(grid, detectImportColumns(grid)!, [{ code: '103', phone: '' }, { code: '', phone: '050-3333333' }]);
  assert.deepEqual(plan.add.map((a) => a.name), ['דנה כהן', 'אבי לוי']);
  assert.deepEqual(plan.skipped.map((s) => [s.row, s.why]), [
    [5, 'מספר עובד 103 כבר קיים'], [6, 'הטלפון כבר שייך לעובד/ת'], [7, 'אין שם'], [9, 'הטלפון כבר שייך לעובד/ת'],
  ]);
  assert.equal(plan.add[0].startDate, '2024-03-01'); assert.equal(plan.add[1].startDate, '2024-04-01', 'an Excel day number');
  assert.equal(plan.add[0].idNumber, '123456782'); assert.equal(plan.add[1].idNumber, '', 'a wrong ID is left out, not saved');
  assert.deepEqual(plan.departments, ['מטבח', 'שירות']);
  const split = planImport([['שם פרטי', 'שם משפחה'], ['רון', 'שחר']], detectImportColumns([['שם פרטי', 'שם משפחה']])!, []);
  assert.equal(split.add[0].name, 'רון שחר');
});

test('attendance import: dates as sheets write them', () => {
  assert.equal(sheetDate('2026-01-31'), '2026-01-31'); assert.equal(sheetDate('31/1/26'), '2026-01-31'); assert.equal(sheetDate('31.01.2026'), '2026-01-31');
  assert.equal(sheetDate('31/02/2026'), null); assert.equal(sheetDate('x'), null); assert.equal(sheetDate(''), null);
});
