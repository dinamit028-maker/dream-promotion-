/**
 * 2.123 — the double-entry books' screens (stage 4ד) for the in-memory Supabase of the browser tests (fake-supabase.ts): the chart
 * (gl_accounts), the entries (gl_transactions / gl_lines), the reports of migration 20261129007200 (report_trial_balance /
 * report_ledger / report_journal / report_profit_loss / report_balance_sheet / gl_reconcile — their JSON as the database answers it)
 * and the owner's functions (gl_manual_create / _reverse, gl_account_add / _update / _set_active, gl_opening_balances) with their
 * checks and their refusals' codes. The rules themselves are proven on Postgres (tests/sql/books-more.check.sql); this mirrors them
 * so the real screens run end to end. Demo data only.
 */
import { randomUUID } from 'node:crypto';

type Row = Record<string, any>;
export interface BooksFake {
  tables: Record<string, Row[]>; opts: { businessId: string; userId: string };
  booksCore: boolean; booksMore: boolean; booksTx: number; booksOpening: boolean; booksStart: string | null;
  finance: { member: boolean; lockedUntil: string | null };
  /** 2.123: a difference the reconciliation reports (area → amount) — none: the books and the reports agree */
  booksReconDiff?: Record<string, number>;
}
const t = (f: BooksFake, n: string) => (f.tables[n] ||= []);
const ok = (body: any) => ({ status: 200, body });
const no = (code: string, message: string) => ({ status: 400, body: { code, message, details: null, hint: null } });
const ag = (n: number) => Math.round(Number(n) * 100);
const sh = (a: number) => a / 100;
const DEFAULT: [string, string, string, string, string, string | null][] = [
  ['1100', 'קופת מזומן — ראשי', 'asset', '1100', 'קופות מזומן', 'cash:main'], ['1150', 'צ׳קים בקופה — ראשי', 'asset', '1150', 'צ׳קים לגבייה', 'cheques:main'],
  ['BANK', 'בנק', 'asset', 'BANK', 'בנק', 'bank'], ['1250', 'חברות כרטיסי אשראי (סליקה)', 'asset', '1250', 'חברות כרטיסי אשראי', 'card_clearing'],
  ['1300', 'לקוחות', 'asset', 'CUSTOMERS', 'לקוחות', 'customers'], ['1400', 'מע״מ תשומות', 'asset', '1400', 'מע״מ תשומות', 'vat_input'],
  ['2100', 'ספקים', 'liability', 'SUPPLIERS', 'ספקים', 'suppliers'], ['2200', 'מע״מ עסקאות', 'liability', '2200', 'מע״מ עסקאות', 'vat_output'],
  ['2300', 'כרטיס אשראי של העסק', 'liability', '2300', 'כרטיס אשראי של העסק', 'business_card'], ['3100', 'יתרות פתיחה', 'equity', '3100', 'יתרות פתיחה', 'opening'],
  ['3200', 'בעלים', 'equity', '3200', 'בעלים', 'owner'], ['4100', 'הכנסות משירותים', 'income', '4000', 'הכנסות', 'income_services'],
  ['6112', 'עמלות בנק וסליקה', 'expense', '6100', 'הוצאות', 'expense:fees'], ['6117', 'אחר', 'expense', '6100', 'הוצאות', 'expense:other'],
  ['6900', 'הפרשי קופה', 'expense', '6900', 'הפרשי קופה', 'cash_diff'], ['9100', 'חשבון מעבר — לבירור', 'asset', '9100', 'חשבון מעבר', 'suspense'],
];
const SYSTEM = new Set([...DEFAULT.map((d) => d[0]), '1310', '1350', '2250', '4110', '4200', ...Array.from({ length: 17 }, (_, i) => `61${String(i + 1).padStart(2, '0')}`), '2150']);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

function account(f: BooksFake, key: string, name: string, kind: string, tbCode: string, tbName: string, role: string | null, parent: string | null = null): Row {
  const a = { id: randomUUID(), business_id: f.opts.businessId, key, name, kind, tb_code: tbCode, tb_name: tbName, parent_key: parent, role, active: true };
  t(f, 'gl_accounts').push(a);
  return a;
}
export function glChart(f: BooksFake) {
  if (t(f, 'gl_accounts').length) return;
  for (const [k, n, kind, tc, tn, role] of DEFAULT) account(f, k, n, kind, tc, tn, role);
}
const byKey = (f: BooksFake, k: string) => t(f, 'gl_accounts').find((a) => a.business_id === f.opts.businessId && a.key === k);
/** an entry: lines [key, side, amount] — the accounts must exist */
export function glPost(f: BooksFake, e: { date: string; kind: string; details: string; lines: [string, 'D' | 'C', number][]; ref1?: [number | null, string]; ref2?: [number | null, string];
  sourceId?: string; reverses?: string; id?: string }): Row {
  const tx = { id: e.id ?? randomUUID(), business_id: f.opts.businessId, number: ++f.booksTx, tx_date: e.date, value_date: e.date, entered_on: today(), source_kind: e.kind,
    source_id: e.sourceId ?? null, details: e.details.slice(0, 50), reverses: e.reverses ?? null, ref1_type: e.ref1?.[0] ?? null, ref1_number: e.ref1?.[1] ?? null,
    ref2_type: e.ref2?.[0] ?? null, ref2_number: e.ref2?.[1] ?? null, location_id: f.opts.businessId };
  t(f, 'gl_transactions').push(tx);
  e.lines.forEach(([k, side, amount], i) => t(f, 'gl_lines').push({ id: randomUUID(), transaction_id: tx.id, business_id: f.opts.businessId, line_no: i + 1,
    account_id: byKey(f, k)!.id, side, amount, value_date: e.date }));
  return tx;
}
/** a demo business's books: the chart, a customer and a supplier, and three entries (a receipt-invoice, an expense, a manual one) */
export function glSeed(f: BooksFake, o: { date: string; docId?: string }) {
  glChart(f);
  account(f, '0501234567', 'לקוחה דמו', 'asset', 'CUSTOMERS', 'לקוחות', 'customer:0501234567', '1300');
  account(f, 'S-000000109', 'ספק דמו', 'liability', 'SUPPLIERS', 'ספקים', 'supplier:d:000000109', '2100');
  glPost(f, { date: o.date, kind: 'document', sourceId: o.docId, details: 'חשבונית מס / קבלה 1 — לקוחה דמו', ref1: [320, '1'],
    lines: [['0501234567', 'D', 590], ['4100', 'C', 500], ['2200', 'C', 90], ['1100', 'D', 590], ['0501234567', 'C', 590]] });
  glPost(f, { date: o.date, kind: 'expense', details: 'הוצאה 1 — ספק דמו', ref1: [null, 'INV-7'], lines: [['6112', 'D', 100], ['1400', 'D', 18], ['S-000000109', 'C', 118]] });
  glPost(f, { date: o.date, kind: 'manual', details: 'עמלת העברה', lines: [['6117', 'D', 50], ['BANK', 'C', 50]] });
}

const between = (d: string, from: string, to: string) => d >= from && d <= to;
function lines(f: BooksFake) {
  const tx = new Map(t(f, 'gl_transactions').filter((x) => x.business_id === f.opts.businessId).map((x) => [x.id, x]));
  const acc = new Map(t(f, 'gl_accounts').map((a) => [a.id, a]));
  return t(f, 'gl_lines').filter((l) => tx.has(l.transaction_id)).map((l): Row & { tx: Row; a: Row; v: number } => ({ ...l, tx: tx.get(l.transaction_id)!, a: acc.get(l.account_id)!, v: l.side === 'D' ? ag(l.amount) : -ag(l.amount) }));
}
const startDate = (f: BooksFake) => {
  if (f.booksStart) return f.booksStart;
  const [y, m] = today().split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
const owner = (f: BooksFake & { journalWriterPublic?: () => boolean }) => (f.journalWriterPublic ? f.journalWriterPublic() : true);

export function booksScreensRpc(f: BooksFake & { journalWriterPublic?: () => boolean }, fn: string, a: any): { status: number; body: any } | null {
  const reports = ['report_trial_balance', 'report_ledger', 'report_journal', 'report_profit_loss', 'report_balance_sheet', 'gl_reconcile'];
  const writes = ['gl_manual_create', 'gl_manual_reverse', 'gl_account_add', 'gl_account_update', 'gl_account_set_active', 'gl_opening_balances'];
  if (!reports.includes(fn) && !writes.includes(fn)) return null;
  if (!f.booksCore || (!f.booksMore && fn !== 'gl_opening_balances')) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
  if (!f.finance.member) return no('42501', 'not allowed');
  const L = lines(f);
  if (fn === 'report_trial_balance') {
    const from = String(a.p_from), to = String(a.p_to);
    const m = new Map<string, Row>();
    for (const l of L.filter((x) => x.tx.tx_date <= to)) {
      const r = m.get(l.a.id) ?? { key: l.a.key, name: l.a.name, kind: l.a.kind, tbCode: l.a.tb_code, tbName: l.a.tb_name, parentKey: l.a.parent_key, o: 0, d: 0, c: 0 };
      if (l.tx.tx_date < from) r.o += l.v; else if (l.side === 'D') r.d += ag(l.amount); else r.c += ag(l.amount);
      m.set(l.a.id, r);
    }
    const acc = [...m.values()].sort((x, y) => x.tbCode.localeCompare(y.tbCode) || x.key.localeCompare(y.key));
    const out = (r: Row) => ({ opening: sh(r.o), debit: sh(r.d), credit: sh(r.c), closing: sh(r.o + r.d - r.c) });
    const groups = new Map<string, Row>();
    for (const r of acc) { const g = groups.get(r.tbCode) ?? { tbCode: r.tbCode, tbName: r.tbName, n: 0, o: 0, d: 0, c: 0 }; g.n++; g.o += r.o; g.d += r.d; g.c += r.c; groups.set(r.tbCode, g); }
    const tot = acc.reduce((s, r) => ({ o: s.o + r.o, d: s.d + r.d, c: s.c + r.c }), { o: 0, d: 0, c: 0 });
    return ok({ from, to, accounts: acc.map((r) => ({ key: r.key, name: r.name, kind: r.kind, tbCode: r.tbCode, tbName: r.tbName, parentKey: r.parentKey, ...out(r) })),
      groups: [...groups.values()].map((g) => ({ tbCode: g.tbCode, tbName: g.tbName, accounts: g.n, ...out(g) })), total: out(tot) });
  }
  if (fn === 'report_ledger') {
    const acc = byKey(f, String(a.p_account ?? '').trim());
    if (!acc) return no('22023', `ledger_account: החשבון ${a.p_account} לא נמצא`);
    const from = String(a.p_from), to = String(a.p_to);
    const mine = L.filter((l) => (l.a.id === acc.id || l.a.parent_key === acc.key) && l.tx.tx_date <= to)
      .sort((x, y) => x.tx.tx_date.localeCompare(y.tx.tx_date) || x.tx.number - y.tx.number || x.line_no - y.line_no);
    const op = mine.filter((l) => l.tx.tx_date < from).reduce((s, l) => s + l.v, 0);
    let bal = op; let d = 0, c = 0;
    const per = mine.filter((l) => l.tx.tx_date >= from).map((l) => {
      bal += l.v; if (l.side === 'D') d += ag(l.amount); else c += ag(l.amount);
      return { date: l.tx.tx_date, valueDate: l.value_date, number: l.tx.number, transactionId: l.tx.id, lineNo: l.line_no, account: l.a.key, accountName: l.a.name,
        details: l.tx.details, sourceKind: l.tx.source_kind, reverses: l.tx.reverses, ref1Type: l.tx.ref1_type, ref1Number: l.tx.ref1_number, ref2Type: l.tx.ref2_type,
        ref2Number: l.tx.ref2_number, side: l.side, debit: l.side === 'D' ? l.amount : 0, credit: l.side === 'C' ? l.amount : 0, balance: sh(bal), match1: null, match2: null };
    });
    return ok({ account: { key: acc.key, name: acc.name, kind: acc.kind, tbCode: acc.tb_code, tbName: acc.tb_name, parentKey: acc.parent_key, dealer: null, active: acc.active },
      from, to, opening: sh(op), debit: sh(d), credit: sh(c), closing: sh(bal), lines: per });
  }
  if (fn === 'report_journal') {
    const from = String(a.p_from), to = String(a.p_to);
    const txs = t(f, 'gl_transactions').filter((x) => x.business_id === f.opts.businessId && between(x.tx_date, from, to))
      .sort((x, y) => x.tx_date.localeCompare(y.tx_date) || x.number - y.number);
    const entries = txs.map((x) => {
      const ls = L.filter((l) => l.tx.id === x.id).sort((p, q) => p.line_no - q.line_no);
      return { id: x.id, number: x.number, date: x.tx_date, valueDate: x.value_date, enteredOn: x.entered_on, sourceKind: x.source_kind, sourceId: x.source_id, details: x.details,
        reverses: x.reverses, reversedBy: t(f, 'gl_transactions').find((y) => y.reverses === x.id)?.id ?? null, ref1Type: x.ref1_type, ref1Number: x.ref1_number,
        ref2Type: x.ref2_type, ref2Number: x.ref2_number, locationId: x.location_id,
        debit: sh(ls.filter((l) => l.side === 'D').reduce((s, l) => s + ag(l.amount), 0)), credit: sh(ls.filter((l) => l.side === 'C').reduce((s, l) => s + ag(l.amount), 0)),
        lines: ls.map((l) => ({ lineNo: l.line_no, account: l.a.key, accountName: l.a.name, side: l.side, amount: l.amount, valueDate: l.value_date, match1: null, match2: null })) };
    });
    return ok({ from, to, count: entries.length, debit: sh(entries.reduce((s, e) => s + ag(e.debit), 0)), credit: sh(entries.reduce((s, e) => s + ag(e.credit), 0)), entries });
  }
  const parted = (sel: (l: ReturnType<typeof lines>[number]) => boolean, kinds: string[], sign: (kind: string, side: string) => number) => {
    const m = new Map<string, Row>();
    for (const l of L.filter(sel)) {
      if (!kinds.includes(l.a.kind)) continue;
      const p = l.a.parent_key ? byKey(f, l.a.parent_key) ?? l.a : l.a;
      const r = m.get(`${l.a.kind}:${p.key}`) ?? { kind: l.a.kind, key: p.key, name: p.name, tbCode: p.tb_code, tbName: p.tb_name, v: 0 };
      r.v += sign(l.a.kind, l.side) * ag(l.amount); m.set(`${l.a.kind}:${p.key}`, r);
    }
    const part = (kind: string) => {
      const rs = [...m.values()].filter((r) => r.kind === kind).sort((x, y) => x.tbCode.localeCompare(y.tbCode) || x.key.localeCompare(y.key));
      return { total: sh(rs.reduce((s, r) => s + r.v, 0)), accounts: rs.map((r) => ({ key: r.key, name: r.name, tbCode: r.tbCode, tbName: r.tbName, amount: sh(r.v) })), groups: [] };
    };
    return { part, m };
  };
  if (fn === 'report_profit_loss') {
    const { part } = parted((l) => between(l.tx.tx_date, a.p_from, a.p_to), ['income', 'expense'], (k, s) => ((s === 'C') === (k === 'income') ? 1 : -1));
    const inc = part('income'), exp = part('expense');
    return ok({ from: a.p_from, to: a.p_to, income: inc, expenses: exp, profit: sh(ag(inc.total) - ag(exp.total)) });
  }
  if (fn === 'report_balance_sheet') {
    const { part } = parted((l) => l.tx.tx_date <= a.p_as_of, ['asset', 'liability', 'equity', 'income', 'expense'], (k, s) => ((s === 'D') === (k === 'asset' || k === 'expense') ? 1 : -1));
    const A = part('asset'), Li = part('liability'), E = part('equity'), earn = ag(part('income').total) - ag(part('expense').total);
    const le = ag(Li.total) + ag(E.total) + earn;
    return ok({ asOf: a.p_as_of, assets: A, liabilities: Li, equity: E, earnings: sh(earn), liabilitiesAndEquity: sh(le), balanced: ag(A.total) === le });
  }
  if (fn === 'gl_reconcile') {
    const st = startDate(f), from = a.p_from > st ? a.p_from : st;
    const diff = f.booksReconDiff ?? {};
    const rows = ['income', 'expenses', 'profit', 'vat_output', 'vat_input', 'vat_payable', 'cash_differences', 'receivables', 'cash', 'cheques'].map((area) => {
      const books = area === 'income' ? 500 : area === 'expenses' ? 150 : area === 'profit' ? 350 : 0;
      const explained = area === 'expenses' ? 50 : area === 'profit' ? -50 : 0;
      const d = diff[area] ?? 0;
      return { area, books, explained, source: sh(ag(books) - ag(explained) - ag(d)), difference: d };
    });
    return ok({ from, to: a.p_to, start: st, rows, same: rows.every((r) => ag(r.difference) === 0) });
  }

  // ---- the owner's writes (gl_owner_guard: journal_writer) ----
  if (fn === 'gl_opening_balances') { if (!owner(f)) return no('42501', 'not allowed'); }
  else if (!owner(f)) return no('42501', 'books_not_allowed: רק הבעלים רושמים בספרים');
  glChart(f);
  const td = today(), lock = f.finance.lockedUntil, st = startDate(f);
  if (fn === 'gl_manual_create') {
    const same = t(f, 'gl_transactions').find((x) => x.id === a.p_id);
    if (same) return ok({ id: same.id, number: same.number, date: same.tx_date, created: false });
    const d = String(a.p_date ?? '');
    if (!d || d > td) return no('22023', 'manual_date: פקודה — בתאריך של היום או לפניו');
    if (d < st) return no('22023', `manual_before_start: פקודה בספרים — מתאריך תחילת הספרים (${st})`);
    if (lock && d <= lock) return no('23514', `period_locked: the books are closed until ${lock}`);
    const det = String(a.p_details ?? '').trim();
    if (det.length < 2 || det.length > 50) return no('22023', 'manual_details: פרטי הפקודה — 2 עד 50 תווים');
    const ls: any[] = Array.isArray(a.p_lines) ? a.p_lines : [];
    if (ls.length < 2 || ls.length > 500) return no('22023', 'manual_lines: פקודה — 2 עד 500 שורות');
    let ds = 0, cs = 0;
    for (const l of ls) {
      if (typeof l.amount !== 'number') return no('22023', 'manual_amount: סכום — מספר');
      if (!['D', 'C'].includes(l.side) || l.amount <= 0 || Math.abs(l.amount * 100 - ag(l.amount)) > 1e-6) return no('22023', 'manual_line: כל שורה');
      const acc = byKey(f, String(l.account ?? '').trim());
      if (!acc || !acc.active) return no('22023', `manual_account: החשבון ${l.account} לא נמצא בלוח החשבונות (או שאינו פעיל)`);
      if (l.side === 'D') ds += ag(l.amount); else cs += ag(l.amount);
    }
    if (ds !== cs) return no('23514', `manual_unbalanced: הפקודה לא מאוזנת — חובה ${sh(ds)} , זכות ${sh(cs)}`);
    const tx = glPost(f, { id: a.p_id, date: d, kind: 'manual', details: det, sourceId: a.p_id, lines: ls.map((l) => [String(l.account).trim(), l.side, l.amount]) });
    return ok({ id: tx.id, number: tx.number, date: d, debit: sh(ds), credit: sh(cs), created: true });
  }
  if (fn === 'gl_manual_reverse') {
    const same = t(f, 'gl_transactions').find((x) => x.id === a.p_id);
    if (same) return ok({ id: same.id, number: same.number, date: same.tx_date, created: false });
    const o = t(f, 'gl_transactions').find((x) => x.id === a.p_entry && x.business_id === f.opts.businessId);
    if (!o || o.source_kind !== 'manual') return no('22023', 'manual_entry: פקודה ידנית של העסק');
    if (o.reverses) return no('23514', 'manual_reverse: פקודה הפוכה לא מבטלים');
    if (t(f, 'gl_transactions').some((x) => x.reverses === o.id)) return no('23514', 'manual_reversed: הפקודה כבר בוטלה');
    const d = String(a.p_date ?? td);
    if (d > td || d < o.tx_date) return no('22023', 'manual_date: ביטול — מתאריך הפקודה ועד היום');
    if (lock && d <= lock) return no('23514', `period_locked: the books are closed until ${lock}`);
    const det = String(a.p_details ?? '').trim() || `ביטול פקודה ${o.number}`;
    const ls = t(f, 'gl_lines').filter((l) => l.transaction_id === o.id).sort((x, y) => x.line_no - y.line_no)
      .map((l) => [t(f, 'gl_accounts').find((x) => x.id === l.account_id)!.key, l.side === 'D' ? 'C' : 'D', l.amount] as [string, 'D' | 'C', number]);
    const tx = glPost(f, { id: a.p_id, date: d, kind: 'manual', details: det, sourceId: a.p_id, reverses: o.id, lines: ls });
    return ok({ id: tx.id, number: tx.number, date: d, reverses: o.number, created: true });
  }
  const KEY = /^[0-9]{4}(-[0-9]{1,2})?$/;
  const sys = (k: string) => SYSTEM.has(k) || /^(1100|1150)-[0-9]{1,2}$/.test(k);
  if (fn === 'gl_account_add') {
    const k = String(a.p_key ?? '').trim(), nm = String(a.p_name ?? '').trim(), pk = a.p_parent_key ? String(a.p_parent_key).trim() : null;
    if (!KEY.test(k)) return no('22023', 'account_key: מפתח חשבון — 4 ספרות');
    if (sys(k)) return no('23505', `account_reserved: המפתח ${k} שמור לחשבון של המערכת`);
    if (byKey(f, k)) return no('23505', `account_exists: כבר יש חשבון עם המפתח ${k}`);
    if (!nm || nm.length > 50) return no('22023', 'account_name: שם החשבון — עד 50 תווים');
    if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(a.p_kind)) return no('22023', 'account_kind: נכס, התחייבות, הון, הכנסה או הוצאה');
    if (pk && !byKey(f, pk)) return no('22023', `account_parent: חשבון האב ${pk} לא נמצא`);
    if (pk && (pk === '1300' || pk === '2100' || byKey(f, pk)!.kind !== a.p_kind)) return no('22023', 'account_parent: חשבון אב מאותו סוג');
    account(f, k, nm, a.p_kind, a.p_tb_code || k, a.p_tb_name || nm.slice(0, 30), null, pk);
    return ok({ id: byKey(f, k)!.id, key: k });
  }
  if (fn === 'gl_opening_balances') return opening(f, a, st);
  const acc = byKey(f, String(a.p_key ?? '').trim());
  if (!acc) return no('22023', `account_missing: החשבון ${a.p_key} לא נמצא`);
  if (fn === 'gl_account_update') {
    const nk = a.p_new_key ? String(a.p_new_key).trim() : acc.key;
    if (nk !== acc.key) {
      if (acc.role) return no('23514', 'account_key_fixed: למפתח של חשבון של המערכת אין שינוי');
      if (t(f, 'gl_lines').some((l) => l.account_id === acc.id)) return no('23514', 'account_key_fixed: למפתח של חשבון שיש בו תנועות אין שינוי');
      if (!KEY.test(nk)) return no('22023', 'account_key: מפתח חשבון — 4 ספרות');
      if (sys(nk)) return no('23505', 'account_reserved');
      if (byKey(f, nk)) return no('23505', `account_exists: כבר יש חשבון עם המפתח ${nk}`);
    }
    Object.assign(acc, { name: a.p_name || acc.name, tb_code: a.p_tb_code || acc.tb_code, tb_name: a.p_tb_name || acc.tb_name, key: nk });
    return ok({ id: acc.id, key: nk });
  }
  if (fn === 'gl_account_set_active') {
    if (!a.p_active) {
      if (acc.role && !/^(customer|supplier):/.test(acc.role)) return no('23514', 'account_system: חשבון של המערכת לא מוסר');
      const bal = t(f, 'gl_lines').filter((l) => l.account_id === acc.id).reduce((s, l) => s + (l.side === 'D' ? 1 : -1) * ag(l.amount), 0);
      if (bal) return no('23514', `account_balance: בחשבון יש יתרה (${sh(bal)}) — מאפסים אותה בפקודה לפני שמסירים`);
    }
    acc.active = Boolean(a.p_active);
    return ok({ id: acc.id, key: acc.key, active: acc.active });
  }
  return null;
}

/** gl_opening_balances — once, dated the start; what does not balance goes to 3100 */
function opening(f: BooksFake, a: any, st: string): { status: number; body: any } {
  const KEY = /^[0-9]{4}(-[0-9]{1,2})?$/;
  if (f.booksOpening) return no('23514', 'opening_done: יתרות הפתיחה כבר נרשמו (תיקון — בפקודה)');
  const ls: any[] = Array.isArray(a.p_lines) ? a.p_lines : [];
  if (!ls.length || ls.length > 2000) return no('22023', 'opening_lines: רשימת יתרות (1 עד 2000 שורות)');
  const out: [string, 'D' | 'C', number][] = [];
  let ds = 0, cs = 0;
  for (const l of ls) {
    if (typeof l.amount !== 'number') return no('22023', 'opening_amount: סכום — מספר');
    if (!['D', 'C'].includes(l.side) || l.amount <= 0) return no('22023', 'opening_line: כל שורה');
    const k = String(l.account ?? '').trim();
    if (!byKey(f, k)) {
      const nm = String(l.name ?? '').trim();
      if (!k || k.length > 15 || !nm || KEY.test(k) || k.toUpperCase() === 'BANK' || k.startsWith('S-')) return no('22023', `opening_account: חשבון ${k} לא נמצא`);
      account(f, k, nm.slice(0, 50), 'asset', 'CUSTOMERS', 'לקוחות', `customer:${k}`, '1300');
    }
    if (k === '3100') return no('22023', 'opening_account: חשבון יתרות הפתיחה מתאזן לבד');
    out.push([k, l.side, l.amount]);
    if (l.side === 'D') ds += ag(l.amount); else cs += ag(l.amount);
  }
  if (ds !== cs) out.push(['3100', ds > cs ? 'C' : 'D', sh(Math.abs(ds - cs))]);
  const tx = glPost(f, { date: st, kind: 'opening', details: 'יתרות פתיחה', lines: out });
  f.booksOpening = true;
  return ok({ id: tx.id, number: tx.number, date: st, debit: sh(ds), credit: sh(cs), opening: sh(ds - cs) });
}
