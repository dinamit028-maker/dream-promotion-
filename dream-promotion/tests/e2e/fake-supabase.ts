/**
 * An in-memory stand-in for Supabase (PostgREST + auth) for browser tests: Playwright routes every request
 * to http://sb.test here. It answers the queries the register makes and mirrors the database rules that the
 * screens rely on (document numbering, stock moving with sales / refunds / cancels, refunds never beyond what
 * was paid; 2.54: stock per variant, an item's sum of its variants, a signed upload to storage; 2.55: the store — one per
 * business, its checklist before it goes on the air, theme versions, unique addresses of pages and collections).
 * 2.89 (4400): payment plans and the view receivable_lines (planLines — the view's arithmetic), the reminders' functions, a
 * duplicate expense (duplicateReasons — expense_duplicates' rule).
 * 2.91 (4600): locations and registers — location_state and the owner's functions, where a new row goes (location_fill), what a
 * signed-in user sees (the *_location_gate policies: the location picked, or the member's own), one open day per register.
 * 2.92 (4700): stock by location — the counts of the locations other than the main one (stock_levels; the main one's is the
 * rest), every move at its row's location, the view stock_by_location, stock_adjust, transfers and counts.
 * 2.93 (4800): serial numbers (received, sold once at the register, back on a cancel / refund, moved in a transfer, written off by
 * the owner; any other move of such a product refused), price lists and SKU series (their functions), location_compare.
 * 2.94 (4900): tax withheld at source on a receipt (its checks, its ledger row, out of finance_summary's cash) and the reports
 * (report_* — the same rules as the database's, on the fake's rows); before the migration: none of it, and its columns are missing.
 * 2.96 (5100): manual journal entries (journal_writer, journal_entry_create / _reverse — their checks, the number, the audit log;
 * the table read through its location policy, never written), their share of finance_summary ("manual"), of the reports and of
 * location_compare; and the person's own data (auth user_metadata — the favorites of the menu, PUT /auth/v1/user).
 * 2.105 (5700): the calendar — an appointment's practitioner (an active one of the team, b_appointment_staff), no two appointments
 * at once (per practitioner; without one — per location), every change in appointment_events (z_appointment_log — read only) and
 * appointment_staff(); before the migration: none of it, and its column is missing.
 * The real rules are tested on Postgres in tests/sql — this only lets the real UI run end to end.
 */
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { planLines } from '../../src/features/finance/plans';
import { duplicateReasons } from '../../src/features/finance/expenses';
import { firstCharge, onOrAfter } from '../../src/features/finance/recurring';
import { MANUAL_KEY, partyKey } from '../../src/features/finance/statements';

type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;

const now = () => new Date().toISOString();
const unq = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

function cond(col: string, op: string, raw: string): (r: Row) => boolean {
  const v = raw; // URLSearchParams has decoded it already — a second decode breaks the "%" of an ilike
  const val = (r: Row) => r[col];
  const cmp = (x: any) => (typeof x === 'number' ? x : String(x ?? ''));
  const num = (x: string, ref: any) => (typeof ref === 'number' ? Number(x) : x);
  switch (op) {
    case 'eq': return (r) => String(val(r) ?? '') === v || val(r) === num(v, val(r));
    case 'neq': return (r) => String(val(r) ?? '') !== v;
    case 'gt': return (r) => val(r) != null && cmp(val(r)) > num(v, val(r));
    case 'gte': return (r) => val(r) != null && cmp(val(r)) >= num(v, val(r));
    case 'lt': return (r) => val(r) != null && cmp(val(r)) < num(v, val(r));
    case 'lte': return (r) => val(r) != null && cmp(val(r)) <= num(v, val(r));
    case 'is': return (r) => (v === 'null' ? val(r) == null : String(val(r)) === v);
    case 'in': { const list = v.replace(/^\(|\)$/g, '').split(',').map(unq); return (r) => list.includes(String(val(r))); }
    case 'ilike': return (r) => new RegExp(`^${v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*')}$`, 'i').test(String(val(r) ?? ''));
    default: return () => true;
  }
}

function filtersOf(url: URL): ((r: Row) => boolean)[] {
  const out: ((r: Row) => boolean)[] = [];
  for (const [k, raw] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    if (k === 'or') {
      const parts = raw.replace(/^\(|\)$/g, '').split(',').map((p) => { const [c, op, ...rest] = p.split('.'); return cond(c, op, rest.join('.')); });
      out.push((r) => parts.some((f) => f(r)));
      continue;
    }
    const i = raw.indexOf('.');
    const op = raw.slice(0, i), v = raw.slice(i + 1);
    if (op === 'not') { const j = v.indexOf('.'); const f = cond(k, v.slice(0, j), v.slice(j + 1)); out.push((r) => !f(r)); continue; }
    out.push(cond(k, op, v));
  }
  return out;
}

export class FakeSupabase {
  counters = new Map<number, number>();
  numbers = new Map<string, number>();     // quotes / expenses (finance_counters)
  linkNo = 0;
  auditId = 0;
  calls: { method: string; path: string; body?: any }[] = [];
  /** the money screens' view of the caller (finance_access_state): a member by default */
  finance = { superAdmin: false, member: true, grantUntil: null as string | null, lockedUntil: null as string | null };
  /** 2.73: store_apply_kit is on the database (migration 3900) — false: as before it, the steps of 2.58 */
  applyKitRpc = true;
  applyKitCalls = 0;
  /** 2.87: client_files_allowed() for the signed-in user (the owner: yes) */
  clientFiles = true;
  /** 2.89: the signed-in user is the business's owner (turns reminders on) */
  owner = true;
  /** 2.90: migration 4500 is in the database (recurring_plans, recurring_charges and their functions) — false: as before it */
  recurringTables = true;
  /** 2.91: migration 4600 is in the database (locations, registers and their columns) — false: as before it */
  locationTables = true;
  /** 2.91: the location picked at the top (profiles.current_location_id) — null: all */
  currentLocation: string | null = null;
  /** 2.91: the signed-in member's locations (business_members.locations, set by the super admin) — null: every one */
  memberLocations: string[] | null = null;
  /** 2.92: migration 4700 is in the database (stock_levels, stock_transfers, stock_counts, stock_by_location) — false: as before it */
  stockTables = true;
  /** 2.93: migration 4800 is in the database (serial numbers, price lists, SKU series, location_compare) — false: as before it */
  itemsTables = true;
  /** 2.94: migration 4900 is in the database (tax withheld at source, report_*, a service's treatment type, the advances' percent) — false: as before it */
  reportsTables = true;
  /** 2.95: migration 5000 is in the database (the desks, deposits, cheques and the bank; an order, a delivery note, a return note) — false: as before it */
  cashTables = true;
  /** 2.96: migration 5100 is in the database (journal_entries and its functions; the summary, the reports and location_compare with
   *  the entries) — false: as before it */
  journalTables = true;
  /** 2.96: the signed-in person's own data (auth user_metadata) — the favorites of the menu (dp_favorites) are kept in it */
  userMeta: Row = {};
  /** 2.97: migration 5200 is in the database (appointment_deposit_receipts; the thresholds confirmed) — false: as before it */
  depositDocsFn = true;
  /** 2.105: migration 5700 is in the database (appointments.staff_id, the team's practitioners and colours, appointment_events,
   *  appointment_staff()) — false: as before it */
  calendarTables = true;
  /** the moments of the history: one after another, also within the same millisecond (clock_timestamp() in the database) */
  private eventClock = 0;
  static CASH = ['bank_deposits', 'bank_deposit_cheques', 'bank_statements', 'bank_lines', 'bank_matches', 'cheque_reminders'];
  private serialEventId = 0;
  static ITEMS = ['catalog_serials', 'catalog_serial_events', 'price_lists', 'price_list_items', 'sku_series'];
  constructor(public tables: Tables, public opts: { businessId: string; userId: string; email: string; today?: string;
    /** now (ms) — the browser's fixed clock in a test: the moments of the history (appointment_events) */
    clock?: () => number }) {}
  /** today in Israel — or a fixed day (opts.today), for screens compared picture by picture */
  private today() { return this.opts.today ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()); }
  private log(action: string, entityId: string, details: Row) {
    this.t('finance_audit_log').push({ id: ++this.auditId, business_id: this.opts.businessId, actor_id: this.opts.userId, actor_kind: this.finance.member ? 'member' : 'super_admin',
      action, entity: '', entity_id: entityId, details, at: now(), prev_hash: '', hash: `h${this.auditId}` });
  }
  private vatBusiness() { const s = this.t('register_settings')[0]; return !(s?.entity_type === 'exempt_dealer' || s?.entity_type === 'nonprofit' || s?.business_type === 'exempt'); }
  /** the database view `receivables`: invoices (305 / 300) less credit invoices and payments */
  receivables(): Row[] {
    const docs = this.t('documents'), pays = this.t('payments'), canc = new Set(this.t('document_cancellations').map((c) => c.document_id));
    return docs.filter((d) => d.doc_type === 305 || d.doc_type === 300).map((d) => {
      const credited = docs.filter((c) => c.doc_type === 330 && c.base_doc_type === d.doc_type && c.base_doc_number === d.doc_number).reduce((a, c) => a + Number(c.total), 0);
      const paid = pays.filter((p) => p.applies_to === d.id).reduce((a, p) => a + (p.direction === 'in' ? 1 : -1) * Number(p.amount), 0);
      return { id: d.id, business_id: d.business_id, doc_type: d.doc_type, doc_number: d.doc_number, doc_date: d.doc_date, due_date: d.due_date ?? null, customer_name: d.customer_name,
        customer_phone: d.customer_phone ?? '', customer_email: d.customer_email ?? '', lead_id: d.lead_id ?? null, total: Number(d.total), share_token: d.share_token,
        credited: Math.round(credited * 100) / 100, paid: Math.round(paid * 100) / 100, balance: Math.round((Number(d.total) - credited - paid) * 100) / 100, cancelled: canc.has(d.id) };
    });
  }
  /** 2.89: the view receivable_lines — an invoice without a plan is one line; with a plan, a line per payment, paid in order */
  receivableLines(): Row[] {
    const out: Row[] = [];
    for (const r of this.receivables().filter((x) => !x.cancelled)) {
      const plan = this.t('payment_plans').find((p) => p.document_id === r.id && p.status === 'active');
      const items = plan ? this.t('payment_plan_items').filter((i) => i.plan_id === plan.id).sort((a, b) => a.n - b.n) : [];
      const ls = planLines(r.balance, plan ? { total: Number(plan.total), items: items.map((i) => ({ n: i.n, amount: Number(i.amount), dueDate: i.due_date })) } : null, r.due_date, r.doc_date);
      for (const l of ls) {
        out.push({ document_id: r.id, business_id: r.business_id, lead_id: r.lead_id, doc_type: r.doc_type, doc_number: r.doc_number, doc_date: r.doc_date,
          customer_name: r.customer_name, customer_phone: r.customer_phone, customer_email: r.customer_email, share_token: r.share_token, doc_balance: r.balance,
          plan_id: plan?.id ?? null, item_id: l.n != null ? items.find((i) => i.n === l.n)?.id ?? null : null, n: l.n, of_n: l.n != null ? items.length : null,
          due_date: l.dueDate, amount: l.amount, open_amount: l.open });
      }
    }
    return out;
  }
  /** 2.89: what the timer would queue now (debt_reminders_due): the last rule whose day came, once per line and step */
  dueReminders(days: number[], channel: string, today: string) {
    const nd = days.length, out: Row[] = [];
    const ago = (d: string) => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 864e5);
    for (const l of this.receivableLines()) {
      const lead = this.t('leads').find((x) => x.id === l.lead_id);
      if (!lead || !(l.open_amount > 0) || !l.due_date || this.t('debt_reminder_stops').some((x) => x.lead_id === l.lead_id && !x.lifted_at)) continue;
      const late = ago(l.due_date);
      if (late < days[0] || late > days[nd - 1] + 30) continue;
      const step = Math.max(...days.map((d, k) => (d <= late ? k + 1 : 0)));
      if (this.t('debt_reminders').some((q) => q.document_id === l.document_id && (q.item_id ?? null) === l.item_id && q.step >= step)) continue;
      const mail = lead.email || l.customer_email, phone = lead.phone || l.customer_phone;
      const ch = channel === 'email' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail) ? 'email' : String(phone).replace(/\D/g, '').length >= 9 ? 'whatsapp' : null;
      if (ch) out.push({ ...l, step, channel: ch, to_address: ch === 'email' ? mail : phone });
    }
    return out;
  }
  /** finance_summary(): the same rules as the database function, on the fake's rows */
  summary(from: string, to: string) {
    const vat = this.vatBusiness();
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const canc = new Set(this.t('document_cancellations').map((c) => c.document_id));
    const docs = this.t('documents').filter((d) => d.doc_date >= from && d.doc_date <= to);
    const rev = (list: Row[]) => list.reduce((a, d) => a + (vat ? (d.doc_type === 305 || d.doc_type === 320 ? Number(d.after_discount) : d.doc_type === 330 ? -Number(d.after_discount) : 0)
      : d.doc_type === 400 && !canc.has(d.id) ? Number(d.total) : 0), 0);
    const outVat = docs.reduce((a, d) => a + (vat ? (d.doc_type === 305 || d.doc_type === 320 ? Number(d.vat_amount) : d.doc_type === 330 ? -Number(d.vat_amount) : 0) : 0), 0);
    const exp = this.t('expenses').filter((e) => e.status === 'confirmed' && e.doc_date >= from && e.doc_date <= to);
    const ded = (e: Row) => (vat ? Math.round(Number(e.vat_amount) * Number(e.vat_deductible_pct ?? 100)) / 100 : 0);
    const eNet = exp.reduce((a, e) => a + Number(e.amount_before_vat), 0), eVat = exp.reduce((a, e) => a + Number(e.vat_amount), 0), eDed = exp.reduce((a, e) => a + ded(e), 0);
    const inPeriod = this.t('payments').filter((p) => p.paid_on >= from && p.paid_on <= to);
    // 2.94: tax withheld at source pays invoices but is not money — out of the cash, on its own
    const pays = this.reportsTables ? inPeriod.filter((p) => p.method !== 'withholding') : inPeriod;
    const withheld = inPeriod.filter((p) => p.method === 'withholding').reduce((a, p) => a + (p.direction === 'in' ? 1 : -1) * Number(p.amount), 0);
    const cin = pays.filter((p) => p.direction === 'in').reduce((a, p) => a + Number(p.amount), 0), cout = pays.filter((p) => p.direction === 'out').reduce((a, p) => a + Number(p.amount), 0);
    const methods = [...new Set(pays.map((p) => p.method))].map((m) => ({ method: m, in: pays.filter((p) => p.method === m && p.direction === 'in').reduce((a, p) => a + Number(p.amount), 0),
      out: pays.filter((p) => p.method === m && p.direction === 'out').reduce((a, p) => a + Number(p.amount), 0) }));
    const recv = this.receivables().filter((x) => !x.cancelled && x.balance > 0), today = this.today();
    const types: Row = {};
    for (const d of docs) { const k = String(d.doc_type); types[k] ??= { count: 0, total: 0, cancelled: 0 }; types[k].count++; types[k].total = r2(types[k].total + Number(d.total)); if (canc.has(d.id)) types[k].cancelled++; }
    // 2.96 (5100): the manual journal entries of the period (the location picked — the table's own policy): income and its VAT on
    // sales, an expense in its kind of expense (its VAT deductible as recorded, not in the count), VAT entries on either side
    const je = this.journalTables ? this.journalSeen().filter((j) => j.entry_date >= from && j.entry_date <= to) : [];
    const jsum = (f: (j: Row) => boolean, c: 'amount' | 'vat') => je.filter(f).reduce((a, j) => a + Number(j[c]), 0);
    const jr = { incNet: jsum((j) => j.kind === 'income', 'amount'), incVat: jsum((j) => j.kind === 'income', 'vat'),
      expNet: jsum((j) => j.kind === 'expense', 'amount'), expVat: jsum((j) => j.kind === 'expense', 'vat'),
      vatOut: jsum((j) => j.kind === 'vat' && j.vat_side === 'output', 'vat'), vatIn: jsum((j) => j.kind === 'vat' && j.vat_side === 'input', 'vat') };
    const cats = [...new Set([...exp.map((e) => e.category), ...je.filter((j) => j.kind === 'expense').map((j) => j.category)])].map((c) => {
      const l = exp.filter((e) => e.category === c), m = je.filter((j) => j.kind === 'expense' && j.category === c);
      const mNet = m.reduce((a, j) => a + Number(j.amount), 0), mVat = m.reduce((a, j) => a + Number(j.vat), 0);
      return { category: c, net: r2(l.reduce((a, e) => a + Number(e.amount_before_vat), 0) + mNet), vat: r2(l.reduce((a, e) => a + Number(e.vat_amount), 0) + mVat),
        total: r2(l.reduce((a, e) => a + Number(e.total), 0) + mNet + mVat), count: l.length };
    });
    const income = rev(docs) + jr.incNet, salesVat = outVat + jr.incVat + jr.vatOut, deductible = eDed + jr.expVat + jr.vatIn;
    const month = to.slice(0, 7);
    return {
      from, to, entity: vat ? 'licensed_dealer' : 'exempt_dealer', vat,
      revenue: { net: r2(income), vat: r2(salesVat), gross: r2(income + salesVat) }, documents: types,
      expenses: { net: r2(eNet + jr.expNet), vat: r2(eVat + jr.expVat + jr.vatIn), vatDeductible: r2(deductible), total: r2(eNet + eVat + jr.expNet + jr.expVat), count: exp.length, byCategory: cats },
      vatPayable: vat ? r2(salesVat - deductible) : 0, profit: r2(income - (eNet + eVat - eDed + jr.expNet)),
      cash: { in: r2(cin), out: r2(cout), net: r2(cin - cout), byMethod: methods },
      // 2.89: "overdue" by the lines (a plan's payments by their own dates)
      receivables: { open: r2(recv.reduce((a, x) => a + x.balance, 0)), count: recv.length,
        overdue: r2(this.receivableLines().filter((l) => l.open_amount > 0 && l.due_date && l.due_date < today).reduce((a, l) => a + l.open_amount, 0)),
        overdueCount: new Set(this.receivableLines().filter((l) => l.open_amount > 0 && l.due_date && l.due_date < today).map((l) => l.document_id)).size },
      // 2.97 (T7): the register's requests with their sum, the paid sales of the period (by their day in Israel) without a document,
      // and the invoices above the threshold without an allocation number — as the database function counts them
      pending: { count: this.t('sales').filter((x) => x.status === 'pending').length, total: r2(this.t('sales').filter((x) => x.status === 'pending').reduce((a, x) => a + Number(x.total), 0)) },
      posWithoutDocument: (() => {
        const ilDay = (ts: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
        const list = this.t('sales').filter((x) => x.status === 'paid' && x.business_id === this.opts.businessId && ilDay(x.paid_at ?? x.created_at) >= from && ilDay(x.paid_at ?? x.created_at) <= to
          && !this.t('documents').some((d) => d.sale_id === x.id && [305, 320, 400].includes(Number(d.doc_type))));
        return { count: list.length, total: r2(list.reduce((a, x) => a + Number(x.total), 0)) };
      })(),
      allocationMissing: (() => {
        const rules = [...this.t('tax_allocation_rules')].sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)));
        const ent = this.t('register_settings')[0]?.entity_type;
        return docs.filter((d) => {
          if (![305, 320].includes(Number(d.doc_type)) || !(d.customer_dealer ?? '')) return false;
          const e = d.issuer?.entityType ?? ent;
          if (e === 'exempt_dealer' || e === 'nonprofit') return false;
          const rule = rules.find((r) => String(r.effective_from) <= d.doc_date);
          if (!rule || !(Number(d.after_discount) > Number(rule.threshold_before_vat))) return false;
          return !this.t('tax_allocations').some((a) => a.document_id === d.id && ['approved', 'manual'].includes(a.status) && !a.is_test);
        }).length;
      })(),
      months: [{ month, revenue: r2(income), expenses: r2(eNet + eVat - eDed + jr.expNet) }], lockedUntil: this.finance.lockedUntil,
      ...(this.reportsTables ? { withheld: r2(withheld) } : {}),
      ...(this.journalTables ? { manual: { count: je.length, income: { net: r2(jr.incNet), vat: r2(jr.incVat) }, expense: { net: r2(jr.expNet), vat: r2(jr.expVat) },
        vat: { output: r2(jr.vatOut), input: r2(jr.vatIn) } } } : {}),
    };
  }

  /** 2.87: the database view client_package_status — a package with what was used, its document, paid (the ledger) and credited */
  packageStatus(): Row[] {
    const docs = this.t('documents'), pays = this.t('payments'), canc = new Set(this.t('document_cancellations').map((c) => c.document_id));
    return this.t('client_packages').map((p) => {
      const uses = this.t('client_package_uses').filter((u) => u.package_id === p.id);
      const used = uses.filter((u) => !u.returned_at).length;
      const d = p.document_id ? docs.find((x) => x.id === p.document_id) : null;
      const paid = d ? pays.filter((y) => y.document_id === d.id || y.applies_to === d.id).reduce((a, y) => a + (y.direction === 'in' ? 1 : -1) * Number(y.amount), 0) : 0;
      const credited = d ? docs.filter((c) => c.doc_type === 330 && c.base_doc_type === d.doc_type && c.base_doc_number === d.doc_number).reduce((a, c) => a + Number(c.total), 0) : 0;
      const lead = this.t('leads').find((l) => l.id === p.lead_id);
      return { ...p, customer_name: lead?.name ?? '', used, returned: uses.length - used, remaining: Number(p.sessions_total) - used,
        last_used_at: uses.filter((u) => !u.returned_at).map((u) => u.used_at).sort().pop() ?? null,
        doc_type: d?.doc_type ?? null, doc_number: d?.doc_number ?? null, doc_date: d?.doc_date ?? null, doc_total: d ? Number(d.total) : null, doc_cancelled: d ? canc.has(d.id) : false,
        paid: Math.round(paid * 100) / 100, credited: Math.round(credited * 100) / 100 };
    });
  }
  /** 2.87: a deduction — the database's rules (client_package_uses_check): one per session, never beyond, never cancelled */
  private useCheck(r: Row): string | null {
    const s = this.t('client_sessions').find((x) => x.id === r.session_id && x.lead_id === r.lead_id);
    if (!s) return 'the session was not found for this customer';
    if (s.cancelled_at) return 'session_cancelled: a cancelled session is not deducted';
    const p = this.t('client_packages').find((x) => x.id === r.package_id && x.lead_id === r.lead_id);
    if (!p) return 'the package was not found for this customer';
    if (p.status !== 'active') return 'package_cancelled: a cancelled package is not used';
    if (this.t('client_package_uses').some((u) => u.session_id === r.session_id && !u.returned_at)) return 'session_deducted: this session was already deducted';
    if (this.t('client_package_uses').filter((u) => u.package_id === p.id && !u.returned_at).length >= Number(p.sessions_total)) return 'package_used_up: no treatments are left in this package';
    const t = this.t('client_treatments').find((x) => x.id === s.treatment_id);
    if (p.treatment_type_id && t?.treatment_type_id && t.treatment_type_id !== p.treatment_type_id) return 'package_other_type: the package is for another type of treatment';
    Object.assign(r, { user_id: this.opts.userId, used_at: now(), returned_at: null, returned_by: null, return_reason: '' });
    return null;
  }

  private t(name: string) { return (this.tables[name] ||= []); }
  /** units held now for orders on the site (3500): 'paid', or 'held' until they expire */
  private heldQty(item: string, variant: string | null) {
    return this.t('stock_reservations').filter((r) => r.item_id === item && (!variant || r.variant_id === variant)
      && (r.status === 'paid' || (r.status === 'held' && new Date(r.expires_at).getTime() > Date.now()))).reduce((a, r) => a + Number(r.qty), 0);
  }
  /** files uploaded with a signed link (store-media), by path */
  files = new Map<string, { size: number; type: string }>();
  /** as stock_move_v (3300): the item's sum moves, and the variant named by the line when it is one of this item's;
   *  2.92 (stock_move_at, 4700): at a location — one that is not the main one keeps its own count (stock_levels) */
  private stock(itemId: string, delta: number, reason: string,
    ref: { sale?: string; refund?: string; note?: string; variant?: string | null; location?: string | null; transfer?: string; count?: string; serial?: boolean } = {}) {
    const it = this.t('catalog_items').find((i) => i.id === itemId && i.track_stock);
    if (!it || !delta) return;
    // 4800: a product with serial numbers moves only with them — the callers that may move it say so (the database refuses the rest)
    if (it.track_serials && !ref.serial) throw new Error('serial_item: a product with serial numbers moves with its numbers (received, sold, returned)');
    it.stock_qty = Number(it.stock_qty ?? 0) + delta;
    const v = ref.variant ? this.t('catalog_variants').find((x) => x.id === ref.variant && x.item_id === itemId) : null;
    if (v) v.stock_qty = Number(v.stock_qty ?? 0) + delta;
    const note = !v && it.has_variants ? ['לא משויך לווריאנט', ref.note].filter(Boolean).join(' · ') : ref.note ?? '';
    const b = this.opts.businessId, loc = this.stockTables ? ref.location ?? b : null;
    let after: number | null = null;
    if (loc && loc !== b) { after = this.levelAdd(loc, itemId, null, delta); if (v) after = this.levelAdd(loc, itemId, v.id, delta); }
    else if (loc) after = this.stockAt(loc, itemId, v?.id ?? null);
    this.t('stock_movements').push({ id: randomUUID(), business_id: b, item_id: itemId, variant_id: v?.id ?? null, delta,
      qty_after: v ? v.stock_qty : it.stock_qty, reason, sale_id: ref.sale ?? null, refund_id: ref.refund ?? null, note, created_at: now(),
      ...(loc ? { location_id: loc, location_after: after, transfer_id: ref.transfer ?? null, count_id: ref.count ?? null } : {}) });
  }
  private levelAdd(loc: string, item: string, variant: string | null, d: number): number {
    let r = this.t('stock_levels').find((x) => x.location_id === loc && x.item_id === item && (x.variant_id ?? null) === variant);
    if (!r) { r = { business_id: this.opts.businessId, location_id: loc, item_id: item, variant_id: variant, qty: 0, updated_at: now() }; this.t('stock_levels').push(r); }
    r.qty += d;
    return r.qty;
  }
  /** stock_at(): a location's count — the main one's is the total less the others' */
  stockAt(loc: string, item: string, variant: string | null): number {
    const it = this.t('catalog_items').find((i) => i.id === item);
    if (!it) return 0;
    const lv = this.t('stock_levels').filter((x) => x.item_id === item && (x.variant_id ?? null) === variant);
    if (loc !== this.opts.businessId) return lv.find((x) => x.location_id === loc)?.qty ?? 0;
    const base = variant ? Number(this.t('catalog_variants').find((x) => x.id === variant && x.item_id === item)?.stock_qty ?? 0) : Number(it.stock_qty ?? 0);
    return base - lv.reduce((a, x) => a + x.qty, 0);
  }
  /** units per (item, variant) in a list of lines — as stock_lines_v */
  private lines(items: any): { id: string; variant: string | null; qty: number }[] {
    const m = new Map<string, { id: string; variant: string | null; qty: number }>();
    for (const l of Array.isArray(items) ? items : []) {
      if (!l?.itemId || !(Number(l.qty) > 0)) continue;
      const variant = typeof l.variantId === 'string' && l.variantId ? l.variantId : null;
      const k = `${l.itemId}|${variant ?? ''}`;
      const e = m.get(k) ?? { id: l.itemId, variant, qty: 0 };
      e.qty += Math.floor(Number(l.qty)); m.set(k, e);
    }
    return [...m.values()];
  }
  /** an item "has variants" while one exists (the trigger catalog_variants_after) */
  private hasVariants(itemId: string) {
    const it = this.t('catalog_items').find((i) => i.id === itemId);
    if (it) it.has_variants = this.t('catalog_variants').some((v) => v.item_id === itemId);
  }

  /** the database's BEFORE INSERT side: defaults, numbering, checks — an error string refuses the row */
  private beforeInsert(table: string, r: Row): string | null {
    r.id ??= randomUUID();
    r.created_at ??= now();
    if (!['businesses', 'business_members', 'profiles'].includes(table)) r.business_id ??= this.opts.businessId;
    const placed = this.fillLocation(table, r);
    if (placed) return placed;
    if (table === 'appointments') { const e = this.appointmentCheck(r, null); if (e) return e; }
    if (table === 'documents') {
      if (r.idempotency_key && this.t('documents').some((d) => d.idempotency_key === r.idempotency_key)) return 'duplicate key value violates unique constraint "documents_idempotency_uq"';
      if (r.doc_type === 330) {
        const base = this.t('documents').find((d) => d.doc_type === r.base_doc_type && d.doc_number === r.base_doc_number);
        if (!base) return 'the credited invoice was not found in this business';
        const done = this.t('documents').filter((d) => d.doc_type === 330 && d.base_doc_type === r.base_doc_type && d.base_doc_number === r.base_doc_number).reduce((a, d) => a + Number(d.total), 0);
        if (Math.round((done + Number(r.total)) * 100) > Math.round(Number(base.total) * 100)) return `credit_exceeds_original: ${Number(base.total) - done} left`;
      }
      // 2.94: tax withheld at source — a receipt's, with a customer, a percent that is one, never all of it (before 4900: no such method)
      const held = (r.payments ?? []).filter((p: Row) => p.m === 'withholding');
      if (held.length) {
        if (!this.reportsTables) return 'new row for relation "payments" violates check constraint "payments_method_check"';
        if (held.some((p: Row) => p.pct != null && p.pct !== '' && !(/^\d{1,3}(\.\d{1,2})?$/.test(String(p.pct)) && Number(p.pct) <= 100))) return 'withholding_pct: the percent is a number from 0 to 100';
        if (!r.lead_id && !String(r.customer_name ?? '').trim()) return 'withholding_customer: tax withheld at source needs the customer who withheld it';
        if (Math.round(held.reduce((a: number, p: Row) => a + Number(p.amount), 0) * 100) >= Math.round(Number(r.total) * 100)) return 'withholding_all: tax withheld at source is part of a payment, not all of it';
      }
      const goods = this.goodsCheck(r);
      if (goods) return goods;
      const st = this.t('register_settings')[0] ?? {};
      const n = (this.counters.get(r.doc_type) ?? 0) + 1; this.counters.set(r.doc_type, n);
      Object.assign(r, { doc_number: n, issued_at: now(), print_count: 0, link_no: ++this.linkNo, share_token: randomBytes(32).toString('hex'),
        issuer: { name: st.legal_name ?? '', dealerNumber: st.dealer_number ?? '', entityType: st.entity_type ?? (st.business_type === 'exempt' ? 'exempt_dealer' : 'licensed_dealer'), vatRate: st.vat_rate,
          ...this.issuerLocation(r) },
        source: r.source ?? (r.refund_id ? 'refund' : r.sale_id ? 'pos' : r.paid_document_id ? 'receipt' : r.quote_id ? 'quote' : r.doc_type === 330 ? 'credit' : 'direct'),
        due_date: r.doc_type === 305 || r.doc_type === 300 ? r.due_date ?? null : null, notes: r.notes ?? '' });
    }
    if (table === 'quotes') {
      const n = (this.numbers.get('quote') ?? 0) + 1; this.numbers.set('quote', n);
      Object.assign(r, { quote_number: n, share_token: randomBytes(32).toString('hex'), sent_at: r.status === 'sent' ? now() : null, decided_at: null, decision_by: '', converted_document_id: null, updated_at: now() });
    }
    if (table === 'expenses') {
      if (r.file_sha256 != null && !/^[0-9a-f]{64}$/.test(r.file_sha256)) return 'new row for relation "expenses" violates check constraint "expenses_file_sha256_check"';
      if (r.duplicate_ack) r.duplicate_ack = { of: r.duplicate_ack.of, reasons: r.duplicate_ack.reasons, by: this.opts.userId, at: now() };
      const n = (this.numbers.get('expense') ?? 0) + 1; this.numbers.set('expense', n);
      Object.assign(r, { expense_number: n, status: r.status ?? 'confirmed', confirmed_at: (r.status ?? 'confirmed') === 'confirmed' ? now() : null, stock_lines: r.stock_lines ?? [], updated_at: now() });
    }
    if (table === 'document_drafts') Object.assign(r, { status: 'open', document_id: null, updated_at: now() });
    // 2.87: a package sold — its terms as sent, active; its document linked when it already exists ("package:<id>")
    if (table === 'client_packages') {
      if (this.t(table).some((x) => x.id === r.id)) return 'duplicate key value violates unique constraint "client_packages_pkey"';
      const doc = this.t('documents').find((d) => d.idempotency_key === `package:${r.id}`);
      Object.assign(r, { status: 'active', sold_on: r.sold_on ?? this.today(), valid_until: r.valid_until ?? null, notes: r.notes ?? '', cancelled_at: null, cancelled_by: null,
        cancel_reason: '', document_id: doc?.id ?? null, user_id: this.opts.userId });
    }
    if (table === 'client_package_uses') { const e = this.useCheck(r); if (e) return e; }
    if (table === 'client_sessions') Object.assign(r, { at: r.at ?? now(), notes: r.notes ?? '', params: r.params ?? {}, by_user: r.by_user ?? this.opts.userId, cancelled_at: null, cancelled_by: null, cancel_reason: '' });
    if (table === 'document_cancellations' && this.t('document_cancellations').some((c) => c.document_id === r.document_id)) return 'duplicate key value violates unique constraint "document_cancellations_pkey"';
    if (table === 'document_cancellations') { const e = this.goodsCancelCheck(r.document_id); if (e) return e; }
    if (table === 'sales') { r.status ??= 'paid'; r.payments ??= []; r.discount ??= 0; r.note ??= ''; }
    if (table === 'store_coupons') { r.code = String(r.code ?? '').toUpperCase(); r.active ??= true; r.used_count = 0; r.min_subtotal ??= 0; }
    // 3500: a sale of the register does not take units held for an order on the site (c_sales_reserved); 4700: the held units are
    // at the store's shipping location — a sale at another location takes none of them
    if (table === 'sales' && ['paid', 'pending'].includes(r.status) && !(this.stockTables && this.rowLocation(r) !== this.shipLocation())) {
      for (const l of this.lines(r.items)) {
        const it = this.t('catalog_items').find((i) => i.id === l.id);
        if (!it?.track_stock) continue;
        const v = l.variant ? this.t('catalog_variants').find((x) => x.id === l.variant && x.item_id === it.id) : null;
        const held = this.heldQty(it.id, v?.id ?? null);
        const have = this.stockTables ? this.stockAt(this.rowLocation(r), it.id, v?.id ?? null) : Number(v ? v.stock_qty : it.stock_qty);
        if (held && l.qty > have - held) return `שמור להזמנה באתר: ${it.name}`;
      }
    }
    // 4800 (sale_serials_take): a unit of a product with numbers is named — in stock at the sale's location, sold once
    if (table === 'sales' && this.itemsTables && ['paid', 'pending'].includes(r.status)) { const e = this.salesSerialsCheck(r); if (e) return e; }
    // the one catalog (3300): the database's defaults and checks the screens rely on
    if (table === 'catalog_items') {
      Object.assign(r, { active: r.active ?? true, favorite: r.favorite ?? false, fav_order: r.fav_order ?? 0, sort: r.sort ?? 0, image_url: r.image_url ?? '',
        track_stock: r.track_stock ?? false, stock_qty: r.stock_qty ?? 0, low_stock: r.low_stock ?? 2, kind: r.kind ?? 'service',
        slug: r.slug ?? null, description: r.description ?? '', seo_title: r.seo_title ?? '', seo_description: r.seo_description ?? '', publish_online: r.publish_online ?? false,
        online_price: r.online_price ?? null, compare_at_price: r.compare_at_price ?? null, sku: r.sku ?? '', barcode: r.barcode ?? '', has_variants: false,
        tags: r.tags ?? [], custom_fields: r.custom_fields ?? {}, manufacturer: r.manufacturer ?? '', country_of_origin: r.country_of_origin ?? '', updated_at: now(),
        ...(this.itemsTables ? { track_serials: r.track_serials ?? false } : {}) });
      if (r.published_at == null && r.publish_online) r.published_at = now();
    }
    if (table === 'catalog_variants') {
      if (Number(r.stock_qty ?? 0) !== 0) return 'stock changes only through a delivery or a count (adjust_variant_stock)';
      const dup = this.t('catalog_variants').some((v) => v.item_id === r.item_id && (v.option1 ?? '') === (r.option1 ?? '') && (v.option2 ?? '') === (r.option2 ?? '') && (v.option3 ?? '') === (r.option3 ?? ''));
      if (dup) return 'duplicate key value violates unique constraint "catalog_variants_item_id_option1_option2_option3_key"';
      Object.assign(r, { option1: r.option1 ?? '', option2: r.option2 ?? '', option3: r.option3 ?? '', sku: r.sku ?? '', barcode: r.barcode ?? '', price: r.price ?? null,
        online_price: r.online_price ?? null, compare_at_price: r.compare_at_price ?? null, stock_qty: 0, low_stock: r.low_stock ?? null, media_id: r.media_id ?? null,
        active: r.active ?? true, position: r.position ?? 0, updated_at: now() });
    }
    if (table === 'sale_refunds') {
      const s = this.t('sales').find((x) => x.id === r.sale_id);
      if (!s) return 'sale not found';
      if (s.status !== 'paid') return 'only a paid sale can be refunded';
      const done = this.t('sale_refunds').filter((x) => x.sale_id === r.sale_id).reduce((a, x) => a + Math.round(Number(x.amount) * 100), 0);
      if (done + Math.round(Number(r.amount) * 100) > Math.round(Number(s.total) * 100)) return `refund_exceeds_paid: ${(Number(s.total) * 100 - done) / 100} left`;
      if (this.itemsTables) { const e = this.refundSerialsCheck(r); if (e) return e; }
      r.created_at = now();
    }
    if (table === 'register_shifts') {
      r.opened_at ??= now();
      // 2.91: one open day per register (a day with no register is the main one's); before 4600: one per business
      const reg = (x: Row) => x.register_id ?? this.opts.businessId;
      if (this.t('register_shifts').some((x) => !x.closed_at && (!this.locationTables || reg(x) === reg(r)))) {
        return this.locationTables ? 'register_shifts_one_open: this register already has an open day' : 'duplicate key value violates unique constraint "register_shifts_one_open_idx"';
      }
    }
    // the store (3400): its defaults and the unique rules the screens rely on
    const fill = (d: Row) => { for (const [k, v] of Object.entries(d)) if (r[k] === undefined) r[k] = v; };
    if (table === 'stores') {
      if (this.t('stores').some((x) => x.business_id === r.business_id)) return 'duplicate key value violates unique constraint "stores_business_uq"';
      fill({ status: 'draft', template: 'bags', lang: 'he', logo_url: '', description: '', phone: '', whatsapp: '', email: '', address: '', ga4_id: '', gsc_code: '',
        show_stock_count: false, published_at: null, updated_at: now(),
        // 3700: an address from the business's name, and a password (the database makes them; here, fixed)
        slug: 'sagabot', storefront_password: 'e2epass123', password_lock: false, subdomain_seen_at: null,
        // 5600: the accessibility button, on
        a11y_widget: true });
      if (r.status === 'published') return `store_not_ready: ${this.storeMissing(r).join(',')}`;
    }
    if (table === 'store_theme_versions') {
      if (this.t(table).some((v) => v.store_id === r.store_id && v.status === 'draft')) return 'duplicate key value violates unique constraint "store_theme_versions_draft_uq"';
      Object.assign(r, { version: Math.max(0, ...this.t(table).filter((v) => v.store_id === r.store_id).map((v) => v.version)) + 1, status: 'draft', published_at: null, note: r.note ?? '' });
    }
    if (table === 'store_pages') {
      fill({ kind: 'page', policy: null, body: '', seo_title: '', seo_description: '', published: false, updated_at: now() });
      if (this.t(table).some((g) => g.store_id === r.store_id && g.slug === r.slug)) return 'duplicate key value violates unique constraint "store_pages_store_id_slug_key"';
      if (r.policy && this.t(table).some((g) => g.store_id === r.store_id && g.policy === r.policy)) return 'duplicate key value violates unique constraint "store_pages_policy_uq"';
      r.published_at = r.published ? now() : null;
    }
    if (table === 'store_menus') fill({ items: [], updated_at: now() });
    if (table === 'catalog_collections') {
      fill({ description: '', image_url: '', kind: 'manual', rules: {}, sort: 'manual', publish_online: false, seo_title: '', seo_description: '', position: 0, updated_at: now() });
      if (r.slug === 'all' || this.t(table).some((c) => c.business_id === r.business_id && c.slug === r.slug)) return 'duplicate key value violates unique constraint "catalog_collections_slug_uq"';
      r.published_at = r.publish_online ? now() : null;
    }
    if (table === 'catalog_collection_items') {
      const c = this.t('catalog_collections').find((x) => x.id === r.collection_id);
      if (!c || !this.t('catalog_items').some((i) => i.id === r.item_id && i.business_id === c.business_id)) return 'the product is not of this business';
    }
    return null;
  }
  /** store_missing(): what a store still needs before it goes on the air (the same codes, in the same order) */
  storeMissing(s: Row): string[] {
    const r = this.t('register_settings').find((x) => x.business_id === s.business_id);
    const out: string[] = [];
    if (!r || !String(r.legal_name ?? '').trim() || !String(r.city ?? '').trim() || !(/^\d{9}$/.test(r.dealer_number ?? '') || /^\d{9}$/.test(r.company_number ?? ''))) out.push('legal');
    if (!s.phone && !s.email && !s.whatsapp) out.push('contact');
    for (const p of ['returns', 'privacy', 'accessibility']) if (!this.t('store_pages').some((g) => g.store_id === s.id && g.policy === p && g.published)) out.push(p);
    if (!s.subdomain_seen_at && !this.t('store_domains').some((d) => d.store_id === s.id && d.is_primary && d.status === 'active')) out.push('domain');
    if (!this.t('catalog_items').some((i) => i.business_id === s.business_id && i.publish_online && i.active !== false && i.slug)) out.push('product');
    return out;
  }
  private afterInsert(table: string, r: Row) {
    if (table === 'appointments') this.appointmentLog(null, r);
    if (table === 'documents') {
      if (r.doc_type === 320 || r.doc_type === 400) for (const p of r.payments ?? []) {
        this.t('payments').push({ id: randomUUID(), business_id: r.business_id, user_id: r.user_id, direction: 'in', amount: Number(p.amount), method: p.m ?? ({ 1: 'cash', 2: 'cheque', 3: 'card', 4: 'transfer' } as Row)[p.method] ?? 'other',
          paid_on: p.date ?? r.doc_date, source: 'document', document_id: r.id, applies_to: r.paid_document_id ?? null, sale_id: r.sale_id ?? null, lead_id: r.lead_id ?? null,
          reference: p.m === 'withholding' ? (p.pct != null && p.pct !== '' ? { pct: Number(p.pct) } : {}) : p.cheque ?? {}, note: '', created_at: now(),
          ...(this.locationTables ? { location_id: r.location_id ?? null } : {}) });
      }
      if (r.draft_id) { const d = this.t('document_drafts').find((x) => x.id === r.draft_id); if (d) Object.assign(d, { status: 'finalized', document_id: r.id }); }
      if (r.quote_id) { const q = this.t('quotes').find((x) => x.id === r.quote_id); if (q) Object.assign(q, { status: 'converted', converted_document_id: r.id }); }
      // 2.87: a package's document is linked to it (z_documents_package_link)
      const pk = /^package:([0-9a-f-]{36})$/.exec(r.idempotency_key ?? '');
      if (pk) { const p = this.t('client_packages').find((x) => x.id === pk[1] && !x.document_id); if (p) p.document_id = r.id; }
      // 2.95 (5000): a delivery note takes the goods out, a return note brings them back (where the note is)
      if (this.cashTables && (r.doc_type === 200 || r.doc_type === 210)) {
        for (const l of this.lines(r.lines)) this.stock(l.id, r.doc_type === 200 ? -l.qty : l.qty, r.doc_type === 200 ? 'sale' : 'refund', { variant: l.variant, location: this.rowLocation(r), note: `${r.doc_type}-${r.doc_number}` });
      }
      this.log('document.issued', r.id, { type: r.doc_type, number: r.doc_number, total: r.total });
    }
    if (table === 'document_cancellations') {
      const d = this.t('documents').find((x) => x.id === r.document_id);
      if (this.cashTables && d && (d.doc_type === 200 || d.doc_type === 210)) {
        for (const l of this.lines(d.lines)) this.stock(l.id, d.doc_type === 200 ? l.qty : -l.qty, 'cancel', { variant: l.variant, location: this.rowLocation(d), note: `ביטול ${d.doc_type}-${d.doc_number}` });
      }
      for (const p of this.t('payments').filter((x) => x.document_id === r.document_id && x.direction === 'in' && x.source === 'document')) {
        this.t('payments').push({ ...p, id: randomUUID(), direction: 'out', source: 'cancel', paid_on: this.today(), reference: {}, created_at: now() });
      }
      this.log('document.cancelled', r.document_id, { reason: r.reason });
    }
    if (table === 'expenses' && r.status === 'confirmed' && r.paid_on) {
      this.t('payments').push({ id: randomUUID(), business_id: r.business_id, user_id: r.user_id, direction: 'out', amount: Number(r.total), method: r.payment_method, paid_on: r.paid_on, source: 'expense', expense_id: r.id, note: r.supplier_name, created_at: now(),
        ...(this.locationTables ? { location_id: r.location_id ?? null } : {}) });
    }
    if (table === 'expenses') this.log('expense.created', r.id, { number: r.expense_number, total: r.total });
    if (table === 'quotes') this.log('quote.created', r.id, { number: r.quote_number, total: r.total });
    if (table === 'sales' && ['paid', 'pending'].includes(r.status)) {
      if (this.itemsTables) this.salesSerialsTake(r);
      for (const l of this.lines(r.items)) this.stock(l.id, -l.qty, 'sale', { sale: r.id, variant: l.variant, location: this.rowLocation(r), serial: true });
    }
    if (table === 'sale_refunds' && this.itemsTables) this.refundSerialsApply(r);
    if (table === 'sale_refunds' && r.restock) for (const l of this.lines(r.items)) this.stock(l.id, l.qty, 'refund', { sale: r.sale_id, refund: r.id, variant: l.variant, location: this.rowLocation(r), serial: true });
    if (table === 'catalog_variants') this.hasVariants(r.item_id);
  }
  private beforeUpdate(table: string, old: Row, patch: Row): string | null {
    if (this.locationTables && FakeSupabase.LOCATED.includes(table) && 'location_id' in patch && (patch.location_id ?? null) !== (old.location_id ?? null)) {
      return 'location_fixed: a row keeps its location';
    }
    if (table === 'appointments') { const e = this.appointmentCheck({ ...old, ...patch }, old); if (e) return e; }
    if (table === 'expenses') {
      if (old.file_sha256) delete patch.file_sha256;
      if (patch.duplicate_ack) patch.duplicate_ack = { of: patch.duplicate_ack.of, reasons: patch.duplicate_ack.reasons, by: this.opts.userId, at: now() };
      else if ('duplicate_ack' in patch) delete patch.duplicate_ack;
    }
    if (table === 'quotes' && patch.status && patch.status !== old.status) {
      const next: Record<string, string[]> = { draft: ['sent', 'cancelled', 'converted'], sent: ['draft', 'accepted', 'rejected', 'expired', 'cancelled', 'converted'], accepted: ['converted', 'cancelled'], expired: ['sent', 'cancelled'] };
      if (!(next[old.status] ?? []).includes(patch.status)) return `quote_status: ${old.status} → ${patch.status} is not allowed`;
      if (patch.status === 'sent') patch.sent_at = now();
      if (patch.status === 'accepted' || patch.status === 'rejected') patch.decided_at = now();
    }
    if (table === 'document_drafts' && old.status !== 'open') return 'the draft was already issued';
    if (table === 'client_packages') {
      if (old.status === 'cancelled' && (patch.status ?? 'cancelled') !== 'cancelled') return 'a cancelled package stays cancelled';
      if (patch.status === 'cancelled' && old.status !== 'cancelled') {
        if (String(patch.cancel_reason ?? '').trim().length < 2) return 'a reason is required to cancel a package';
        Object.assign(patch, { cancelled_at: now(), cancelled_by: this.opts.userId });
      }
    }
    if (table === 'client_package_uses') {
      if (old.returned_at) return 'a deduction does not change — it is given back';
      if (patch.returned_at) Object.assign(patch, { returned_at: now(), returned_by: this.opts.userId });
    }
    if (table === 'client_sessions') {
      if (old.cancelled_at) return 'a cancelled session does not change';
      if (patch.cancelled_at) Object.assign(patch, { cancelled_at: now(), cancelled_by: this.opts.userId });
    }
    if (table === 'expenses' && old.status === 'void') return 'a void expense does not change';
    if (table === 'expenses' && patch.status === 'void') patch.voided_at = now();
    if (table === 'sales' && patch.status === 'cancelled' && old.status !== 'cancelled' && this.t('sale_refunds').some((x) => x.sale_id === old.id)) return 'a refunded sale can not be cancelled';
    if (table === 'catalog_items' && 'stock_qty' in patch && patch.stock_qty !== old.stock_qty) return 'stock changes only through adjust_stock';
    if (table === 'catalog_variants' && 'stock_qty' in patch && patch.stock_qty !== old.stock_qty) return 'stock changes only through a delivery or a count (adjust_variant_stock)';
    if (table === 'catalog_items' && old.track_serials && (patch.publish_online === true || (patch.kind && patch.kind !== 'product') || patch.track_stock === false)) {
      return 'new row for relation "catalog_items" violates check constraint "catalog_items_serials_check"';
    }
    if (table === 'catalog_items' && patch.publish_online && !old.published_at) patch.published_at = now();
    if (table === 'stores') {
      patch.updated_at = now();
      if ('slug' in patch && patch.slug !== old.slug) {
        if (['www', 'app', 'admin', 'api', 'mail', 'shop', 'store'].includes(patch.slug)) return 'store_slug_reserved';
        if (this.t('stores').some((x) => x.slug === patch.slug && x.id !== old.id)) return 'duplicate key value violates unique constraint "stores_slug_uq"';
        patch.subdomain_seen_at = null;
      }
      if ((patch.password_lock ?? old.password_lock) && (patch.storefront_password ?? old.storefront_password) === '') return 'store_lock_needs_password';
      if (patch.status === 'published' && old.status !== 'published') {
        const missing = this.storeMissing({ ...old, ...patch });
        if (missing.length) return `store_not_ready: ${missing.join(',')}`;
        patch.published_at = now();
      }
    }
    if (table === 'store_theme_versions') {
      if (old.status !== 'draft' && ('settings' in patch || 'note' in patch)) return 'only the draft is edited';
      if (patch.status === 'published' && old.status !== 'published') patch.published_at = now();
    }
    if (table === 'store_pages' || table === 'catalog_collections') {
      patch.updated_at = now();
      if (patch.slug && patch.slug !== old.slug && this.t(table).some((x) => x !== old && x.slug === patch.slug && (table === 'store_pages' ? x.store_id === old.store_id : x.business_id === old.business_id))) {
        return `duplicate key value violates unique constraint "${table === 'store_pages' ? 'store_pages_store_id_slug_key' : 'catalog_collections_slug_uq'}"`;
      }
      if ((table === 'store_pages' ? patch.published : patch.publish_online) && !old.published_at) patch.published_at = now();
    }
    return null;
  }
  private afterUpdate(table: string, old: Row, r: Row) {
    if (table === 'appointments') this.appointmentLog(old, r);
    if (table === 'client_sessions' && r.cancelled_at && !old.cancelled_at) {
      for (const u of this.t('client_package_uses').filter((x) => x.session_id === r.id && !x.returned_at)) {
        Object.assign(u, { returned_at: now(), returned_by: this.opts.userId, return_reason: `הטיפול בוטל${r.cancel_reason ? `: ${r.cancel_reason}` : ''}` });
      }
    }
    if (table === 'sales' && r.status === 'cancelled' && ['paid', 'pending'].includes(old.status)) {
      if (this.itemsTables) this.salesSerialsBack(r);
      for (const l of this.lines(r.items)) this.stock(l.id, l.qty, 'cancel', { sale: r.id, variant: l.variant, location: this.rowLocation(r), serial: true });
    }
  }

  // ---- 2.105: the calendar (migration 5700) -----------------------------------------------------------------------------------
  /**
   * b_appointment_staff and the overlap rules: a practitioner set or changed is an active one of the business's team; no two
   * active appointments at once — of one practitioner, and (without one) in one location. Before 5700: 4600's rule — one
   * appointment at a time in a location, practitioners or not.
   */
  private appointmentCheck(next: Row, old: Row | null): string | null {
    if (this.calendarTables && next.staff_id && (!old || next.staff_id !== old.staff_id)) {
      const s = this.t('lead_staff').find((x) => x.id === next.staff_id && x.business_id === next.business_id);
      if (!s?.active || !s.practitioner) return 'appointment_staff: not an active practitioner of this business';
    }
    const open = (x: Row) => ['booked', 'confirmed'].includes(x.status ?? 'booked');
    if (!open(next)) return null;
    const from = Date.parse(next.start_at), to = Date.parse(next.end_at);
    const meets = (x: Row) => x.id !== next.id && x.business_id === next.business_id && open(x) && Date.parse(x.start_at) < to && from < Date.parse(x.end_at);
    const here = (x: Row) => this.rowLocation(x) === this.rowLocation(next);
    const others = this.t('appointments').filter(meets);
    if (!this.calendarTables) {
      return others.some(here) ? 'conflicting key value violates exclusion constraint "appointments_location_no_overlap"' : null;
    }
    if (next.staff_id) {
      return others.some((x) => x.staff_id === next.staff_id) ? 'conflicting key value violates exclusion constraint "appointments_staff_no_overlap"' : null;
    }
    return others.some((x) => !x.staff_id && here(x)) ? 'conflicting key value violates exclusion constraint "appointments_unassigned_no_overlap"' : null;
  }
  /** z_appointment_log: what changed, who (her name on the team, else the account's) and when — the database writes it, nobody else */
  private appointmentLog(old: Row | null, r: Row) {
    if (!this.calendarTables) return;
    const staffName = (id: unknown) => (id ? this.t('lead_staff').find((x) => x.id === id)?.name ?? null : null);
    const who = this.opts.userId;
    const profile = this.t('profiles').find((p) => p.id === who);
    const name = this.t('lead_staff').find((x) => x.business_id === r.business_id && x.member_user_id === who && x.active)?.name
      || String(profile?.full_name ?? '').trim() || String(profile?.email ?? this.opts.email ?? '').trim();
    const add = (kind: string, before: Row, after: Row) => this.t('appointment_events').push({ id: randomUUID(), business_id: r.business_id, appointment_id: r.id,
      at: new Date((this.opts.clock?.() ?? Date.now()) + ++this.eventClock).toISOString(), actor: who, actor_name: name, kind, before, after });
    if (!old) {
      add('created', {}, { start: r.start_at, end: r.end_at, status: r.status ?? 'booked', source: r.source ?? 'manual', staff_id: r.staff_id ?? null, staff: staffName(r.staff_id) });
      return;
    }
    const at = (v: unknown) => (v ? Date.parse(String(v)) : NaN);
    if (at(old.start_at) !== at(r.start_at) || at(old.end_at) !== at(r.end_at)) add('moved', { start: old.start_at, end: old.end_at }, { start: r.start_at, end: r.end_at });
    if ((old.staff_id ?? null) !== (r.staff_id ?? null)) {
      add('staff', { staff_id: old.staff_id ?? null, staff: staffName(old.staff_id) }, { staff_id: r.staff_id ?? null, staff: staffName(r.staff_id) });
    }
    if (old.status !== r.status) add('status', { status: old.status }, { status: r.status });
    const b: Row = {}, a: Row = {};
    for (const f of ['name', 'phone', 'email', 'note', 'service_id', 'service_name', 'lead_id', 'location_id']) {
      if ((old[f] ?? null) !== (r[f] ?? null)) { b[f] = old[f] ?? null; a[f] = r[f] ?? null; }
    }
    if (Object.keys(a).length) add('edited', b, a);
  }

  // ---- 2.91: locations (migration 4600) ---------------------------------------------------------------------------------------
  static LOCATED = ['sales', 'register_shifts', 'sale_refunds', 'documents', 'document_drafts', 'payments', 'expenses', 'appointments', 'orders'];
  /** the business's locations and registers, the main ones first — every business has them, with its own id */
  places() {
    const b = this.opts.businessId;
    if (!this.t('business_locations').some((l) => l.id === b)) {
      this.t('business_locations').unshift({ id: b, business_id: b, name: 'ראשי', kind: 'branch', address: '', phone: '', hours: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' });
      if (!this.t('registers').some((x) => x.id === b)) this.t('registers').unshift({ id: b, business_id: b, location_id: b, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' });
    }
    const order = (x: Row, y: Row) => Number(y.id === b) - Number(x.id === b) || x.sort - y.sort || String(x.created_at).localeCompare(String(y.created_at));
    return { locations: [...this.t('business_locations')].sort(order), registers: [...this.t('registers')].sort(order) };
  }
  private mayUse(location: string) { return !this.memberLocations || this.memberLocations.includes(location); }
  /** location_filter(): what a signed-in user sees now — the location picked, else the member's own; null = every one */
  private locationFilter(): string[] | null {
    if (!this.locationTables) return null;
    if (this.currentLocation && this.mayUse(this.currentLocation)) return [this.currentLocation];
    return this.memberLocations;
  }
  private rowLocation(r: Row): string { return r.location_id ?? r.business_id ?? this.opts.businessId; }
  /** location_pick(): where a new row goes when nothing it belongs to says */
  private locationPick(): string | null {
    if (this.currentLocation && this.mayUse(this.currentLocation)) return this.currentLocation;
    const ok = this.places().locations.filter((l) => this.mayUse(l.id));
    return (ok.find((l) => l.active) ?? ok[0])?.id ?? null;
  }
  /** location_fill: a new row's location (and register) — what it belongs to decides; an error string refuses the row */
  private fillLocation(table: string, r: Row): string | null {
    if (!this.locationTables || !FakeSupabase.LOCATED.includes(table)) return null;
    const { locations, registers } = this.places();
    const find = (t: string, id: unknown) => (id ? this.t(t).find((x) => x.id === id) : undefined);
    let loc: string | null = null;
    if (['sales', 'register_shifts', 'sale_refunds'].includes(table)) {
      if (table === 'register_shifts' && !r.register_id) {
        const at = r.location_id ?? this.locationPick();
        r.register_id = registers.find((x) => x.active && x.location_id === at)?.id ?? null;
      }
      if (r.register_id) {
        const reg = registers.find((x) => x.id === r.register_id);
        if (!reg) return 'register_not_found';
        if (!(reg.active && locations.find((l) => l.id === reg.location_id)?.active) && table !== 'sale_refunds') return 'register_inactive: this register is closed down';
        if (r.location_id && r.location_id !== reg.location_id) return 'location_mismatch: a register stands in one location';
        loc = reg.location_id;
      }
    }
    if (!loc) {
      let from: Row | undefined;
      if (table === 'sale_refunds') { from = find('sales', r.sale_id); if (from) r.register_id ??= from.register_id ?? null; }
      if (table === 'sales') from = find('orders', r.id);
      if (table === 'documents') {
        from = find('sales', r.sale_id) ?? find('sale_refunds', r.refund_id) ?? find('documents', r.paid_document_id) ?? find('document_drafts', r.draft_id)
          ?? (r.base_doc_number != null ? this.t('documents').find((d) => d.doc_type === r.base_doc_type && d.doc_number === r.base_doc_number) : undefined);
      }
      if (table === 'payments') from = find('documents', r.document_id) ?? find('documents', r.applies_to) ?? find('sale_refunds', r.refund_id) ?? find('sales', r.sale_id) ?? find('expenses', r.expense_id);
      if (from) loc = this.rowLocation(from);
      if (table === 'orders') loc = find('stores', r.store_id)?.location_id ?? null;
    }
    if (r.location_id && loc && r.location_id !== loc) return 'location_mismatch: a row goes where what it belongs to is';
    r.location_id = r.location_id ?? loc ?? this.locationPick();
    if (r.location_id && !this.mayUse(r.location_id)) return 'not allowed: this location is not yours';
    const seen = this.locationFilter();
    if (seen && !seen.includes(this.rowLocation(r))) return 'new row violates row-level security policy (location gate)';
    return null;
  }
  /** e_documents_location: with more than one active location, a document's issuer names its location */
  private issuerLocation(r: Row): Row {
    if (!this.locationTables) return {};
    const { locations } = this.places();
    if (locations.filter((l) => l.active).length < 2) return {};
    const l = locations.find((x) => x.id === this.rowLocation(r));
    return l ? { location: { name: l.name, address: l.address ?? '', phone: l.phone ?? '' } } : {};
  }
  private locationRpc(fn: string, args: any): { status: number; body: any } | null {
    if (!['location_state', 'location_select', 'location_save', 'register_save'].includes(fn)) return null;
    if (!this.locationTables) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
    const refuse = (message: string, code = 'P0001') => ({ status: 400, body: { code, message, details: null, hint: null } });
    const b = this.opts.businessId;
    const { locations, registers } = this.places();
    const owner = this.owner && !this.memberLocations;
    if (fn === 'location_state') {
      const current = this.currentLocation && this.mayUse(this.currentLocation) ? this.currentLocation : null;
      return { status: 200, body: { business: b, current, limited: Boolean(this.memberLocations), owner,
        locations: locations.filter((l) => this.mayUse(l.id)).map((l) => ({ id: l.id, name: l.name, kind: l.kind, address: l.address, phone: l.phone, hours: l.hours,
          active: l.active, sort: l.sort, main: l.id === b })),
        registers: registers.filter((x) => this.mayUse(x.location_id)).map((x) => ({ id: x.id, location: x.location_id, name: x.name, device: x.device,
          active: x.active, sort: x.sort, main: x.id === b })) } };
    }
    if (fn === 'location_select') {
      const id = args.p_location ?? null;
      if (id && !locations.some((l) => l.id === id)) return refuse('location_not_found', '22023');
      if (id && !this.mayUse(id)) return refuse('not allowed', '42501');
      this.currentLocation = id;
      return { status: 200, body: { location: id } };
    }
    if (!owner) return refuse('not allowed', '42501');
    const trim = (v: unknown) => String(v ?? '').trim();
    if (fn === 'location_save') {
      const cur = this.t('business_locations').find((l) => l.id === args.p_id);
      const name = trim(args.p_name);
      if (!name || name.length > 60) return refuse('new row for relation "business_locations" violates check constraint "business_locations_name_check"', '23514');
      if (this.t('business_locations').some((l) => l.id !== args.p_id && l.name.trim().toLowerCase() === name.toLowerCase())) {
        return refuse('duplicate key value violates unique constraint "business_locations_name_uq"', '23505');
      }
      if (!cur) {
        if (this.t('business_locations').length >= 10) return refuse('locations_limit: up to 10 locations', '23514');
        const l = { id: args.p_id ?? randomUUID(), business_id: b, name, kind: args.p_kind ?? 'branch', address: trim(args.p_address), phone: trim(args.p_phone),
          hours: String(args.p_hours ?? ''), active: args.p_active ?? true, sort: args.p_sort ?? 0, created_at: now() };
        this.t('business_locations').push(l);
        if (l.kind !== 'warehouse') this.t('registers').push({ id: randomUUID(), business_id: b, location_id: l.id, name: 'קופה 1', device: '', active: true, sort: 0, created_at: now() });
        this.log('location.created', l.id, { name: l.name, kind: l.kind });
        return { status: 200, body: { id: l.id, created: true } };
      }
      if (cur.active && args.p_active === false) {
        if (!this.t('business_locations').some((l) => l.active && l.id !== cur.id)) return refuse('locations_last: one active location stays', '23514');
        if (this.t('register_shifts').some((s) => !s.closed_at && this.rowLocation(s) === cur.id)) return refuse('location_open_shift: close the open days of its registers first', '23514');
      }
      Object.assign(cur, { name, kind: args.p_kind ?? cur.kind, address: trim(args.p_address), phone: trim(args.p_phone), hours: String(args.p_hours ?? ''),
        active: args.p_active ?? cur.active, sort: args.p_sort ?? cur.sort });
      this.log('location.changed', cur.id, { name: cur.name, kind: cur.kind, active: cur.active });
      return { status: 200, body: { id: cur.id, created: false } };
    }
    // register_save
    const cur = this.t('registers').find((x) => x.id === args.p_id);
    const where = cur?.location_id ?? args.p_location;
    const name = trim(args.p_name);
    if (!name || name.length > 40) return refuse('new row for relation "registers" violates check constraint "registers_name_check"', '23514');
    if (this.t('registers').some((x) => x.id !== args.p_id && x.location_id === where && x.name.trim().toLowerCase() === name.toLowerCase())) {
      return refuse('duplicate key value violates unique constraint "registers_name_uq"', '23505');
    }
    if (!cur) {
      if (!this.t('business_locations').some((l) => l.id === where && l.active)) return refuse('register_location: an active location of the business', '22023');
      if (this.t('registers').filter((x) => x.location_id === where).length >= 10) return refuse('registers_limit: up to 10 registers a location', '23514');
      const x = { id: args.p_id ?? randomUUID(), business_id: b, location_id: where, name, device: trim(args.p_device), active: args.p_active ?? true, sort: args.p_sort ?? 0, created_at: now() };
      this.t('registers').push(x);
      this.log('register.created', x.id, { name: x.name, location: x.location_id });
      return { status: 200, body: { id: x.id, created: true } };
    }
    if (cur.active && args.p_active === false && this.t('register_shifts').some((s) => !s.closed_at && (s.register_id ?? b) === cur.id)) {
      return refuse('register_open_shift: close its open day first', '23514');
    }
    if (!cur.active && args.p_active === true && !this.t('business_locations').some((l) => l.id === cur.location_id && l.active)) {
      return refuse('register_location_inactive: its location is not active', '23514');
    }
    Object.assign(cur, { name, device: trim(args.p_device), active: args.p_active ?? cur.active, sort: args.p_sort ?? cur.sort });
    this.log('register.changed', cur.id, { name: cur.name, active: cur.active });
    return { status: 200, body: { id: cur.id, created: false } };
  }

  // ---- 2.92: stock by location (migration 4700) -------------------------------------------------------------------------------
  /** stock_ship_location(): the store's location for its orders, else the main one */
  shipLocation(): string { return this.t('stores')[0]?.location_id ?? this.opts.businessId; }
  /** location_owner(): the business's owner, with every location */
  private locationOwner() { return this.owner && !this.memberLocations; }
  /** the view stock_by_location: every tracked item (and variant) at the locations the member may use (not the switch) */
  stockByLocation(): Row[] {
    const b = this.opts.businessId, out: Row[] = [];
    const tracked = this.t('catalog_items').filter((i) => i.track_stock);
    const ids = new Set(tracked.map((i) => i.id));
    for (const r of this.t('stock_levels')) if (ids.has(r.item_id) && this.mayUse(r.location_id)) out.push({ location_id: r.location_id, item_id: r.item_id, variant_id: r.variant_id ?? null, qty: r.qty });
    if (this.mayUse(b)) {
      for (const i of tracked) out.push({ location_id: b, item_id: i.id, variant_id: null, qty: this.stockAt(b, i.id, null) });
      for (const v of this.t('catalog_variants').filter((x) => ids.has(x.item_id))) out.push({ location_id: b, item_id: v.item_id, variant_id: v.id, qty: this.stockAt(b, v.item_id, v.id) });
    }
    return out;
  }
  /** the read side of 4700's policies: the member's locations (levels), the locations seen now (transfers, counts, movements) */
  private stockGate(table: string): ((r: Row) => boolean) | null {
    if (!this.stockTables) return null;
    const seen = this.locationFilter();
    if (table === 'stock_levels') return this.memberLocations ? (r) => this.mayUse(r.location_id) : null;
    if (!seen) return null;
    if (table === 'stock_transfers') return (r) => seen.includes(r.from_location) || seen.includes(r.to_location);
    if (table === 'stock_counts') return (r) => seen.includes(r.location_id);
    if (table === 'stock_movements') return (r) => seen.includes(r.location_id ?? r.business_id ?? this.opts.businessId);
    return null;
  }
  private stockRpc(fn: string, args: any): { status: number; body: any } | null {
    if (!/^stock_(adjust|transfer_|count_)/.test(fn)) return null;
    if (!this.stockTables) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
    const b = this.opts.businessId;
    const refuse = (message: string, code = '22023') => ({ status: 400, body: { code, message, details: null, hint: null } });
    const ok = (body: any) => ({ status: 200, body });
    const place = (id: string) => this.places().locations.find((l) => l.id === id);
    const item = (id: string) => this.t('catalog_items').find((i) => i.id === id);
    const variantOf = (it: Row, id: string | null) => (id ? this.t('catalog_variants').find((v) => v.id === id && v.item_id === it.id) : undefined);
    const label = (v?: Row) => (v ? [v.option1, v.option2, v.option3].filter(Boolean).join(' / ') : '');
    if (fn === 'stock_adjust') {
      const it = item(args.p_item);
      if (!it) return refuse('not allowed', '42501');
      const loc = args.p_location ?? b;
      if (!place(loc)) return refuse('stock_location: a location of the business');
      if (!this.mayUse(loc)) return refuse('not allowed: this location is not yours', '42501');
      if (!args.p_variant && it.has_variants) return refuse('variant_required: an item with variants is counted per variant');
      const v = variantOf(it, args.p_variant ?? null);
      if (args.p_variant && !v) return refuse('variant_not_found: a variant of this item');
      if (args.p_mode === 'set' && !this.locationOwner()) return refuse('not allowed: the owner counts on the spot (others count in a stock count the owner approves)', '42501');
      if (it.track_serials) return refuse('serial_item: a product with serial numbers moves with its numbers (received, sold, returned)');
      const qty = Number(args.p_qty);
      if (args.p_mode === 'add' ? !(qty > 0) : !(qty >= 0)) return refuse(args.p_mode === 'add' ? 'a delivery adds at least one unit' : 'a count is zero or more');
      if (!it.track_stock) it.track_stock = true;
      const d = args.p_mode === 'add' ? qty : qty - this.stockAt(loc, it.id, v?.id ?? null);
      this.stock(it.id, d, args.p_mode === 'add' ? 'receive' : 'count', { variant: v?.id ?? null, note: args.p_note ?? '', location: loc });
      return ok(this.stockAt(loc, it.id, v?.id ?? null));
    }
    if (fn === 'stock_transfer_send') {
      const same = this.t('stock_transfers').find((x) => x.id === args.p_id);
      if (same) return ok({ id: same.id, number: same.number, created: false });
      if (args.p_from === args.p_to) return refuse('transfer_same: from one location to another');
      const from = place(args.p_from), to = place(args.p_to);
      if (!from?.active || !to?.active) return refuse('transfer_location: two open locations of the business');
      if (!this.mayUse(from.id)) return refuse('not allowed: this location is not yours', '42501');
      const lines = this.lines(args.p_lines);
      if (!Array.isArray(args.p_lines) || !args.p_lines.length || (args.p_lines as Row[]).some((l) => !l?.itemId || !/^[1-9][0-9]{0,5}$/.test(String(l.qty)))) {
        return refuse('transfer_lines: a product and a whole number of units on every line');
      }
      const out: Row[] = [];
      for (const l of lines) {
        const it = item(l.id);
        if (!it) return refuse('transfer_item: a product of the business');
        if (!it.track_stock) return refuse(`transfer_untracked: ${it.name}`);
        const v = variantOf(it, l.variant);
        if (l.variant && !v) return refuse(`transfer_variant: ${it.name}`);
        if (!l.variant && it.has_variants) return refuse(`transfer_variant_required: ${it.name}`);
        if (from.id === this.shipLocation()) {
          const held = this.heldQty(it.id, v?.id ?? null);
          if (held > 0 && l.qty > this.stockAt(from.id, it.id, v?.id ?? null) - held) return refuse(`reserved_for_online: ${it.name}${v ? ` — ${label(v)}` : ''}`, 'P0001');
        }
        // 4800: a product with numbers goes by its numbers — each in stock at the source
        let serials: string[] | null = null;
        if (this.itemsTables && it.track_serials) {
          const named = (args.p_lines as Row[]).filter((x) => x.itemId === it.id && (x.variantId ?? null) === (v?.id ?? null)).flatMap((x) => Array.isArray(x.serials) ? x.serials.map(String) : []);
          if (named.length !== l.qty) return refuse(`transfer_serials: ${it.name}${v ? ` — ${label(v)}` : ''}`);
          serials = [];
          for (const sn of named) {
            const x = this.serialOf(it.id, sn);
            if (!x) return refuse(`serial_not_found: ${sn.trim()}`);
            if ((x.variant_id ?? null) !== (v?.id ?? null)) return refuse(`serial_variant: ${sn.trim()}`);
            if (x.status === 'sold') return refuse(`serial_sold: ${sn.trim()}`, '23514');
            if (x.status !== 'in_stock' || serials.includes(x.serial)) return refuse(`serial_not_in_stock: ${sn.trim()}`, '23514');
            if (x.location_id !== from.id) return refuse(`serial_elsewhere: ${sn.trim()}`, '23514');
            serials.push(x.serial);
          }
        }
        out.push({ itemId: it.id, variantId: v?.id ?? null, name: it.name, variant: label(v), qty: l.qty, ...(serials ? { serials } : {}) });
      }
      const number = Math.max(0, ...this.t('stock_transfers').map((x) => x.number)) + 1;
      this.t('stock_transfers').push({ id: args.p_id, business_id: b, number, from_location: from.id, to_location: to.id, status: 'sent', lines: out,
        note: String(args.p_note ?? '').trim().slice(0, 300), sent_by: this.opts.userId, sent_at: now(), received_at: null, received_note: '', cancelled_at: null, cancel_reason: '' });
      for (const l of out) {
        for (const sn of l.serials ?? []) {
          const x = this.serialOf(l.itemId, sn)!;
          Object.assign(x, { status: 'in_transit', updated_at: now() });
          this.serialEvent(x.id, 'transfer_sent', { location_id: from.id, transfer_id: args.p_id, note: `העברה ${number} אל ${to.name}` });
        }
        this.stock(l.itemId, -l.qty, 'transfer', { variant: l.variantId, location: from.id, transfer: args.p_id, note: `העברה ${number} אל ${to.name}`, serial: true });
      }
      return ok({ id: args.p_id, number, created: true });
    }
    if (fn === 'stock_transfer_receive') {
      const t = this.t('stock_transfers').find((x) => x.id === args.p_id);
      if (!t) return refuse('not allowed', '42501');
      if (t.status === 'received') return ok({ result: 'already', number: t.number });
      if (t.status !== 'sent') return refuse('transfer_cancelled: this transfer was cancelled', '23514');
      if (!this.mayUse(t.to_location)) return refuse('not allowed: this location is not yours', '42501');
      const got: Row[] = Array.isArray(args.p_lines) ? args.p_lines : [];
      const from = place(t.from_location)?.name ?? '';
      let gaps = 0;
      const outl: Row[] = [];
      for (const e of t.lines) {
        const g = got.find((x) => x.itemId === e.itemId && (x.variantId ?? null) === (e.variantId ?? null));
        let rec = e.qty, why = '';
        if (Array.isArray(e.serials) && e.serials.length) {
          // 4800: a line with numbers names the ones that did not arrive
          const miss: string[] = Array.isArray(g?.missing) ? g!.missing.map(String) : [];
          if (miss.some((m) => !e.serials.some((x: string) => x.toLowerCase() === m.trim().toLowerCase()))) return refuse(`transfer_serial_missing: ${e.name}`);
          const missing = e.serials.filter((x: string) => miss.some((m) => m.trim().toLowerCase() === x.toLowerCase()));
          rec = e.qty - missing.length; why = String(g?.reason ?? '').trim().slice(0, 200);
          if (g && g.received != null && Number(g.received) !== rec) return refuse(`transfer_serial_missing: ${e.name}`);
          if (rec !== e.qty && !why) return refuse(`transfer_gap_reason: ${e.name}`);
          outl.push({ ...e, received: rec, reason: why, missing });
          continue;
        }
        if (g && g.received != null) {
          if (!/^[0-9]{1,6}$/.test(String(g.received))) return refuse('transfer_received: a whole number of units, zero or more');
          rec = Number(g.received); why = String(g.reason ?? '').trim().slice(0, 200);
        }
        if (rec !== e.qty && !why) return refuse(`transfer_gap_reason: ${e.name}`);
        outl.push({ ...e, received: rec, reason: why });
      }
      for (const e of outl) {
        this.stock(e.itemId, e.qty, 'transfer', { variant: e.variantId, location: t.to_location, transfer: t.id, note: `קבלת העברה ${t.number} מ${from}`, serial: true });
        if (e.received !== e.qty) { this.stock(e.itemId, e.received - e.qty, 'adjust', { variant: e.variantId, location: t.to_location, transfer: t.id, note: `פער בהעברה ${t.number}: ${e.reason}`, serial: true }); gaps++; }
        for (const sn of e.serials ?? []) {
          const x = this.serialOf(e.itemId, sn);
          if (!x || x.status !== 'in_transit') continue;
          const lost = (e.missing ?? []).includes(sn);
          Object.assign(x, { status: lost ? 'removed' : 'in_stock', location_id: t.to_location, updated_at: now() });
          this.serialEvent(x.id, lost ? 'transfer_missing' : 'transfer_received', { location_id: t.to_location, transfer_id: t.id,
            note: lost ? `לא הגיע בהעברה ${t.number}: ${e.reason}` : `קבלת העברה ${t.number} מ${from}` });
        }
      }
      Object.assign(t, { status: 'received', lines: outl, received_by: this.opts.userId, received_at: now(), received_note: String(args.p_note ?? '').trim().slice(0, 300) });
      return ok({ result: 'ok', number: t.number, gaps });
    }
    if (fn === 'stock_transfer_cancel') {
      const t = this.t('stock_transfers').find((x) => x.id === args.p_id);
      if (!t) return refuse('not allowed', '42501');
      if (t.status === 'cancelled') return ok({ result: 'already', number: t.number });
      if (t.status !== 'sent') return refuse('transfer_received: a received transfer is not cancelled', '23514');
      if (!(this.mayUse(t.from_location) || this.locationOwner())) return refuse('not allowed: this location is not yours', '42501');
      if (!String(args.p_reason ?? '').trim()) return refuse('transfer_cancel_reason: why it is cancelled');
      for (const e of t.lines) {
        this.stock(e.itemId, e.qty, 'transfer', { variant: e.variantId, location: t.from_location, transfer: t.id, note: `ביטול העברה ${t.number}`, serial: true });
        for (const sn of e.serials ?? []) {
          const x = this.serialOf(e.itemId, sn);
          if (!x || x.status !== 'in_transit') continue;
          Object.assign(x, { status: 'in_stock', location_id: t.from_location, updated_at: now() });
          this.serialEvent(x.id, 'transfer_cancelled', { location_id: t.from_location, transfer_id: t.id, note: `ביטול העברה ${t.number}` });
        }
      }
      Object.assign(t, { status: 'cancelled', cancelled_by: this.opts.userId, cancelled_at: now(), cancel_reason: String(args.p_reason).trim().slice(0, 300) });
      return ok({ result: 'ok', number: t.number });
    }
    if (fn === 'stock_count_start') {
      const same = this.t('stock_counts').find((x) => x.id === args.p_id);
      if (same) return ok({ id: same.id, number: same.number, created: false });
      const loc = args.p_location ?? b;
      if (!place(loc)) return refuse('stock_location: a location of the business');
      if (!this.mayUse(loc)) return refuse('not allowed: this location is not yours', '42501');
      const open = this.t('stock_counts').find((x) => x.location_id === loc && x.status === 'open');
      if (open) return refuse(`count_open: count ${open.number} of this location is open`, '23505');
      const number = Math.max(0, ...this.t('stock_counts').map((x) => x.number)) + 1;
      this.t('stock_counts').push({ id: args.p_id, business_id: b, number, location_id: loc, status: 'open', lines: {}, note: String(args.p_note ?? '').trim().slice(0, 300),
        result: null, created_by: this.opts.userId, created_at: now(), approved_at: null, cancelled_at: null });
      return ok({ id: args.p_id, number, created: true });
    }
    const count = this.t('stock_counts').find((x) => x.id === args.p_count);
    if (!count) return refuse('not allowed', '42501');
    /** as stock_count_lines: the location's count now, less what moved there since the line was counted (not by this count) */
    const results = () => Object.values(count.lines as Record<string, Row>).map((l) => {
      const since = this.t('stock_movements').filter((m) => m.item_id === l.itemId && (m.location_id ?? m.business_id) === count.location_id
        && (!l.variantId || m.variant_id === l.variantId) && m.created_at > l.at && m.count_id !== count.id).reduce((a, m) => a + Number(m.delta), 0);
      const expected = this.stockAt(count.location_id, l.itemId, l.variantId ?? null) - since;
      return { item_id: l.itemId, variant_id: l.variantId ?? null, counted: l.counted, expected, gap: l.counted - expected, counted_at: l.at };
    });
    if (fn === 'stock_count_lines') return ok(this.mayUse(count.location_id) ? results() : []);
    if (count.status === 'approved' && fn === 'stock_count_approve') return ok({ result: 'already', number: count.number });
    if (count.status === 'cancelled' && fn === 'stock_count_cancel') return ok({ result: 'already', number: count.number });
    if (count.status !== 'open') return refuse(`count_closed: this count is ${count.status}`, '23514');
    if (fn === 'stock_count_set') {
      if (!this.mayUse(count.location_id)) return refuse('not allowed: this location is not yours', '42501');
      const it = item(args.p_item);
      if (!it) return refuse('count_item: a product of the business');
      if (!args.p_variant && it.has_variants) return refuse('variant_required: an item with variants is counted per variant');
      if (args.p_variant && !variantOf(it, args.p_variant)) return refuse('variant_not_found: a variant of this item');
      if (args.p_counted != null && it.track_serials) return refuse(`count_serial: ${it.name}`);
      const k = `${it.id}:${args.p_variant ?? ''}`;
      if (args.p_counted == null) { const { [k]: _gone, ...rest } = count.lines; count.lines = rest; }
      else {
        if (!(Number(args.p_counted) >= 0)) return refuse('a count is zero or more');
        count.lines = { ...count.lines, [k]: { itemId: it.id, variantId: args.p_variant ?? null, counted: Number(args.p_counted), at: now(), by: this.opts.userId } };
      }
      return ok({ key: k, counted: args.p_counted ?? null });
    }
    if (fn === 'stock_count_approve') {
      if (!this.locationOwner()) return refuse('not allowed: the owner approves a count', '42501');
      if (!Object.keys(count.lines).length) return refuse('count_empty: nothing was counted', '23514');
      const res = results();
      let moved = 0;
      for (const r of res) {
        const it = item(r.item_id);
        if (it && !it.track_stock) it.track_stock = true;
        if (r.gap !== 0) { this.stock(r.item_id, r.gap, 'count', { variant: r.variant_id, location: count.location_id, count: count.id, note: `ספירה ${count.number}` }); moved++; }
      }
      Object.assign(count, { status: 'approved', approved_by: this.opts.userId, approved_at: now(),
        result: res.map((r) => ({ itemId: r.item_id, variantId: r.variant_id, counted: r.counted, expected: r.expected, gap: r.gap })) });
      return ok({ result: 'ok', number: count.number, moved });
    }
    if (fn === 'stock_count_cancel') {
      if (!(count.created_by === this.opts.userId || this.locationOwner())) return refuse('not allowed', '42501');
      Object.assign(count, { status: 'cancelled', cancelled_by: this.opts.userId, cancelled_at: now() });
      return ok({ result: 'ok', number: count.number });
    }
    return refuse(`unknown stock function ${fn}`, '42883');
  }

  // ---- 2.93: serial numbers, price lists, SKU series, comparing locations (migration 4800) -----------------------------------------
  private serialOf(itemId: string, serial: string) {
    const s = String(serial ?? '').trim().toLowerCase();
    return this.t('catalog_serials').find((x) => x.item_id === itemId && String(x.serial).toLowerCase() === s);
  }
  private serialEvent(serialId: string, kind: string, extra: Row = {}) {
    this.t('catalog_serial_events').push({ id: ++this.serialEventId, business_id: this.opts.businessId, serial_id: serialId, kind, location_id: null, sale_id: null,
      refund_id: null, transfer_id: null, note: '', by_user: this.opts.userId, at: now(), ...extra });
  }
  /** sale_serials_take's checks: a line of a product with numbers names one a unit, each in stock at the sale's location */
  private salesSerialsCheck(r: Row): string | null {
    const seen = new Set<string>();
    for (const e of Array.isArray(r.items) ? r.items : []) {
      const it = e?.itemId ? this.t('catalog_items').find((i) => i.id === e.itemId) : null;
      if (!it?.track_serials) continue;
      const q = Math.floor(Number(e.qty) || 0);
      if (q <= 0) continue;
      const arr: string[] = Array.isArray(e.serials) ? e.serials.map(String) : [];
      if (!arr.length && (r.channel ?? 'pos') !== 'pos') continue;
      if (arr.length !== q) return `serial_required: ${it.name}`;
      for (const sn of arr) {
        const x = this.serialOf(it.id, sn);
        if (!x) return `serial_not_found: ${sn.trim()}`;
        if ((x.variant_id ?? null) !== (e.variantId ?? null)) return `serial_variant: ${sn.trim()}`;
        if (x.status === 'sold' || seen.has(x.id)) return `serial_sold: ${sn.trim()}`;
        if (x.status !== 'in_stock') return `serial_not_in_stock: ${sn.trim()}`;
        if (x.location_id !== this.rowLocation(r)) return `serial_elsewhere: ${sn.trim()}`;
        seen.add(x.id);
      }
    }
    return null;
  }
  private salesSerialsTake(r: Row) {
    for (const e of Array.isArray(r.items) ? r.items : []) {
      const it = e?.itemId ? this.t('catalog_items').find((i) => i.id === e.itemId) : null;
      if (!it?.track_serials) continue;
      for (const sn of Array.isArray(e.serials) ? e.serials : []) {
        const x = this.serialOf(it.id, sn);
        if (!x) continue;
        Object.assign(x, { status: 'sold', sale_id: r.id, updated_at: now() });
        this.serialEvent(x.id, 'sold', { location_id: this.rowLocation(r), sale_id: r.id });
      }
    }
  }
  private salesSerialsBack(r: Row) {
    for (const x of this.t('catalog_serials').filter((y) => y.sale_id === r.id && y.status === 'sold')) {
      Object.assign(x, { status: 'in_stock', sale_id: null, location_id: this.rowLocation(r), updated_at: now() });
      this.serialEvent(x.id, 'cancelled', { location_id: this.rowLocation(r), sale_id: r.id });
    }
  }
  /** refund_serials' checks: a line of a product its sale sold by number names the numbers that came back, each of that sale */
  private refundSerialsCheck(r: Row): string | null {
    const soldBy = (itemId: string) => this.t('catalog_serial_events').some((e) => e.sale_id === r.sale_id && e.kind === 'sold'
      && this.t('catalog_serials').find((x) => x.id === e.serial_id)?.item_id === itemId);
    for (const e of Array.isArray(r.items) ? r.items : []) {
      if (!e?.itemId) continue;
      const arr: string[] = Array.isArray(e.serials) ? e.serials.map(String) : [];
      if (!arr.length && !soldBy(e.itemId)) continue;
      const q = Math.floor(Number(e.qty) || 0);
      if (q <= 0) continue;
      const name = this.t('catalog_items').find((i) => i.id === e.itemId)?.name ?? e.name ?? '';
      if (arr.length !== q) return `serial_required: ${name}`;
      for (const sn of arr) {
        const x = this.serialOf(e.itemId, sn);
        if (!x || x.sale_id !== r.sale_id || x.status !== 'sold') return `serial_not_in_sale: ${sn.trim()}`;
      }
    }
    return null;
  }
  private refundSerialsApply(r: Row) {
    for (const e of Array.isArray(r.items) ? r.items : []) {
      for (const sn of Array.isArray(e?.serials) ? e.serials : []) {
        const x = e.itemId ? this.serialOf(e.itemId, sn) : null;
        if (!x) continue;
        Object.assign(x, { status: r.restock ? 'in_stock' : 'returned', sale_id: null, location_id: this.rowLocation(r), updated_at: now() });
        this.serialEvent(x.id, 'returned', { location_id: this.rowLocation(r), sale_id: r.sale_id, refund_id: r.id, note: r.restock ? '' : 'לא חזר למלאי' });
      }
    }
  }
  private itemsRpc(fn: string, args: any): { status: number; body: any } | null {
    if (!['serial_tracking', 'serial_receive', 'serial_remove', 'price_list_save', 'price_list_set', 'sku_series_save', 'sku_next', 'location_compare'].includes(fn)) return null;
    if (!this.itemsTables) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
    const b = this.opts.businessId;
    const refuse = (message: string, code = '22023') => ({ status: 400, body: { code, message, details: null, hint: null } });
    const ok = (body: any) => ({ status: 200, body });
    const item = (id: string) => this.t('catalog_items').find((i) => i.id === id);
    const trim = (v: unknown) => String(v ?? '').trim();
    if (fn === 'serial_tracking') {
      const it = item(args.p_item);
      if (!it) return refuse('not allowed', '42501');
      if (Boolean(it.track_serials) === Boolean(args.p_on)) return ok({ item: it.id, on: Boolean(args.p_on), changed: false });
      if (args.p_on) {
        if (it.kind !== 'product') return refuse('serial_kind: only a product has serial numbers');
        if (it.publish_online) return refuse('serial_online: a product with serial numbers is not sold on the site yet');
        if (this.t('stock_counts').some((c) => c.status === 'open' && Object.values(c.lines ?? {}).some((l: any) => l.itemId === it.id))) return refuse('serial_counting: the product is in an open stock count', '23514');
        if (this.t('stock_transfers').some((t) => t.status === 'sent' && t.lines.some((l: Row) => l.itemId === it.id))) return refuse('serial_on_the_way: the product is on the way in a transfer', '23514');
        if (this.heldQty(it.id, null) > 0) return refuse('serial_reserved: units of it are held for an order of the site', '23514');
        Object.assign(it, { track_serials: true, track_stock: true });
      } else {
        const n = this.t('catalog_serials').filter((x) => x.item_id === it.id && ['in_stock', 'in_transit'].includes(x.status)).length;
        if (n) return refuse(`serial_in_stock: ${n} units with serial numbers are in stock`, '23514');
        it.track_serials = false;
      }
      return ok({ item: it.id, on: Boolean(args.p_on), changed: true });
    }
    if (fn === 'serial_receive') {
      const it = item(args.p_item);
      if (!it) return refuse('not allowed', '42501');
      if (!it.track_serials) return refuse('serial_untracked: the product has no serial numbers');
      if (!args.p_variant && it.has_variants) return refuse('variant_required: an item with variants is counted per variant');
      if (args.p_variant && !this.t('catalog_variants').some((v) => v.id === args.p_variant && v.item_id === it.id)) return refuse('variant_not_found: a variant of this item');
      const loc = args.p_location ?? b;
      if (!this.places().locations.some((l) => l.id === loc)) return refuse('stock_location: a location of the business');
      if (!this.mayUse(loc)) return refuse('not allowed: this location is not yours', '42501');
      const list: string[] = [];
      for (const raw of Array.isArray(args.p_serials) ? args.p_serials : []) {
        const t = trim(raw);
        if (!t) continue;
        if (t.length > 64) return refuse(`serial_long: ${t.slice(0, 64)}`);
        if (list.some((x) => x.toLowerCase() === t.toLowerCase())) return refuse(`serial_twice: ${t}`);
        list.push(t);
      }
      if (!list.length || list.length > 200) return refuse('serial_list: 1 to 200 serial numbers');
      const taken = list.find((x) => this.serialOf(it.id, x));
      if (taken) return refuse(`serial_taken: ${taken}`, '23505');
      const variant = args.p_variant ?? null;
      if (args.p_existing) {
        const free = this.stockAt(loc, it.id, variant) - this.t('catalog_serials').filter((x) => x.item_id === it.id && (x.variant_id ?? null) === variant && x.location_id === loc && x.status === 'in_stock').length;
        if (list.length > free) return refuse(`serial_more_than_stock: ${Math.max(free, 0)} units here have no number`, '23514');
      }
      const note = trim(args.p_note).slice(0, 200);
      for (const sn of list) {
        const row = { id: randomUUID(), business_id: b, item_id: it.id, variant_id: variant, serial: sn, status: 'in_stock', location_id: loc, sale_id: null,
          received_at: now(), received_by: this.opts.userId, updated_at: now() };
        this.t('catalog_serials').push(row);
        this.serialEvent(row.id, args.p_existing ? 'registered' : 'received', { location_id: loc, note });
      }
      if (!args.p_existing) this.stock(it.id, list.length, 'receive', { variant, location: loc, serial: true, note: `קליטה · ${list.join(', ')}${note ? ` · ${note}` : ''}`.slice(0, 200) });
      return ok({ count: list.length, stock: this.stockAt(loc, it.id, variant) });
    }
    if (fn === 'serial_remove') {
      if (!this.locationOwner()) return refuse('not allowed: the owner counts on the spot (others count in a stock count the owner approves)', '42501');
      const x = this.t('catalog_serials').find((y) => y.id === args.p_serial);
      if (!x) return refuse('not allowed', '42501');
      if (x.status !== 'in_stock') return refuse(`serial_not_in_stock: ${x.serial}`, '23514');
      const why = trim(args.p_reason).slice(0, 200);
      if (!why) return refuse('serial_reason: why it leaves the stock');
      Object.assign(x, { status: 'removed', updated_at: now() });
      this.serialEvent(x.id, 'removed', { location_id: x.location_id, note: why });
      this.stock(x.item_id, -1, 'adjust', { variant: x.variant_id, location: x.location_id, serial: true, note: `הוצאה · ${x.serial} · ${why}`.slice(0, 200) });
      return ok({ serial: x.serial, status: 'removed' });
    }
    if (fn === 'price_list_save') {
      if (!args.p_id) return refuse('price_list_id: a new list has an id');
      const name = trim(args.p_name);
      if (!name || name.length > 40) return refuse('price_list_name: a name of 1 to 40 characters');
      const tag = trim(args.p_tag) || null;
      const lists = this.t('price_lists');
      const cur = lists.find((l) => l.id === args.p_id);
      const kind = cur?.kind ?? args.p_kind;
      const active = args.p_active ?? cur?.active ?? true;
      if (lists.some((l) => l.id !== args.p_id && l.name.toLowerCase() === name.toLowerCase())) return refuse('duplicate key value violates unique constraint "price_lists_name_uq"', '23505');
      const theTag = kind === 'group' ? (tag ?? cur?.tag ?? null) : null;
      if (kind === 'group' && active && lists.some((l) => l.id !== args.p_id && l.kind === 'group' && l.active && String(l.tag).toLowerCase() === String(theTag).toLowerCase())) {
        return refuse('duplicate key value violates unique constraint "price_lists_tag_uq"', '23505');
      }
      if (cur) { Object.assign(cur, { name, tag: theTag, active, sort: args.p_sort ?? cur.sort }); return ok({ id: cur.id, created: false }); }
      if (kind === 'location') {
        if (!args.p_location || !this.places().locations.some((l) => l.id === args.p_location)) return refuse('stock_location: a location of the business');
        if (active && lists.some((l) => l.kind === 'location' && l.active && l.location_id === args.p_location)) return refuse('duplicate key value violates unique constraint "price_lists_location_uq"', '23505');
      } else if (kind === 'group') {
        if (!tag) return refuse("price_list_tag: the customers' tag");
      } else return refuse("price_list_kind: a location's list or a group's");
      lists.push({ id: args.p_id, business_id: b, name, kind, location_id: kind === 'location' ? args.p_location : null, tag: theTag, active, sort: args.p_sort ?? 0, created_at: now() });
      return ok({ id: args.p_id, created: true });
    }
    if (fn === 'price_list_set') {
      const pl = this.t('price_lists').find((l) => l.id === args.p_list);
      if (!pl) return refuse('not allowed', '42501');
      const lines: Row[] = Array.isArray(args.p_lines) ? args.p_lines : [];
      if (!lines.length || lines.length > 500) return refuse('price_list_lines: 1 to 500 lines');
      for (const e of lines) {
        if (!e?.itemId) return refuse('price_list_lines: a product on every line');
        if (!item(e.itemId)) return refuse('price_list_item: a product of the business');
        const v = e.variantId ?? null;
        if (v && !this.t('catalog_variants').some((x) => x.id === v && x.item_id === e.itemId)) return refuse('variant_not_found: a variant of this item');
        const rows = this.t('price_list_items');
        const at = rows.findIndex((x) => x.list_id === pl.id && x.item_id === e.itemId && (x.variant_id ?? null) === v);
        if (e.price == null) { if (at >= 0) rows.splice(at, 1); continue; }
        if (!/^[0-9]{1,7}(\.[0-9]{1,2})?$/.test(String(e.price))) return refuse('price_list_price: a price of 0 or more, in shekels and agorot');
        if (at >= 0) Object.assign(rows[at], { price: Number(e.price), updated_at: now() });
        else rows.push({ list_id: pl.id, business_id: b, item_id: e.itemId, variant_id: v, price: Number(e.price), updated_at: now() });
      }
      return ok({ list: pl.id, lines: lines.length });
    }
    if (fn === 'sku_series_save') {
      if (!args.p_id) return refuse('sku_series_id: a new series has an id');
      const name = trim(args.p_name), prefix = trim(args.p_prefix).toUpperCase();
      if (!name || name.length > 40) return refuse('sku_series_name: a name of 1 to 40 characters');
      if (!/^[A-Z0-9]{1,6}$/.test(prefix)) return refuse('sku_series_prefix: 1 to 6 letters (A-Z) or digits');
      const digits = args.p_digits ?? 4, next = args.p_next ?? null;
      if (!(digits >= 3 && digits <= 6)) return refuse('sku_series_digits: 3 to 6 digits');
      if (next != null && !(next >= 1 && next <= 999999)) return refuse('sku_series_next: from 1');
      const all = this.t('sku_series');
      if (all.some((x) => x.id !== args.p_id && x.prefix === prefix)) return refuse('duplicate key value violates unique constraint "sku_series_prefix_uq"', '23505');
      if (all.some((x) => x.id !== args.p_id && x.name.toLowerCase() === name.toLowerCase())) return refuse('duplicate key value violates unique constraint "sku_series_name_uq"', '23505');
      const cur = all.find((x) => x.id === args.p_id);
      if (cur) { Object.assign(cur, { name, prefix, digits, next_no: next ?? cur.next_no, active: args.p_active ?? cur.active }); return ok({ id: cur.id, created: false }); }
      all.push({ id: args.p_id, business_id: b, name, prefix, digits, next_no: next ?? 1, active: args.p_active ?? true, created_at: now() });
      return ok({ id: args.p_id, created: true });
    }
    if (fn === 'sku_next') {
      const sr = this.t('sku_series').find((x) => x.id === args.p_series);
      if (!sr) return refuse('not allowed', '42501');
      if (!sr.active) return refuse('sku_series_closed: the series is not active', '23514');
      const taken = (c: string) => this.t('catalog_items').some((i) => String(i.sku ?? '').toLowerCase() === c.toLowerCase())
        || this.t('catalog_variants').some((v) => String(v.sku ?? '').toLowerCase() === c.toLowerCase());
      for (;;) {
        if (sr.next_no > 10 ** sr.digits - 1) return refuse('sku_series_full: the series has no number left', '23514');
        const code = `${sr.prefix}-${String(sr.next_no).padStart(sr.digits, '0')}`;
        sr.next_no++;
        if (!taken(code)) return ok(code);
      }
    }
    // location_compare: each location the member may use, side by side (finance_summary's rules, the sales, the stock now)
    const from = String(args.p_from), to = String(args.p_to);
    if (!from || !to || from > to) return refuse('bad range');
    const inRange = (d: string | null | undefined) => Boolean(d) && d! >= from && d! <= to;
    const ilDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
    const vat = this.vatBusiness();
    const cancelled = new Set(this.t('document_cancellations').map((c) => c.document_id));
    const rows = this.stockByLocation();
    const locs = this.places().locations.filter((l) => this.mayUse(l.id));
    const round = (n: number) => Math.round(n * 100) / 100;
    return ok({ from, to, vat, locations: locs.map((l) => {
      const at = (r: Row) => this.rowLocation(r) === l.id;
      const docs = this.t('documents').filter((d) => at(d) && inRange(d.doc_date));
      const net = docs.reduce((a, d) => a + (vat ? (d.doc_type === 305 || d.doc_type === 320 ? Number(d.after_discount) : d.doc_type === 330 ? -Number(d.after_discount) : 0)
        : d.doc_type === 400 && !cancelled.has(d.id) ? Number(d.total) : 0), 0);
      const vatA = docs.reduce((a, d) => a + (vat ? (d.doc_type === 305 || d.doc_type === 320 ? Number(d.vat_amount) : d.doc_type === 330 ? -Number(d.vat_amount) : 0) : 0), 0);
      const ex = this.t('expenses').filter((x) => at(x) && x.status === 'confirmed' && inRange(x.doc_date));
      const sign = (x: Row) => (x.supplier_doc_type === 'credit' ? -1 : 1);
      const exNet = ex.reduce((a, x) => a + sign(x) * Number(x.amount_before_vat), 0);
      const cost = ex.reduce((a, x) => a + sign(x) * (Number(x.amount_before_vat) + Number(x.vat_amount) - (vat ? round(Number(x.vat_amount) * Number(x.vat_deductible_pct ?? 100) / 100) : 0)), 0);
      // 2.96 (5100): the manual entries at this location — income (and VAT on sales), an expense at its amount before VAT
      const jl = this.journalTables ? this.t('journal_entries').filter((j) => j.business_id === b && j.location_id === l.id && inRange(j.entry_date)) : [];
      const jIncome = jl.filter((j) => j.kind === 'income').reduce((a, j) => a + Number(j.amount), 0);
      const jVat = jl.filter((j) => j.kind === 'income' || (j.kind === 'vat' && j.vat_side === 'output')).reduce((a, j) => a + Number(j.vat), 0);
      const jExpense = jl.filter((j) => j.kind === 'expense').reduce((a, j) => a + Number(j.amount), 0);
      const sales = this.t('sales').filter((x) => at(x) && x.status === 'paid' && inRange(ilDay(x.paid_at ?? x.created_at)));
      const refunds = this.t('sale_refunds').filter((x) => at(x) && inRange(ilDay(x.created_at)));
      const lines = new Map<string, { itemId: string | null; name: string; qty: number; total: number }>();
      for (const sa of sales) for (const e of Array.isArray(sa.items) ? sa.items : []) {
        const k = e.itemId ? `${e.itemId}|${e.variantId ?? ''}` : `name:${e.name ?? ''}`;
        const cur = lines.get(k) ?? { itemId: e.itemId ?? null, name: String(e.name ?? ''), qty: 0, total: 0 };
        cur.qty += Number(e.qty) || 0; cur.total += (Number(e.qty) || 0) * (Number(e.price) || 0); lines.set(k, cur);
      }
      const here = rows.filter((r) => r.location_id === l.id);
      const value = here.reduce((a, r) => {
        const it = this.t('catalog_items').find((i) => i.id === r.item_id);
        if (!it) return a;
        if (r.variant_id == null) return it.has_variants ? a : a + Math.max(0, r.qty) * Number(it.price);
        const v = this.t('catalog_variants').find((x) => x.id === r.variant_id);
        return a + Math.max(0, r.qty) * Number(v?.price ?? it.price);
      }, 0);
      return { id: l.id, name: l.name, active: l.active, main: l.id === b,
        revenue: { net: round(net + jIncome), vat: round(vatA + jVat) }, expenses: { net: round(exNet + jExpense), cost: round(cost + jExpense) },
        profit: round(net + jIncome - cost - jExpense),
        sales: { count: sales.length, total: round(sales.reduce((a, x) => a + Number(x.total), 0)), online: sales.filter((x) => x.channel === 'online').length,
          refunds: round(refunds.reduce((a, x) => a + Number(x.amount), 0)), refundCount: refunds.length },
        items: [...lines.values()].sort((x, y) => y.total - x.total || x.name.localeCompare(y.name)).slice(0, 10).map((x) => ({ ...x, total: round(x.total) })),
        stock: { units: here.filter((r) => r.variant_id == null).reduce((a, r) => a + r.qty, 0), value: round(value) } };
    }) });
  }

  /** 2.94 (4900): report_* — the database's rules (tests/sql/reports.check.sql proves those) on the fake's rows */
  private reportsRpc(fn: string, args: any): { status: number; body: any } | null {
    if (!/^report_/.test(fn)) return null;
    if (!this.reportsTables) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
    const from = String(args.p_from ?? ''), to = String(args.p_to ?? '');
    if (!from || !to || from > to) return { status: 400, body: { code: '22023', message: 'bad range' } };
    const ok = (body: any) => ({ status: 200, body });
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const vat = this.vatBusiness();
    const all = this.t('documents');
    const cancelled = (id: string) => this.t('document_cancellations').find((c) => c.document_id === id) ?? null;
    const rev = (d: Row) => (vat ? (d.doc_type === 305 || d.doc_type === 320 ? Number(d.after_discount) : d.doc_type === 330 ? -Number(d.after_discount) : 0)
      : d.doc_type === 400 && !cancelled(d.id) ? Number(d.total) : 0);
    const vatOf = (d: Row) => (vat ? (d.doc_type === 305 || d.doc_type === 320 ? Number(d.vat_amount) : d.doc_type === 330 ? -Number(d.vat_amount) : 0) : 0);
    const key = (d: Row) => partyKey({ leadId: d.lead_id, dealer: d.customer_dealer, name: d.customer_name });
    const supplierKey = (e: Row) => partyKey({ dealer: e.supplier_dealer, name: e.supplier_name });
    const docs = all.filter((d) => d.doc_date >= from && d.doc_date <= to).sort((a, b) => `${a.doc_date}${a.issued_at ?? ''}`.localeCompare(`${b.doc_date}${b.issued_at ?? ''}`));
    const leadName = (id: string | null) => (id ? this.t('leads').find((l) => l.id === id)?.name ?? null : null);
    const ilDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
    // 2.96 (5100): the manual journal entries the reports read (as the signed-in user: the location picked), and of the period
    const journal = this.journalTables ? this.journalSeen() : [];
    const entries = journal.filter((j) => j.entry_date >= from && j.entry_date <= to);
    const noManual = (o: Row): Row => { if (this.journalTables) return o; const { manual: _m, ...rest } = o; return rest; };
    /** a card: the opening balance (before the period), the rows of the period with the balance as it runs */
    const card = (mv: Row[], sign: 1 | -1) => {
      mv.sort((a, b) => `${a.day}|${a.at}|${a.kind}|${a.rid}`.localeCompare(`${b.day}|${b.at}|${b.kind}|${b.rid}`));
      const opening = r2(mv.filter((m) => m.day < from).reduce((a, m) => a + sign * (m.debit - m.credit), 0));
      let bal = opening;
      const rows = mv.filter((m) => m.day >= from && m.day <= to).map((m): Row => { bal = r2(bal + sign * (m.debit - m.credit)); const { at: _a, rid: _r, ...rest } = m; return { ...rest, date: m.day, balance: bal }; });
      const debit = r2(rows.reduce((a, m) => a + m.debit, 0)), credit = r2(rows.reduce((a, m) => a + m.credit, 0));
      return { opening, debit, credit, closing: r2(opening + sign * (debit - credit)), rows: rows.map(({ day: _d, ...x }): Row => x) };
    };

    if (fn === 'report_income_by_customer') {
      // the documents, and (2.96) a manual income entry or a VAT entry on sales — by its customer, or on a line of its own ("m:")
      const rows: Row[] = [
        ...docs.filter((x) => (vat && [305, 320, 330].includes(x.doc_type)) || (!vat && x.doc_type === 400 && !cancelled(x.id)))
          .map((d) => ({ k: key(d), lead: d.lead_id ?? null, dealer: d.customer_dealer ?? '', name: d.customer_name ?? '', at: `${d.doc_date}${d.issued_at ?? ''}`, net: rev(d), vat: vatOf(d), manual: 0 })),
        ...entries.filter((j) => j.kind === 'income' || (j.kind === 'vat' && j.vat_side === 'output')).map((j) => {
          const c = j.party_kind === 'customer';
          return { k: c ? partyKey({ leadId: j.lead_id, dealer: j.party_dealer, name: j.party_name }) : MANUAL_KEY, lead: j.lead_id ?? null, dealer: j.party_dealer ?? '',
            name: c ? j.party_name : '', at: `${j.entry_date}${j.created_at ?? ''}`, net: Number(j.amount), vat: Number(j.vat), manual: Number(j.amount) };
        }),
      ].sort((a, b) => a.at.localeCompare(b.at));
      const g = new Map<string, Row>();
      for (const r of rows) {
        const x = g.get(r.k) ?? { key: r.k, leadId: null, name: '', dealer: '', net: 0, vat: 0, count: 0, manual: 0 };
        x.net = r2(x.net + r.net); x.vat = r2(x.vat + r.vat); x.manual = r2(x.manual + r.manual); x.count++;
        if (r.lead) x.leadId = r.lead;
        if (r.dealer) x.dealer = r.dealer;
        x.name = r.name;
        g.set(r.k, x);
      }
      const customers = [...g.values()].map((x): Row => noManual({ ...x, name: leadName(x.leadId) ?? x.name, gross: r2(x.net + x.vat) })).sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
      return ok({ from, to, vat, total: noManual({ net: r2(customers.reduce((a, c) => a + c.net, 0)), vat: r2(customers.reduce((a, c) => a + c.vat, 0)),
        count: customers.reduce((a, c) => a + c.count, 0), manual: r2(customers.reduce((a, c) => a + (c.manual ?? 0), 0)) }), customers });
    }
    if (fn === 'report_sales_by_item') {
      const items = new Map<string, Row>();
      let total = 0, unNet = 0, unN = 0;
      for (const d of docs) {
        const amt = rev(d);
        if (!amt) continue;
        total = r2(total + amt);
        const own = Array.isArray(d.lines) && d.lines.length > 0;
        const paid = !own && d.paid_document_id ? all.find((x) => x.id === d.paid_document_id) : null;
        // the register's and the site's documents: the lines of the refund (what came back), else of the sale — they carry the item
        const asLines = (items: any): Row[] => (Array.isArray(items) ? items : []).filter((e: Row) => Number(e.qty) > 0)
          .map((e: Row) => ({ name: e.name ?? '', qty: Number(e.qty), itemId: e.itemId, variantId: e.variantId, totalExVat: Number(e.qty) * (Number(e.price) || 0) }));
        const refund = d.refund_id ? this.t('sale_refunds').find((r) => r.id === d.refund_id) : null;
        const sale = this.t('sales').find((x) => x.id === (d.sale_id ?? refund?.sale_id));
        const rl = asLines(refund?.items), sl = asLines(sale?.items);
        const lines: Row[] = rl.length ? rl : sl.length ? sl : own ? d.lines : Array.isArray(paid?.lines) ? paid!.lines : [];
        const frac = rl.length ? 1 : sl.length ? (d.refund_id ? Math.abs(Number(d.total)) / (Number(sale!.total) || Infinity) : 1)
          : own ? 1 : paid && Number(paid.total) ? Math.abs(amt) / Number(paid.total) : 0;
        const base = lines.map((l) => Number(l.totalExVat) || 0), tot = base.reduce((a, b) => a + b, 0);
        if (!lines.length || !tot) { unNet = r2(unNet + amt); unN++; continue; }
        const share = base.map((b) => r2((amt * b) / tot));
        let big = 0; base.forEach((b, i) => { if (Math.abs(b) > Math.abs(base[big])) big = i; });
        share[big] = r2(share[big] + amt - share.reduce((a, b) => a + b, 0));
        lines.forEach((l, i) => {
          const k = l.itemId ? `${l.itemId}|${l.variantId ?? ''}` : `name:${l.name ?? ''}`;
          const x = items.get(k) ?? { key: k, itemId: l.itemId ?? null, variantId: l.variantId ?? null, name: l.name ?? '', qty: 0, net: 0 };
          x.qty += Math.sign(amt) * frac * (Number(l.qty) || 0); x.net = r2(x.net + share[i]);
          items.set(k, x);
        });
      }
      const out = [...items.values()].map((x) => {
        const ci = x.itemId ? this.t('catalog_items').find((c) => c.id === x.itemId) : null;
        const typeId = ci ? (ci.kind === 'package' ? ci.package_type_id ?? null : ci.treatment_type_id ?? null) : null;
        return { key: x.key, itemId: x.itemId, variantId: x.variantId, name: x.variantId ? x.name : ci?.name ?? x.name, kind: ci?.kind ?? '', typeId, qty: r2(x.qty), net: x.net };
      }).sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
      const types = new Map<string, Row>();
      for (const i of out) {
        const t = types.get(i.typeId ?? '') ?? { typeId: i.typeId, name: i.typeId ? this.t('treatment_types').find((x) => x.id === i.typeId)?.name ?? '' : '', qty: 0, net: 0 };
        t.qty = r2(t.qty + i.qty); t.net = r2(t.net + i.net); types.set(i.typeId ?? '', t);
      }
      // 2.96 (5100): the manual income entries — in the total, and a line of their own (no item, no treatment type)
      const inc = entries.filter((j) => j.kind === 'income'), mNet = r2(inc.reduce((a, j) => a + Number(j.amount), 0));
      return ok({ from, to, vat, total: r2(total + mNet), items: out, types: [...types.values()].sort((a, b) => b.net - a.net || a.name.localeCompare(b.name)),
        unattributed: { net: unNet, count: unN }, ...(this.journalTables ? { manual: { net: mNet, count: inc.length } } : {}) });
    }
    if (fn === 'report_customer_ledger') {
      if (!/^(l|d|n):/.test(String(args.p_key ?? ''))) return { status: 400, body: { code: '22023', message: 'customer: a key' } };
      const mine = all.filter((d) => key(d) === args.p_key), ids = new Set(mine.map((d) => d.id));
      const mv: Row[] = [];
      for (const d of mine) {
        const base = { at: d.issued_at ?? '', docType: d.doc_type, docNumber: d.doc_number, method: '', rid: d.id };
        if ([300, 305].includes(d.doc_type) || ([320, 400].includes(d.doc_type) && !d.paid_document_id)) mv.push({ ...base, day: d.doc_date, kind: 'charge', debit: Number(d.total), credit: 0 });
        if (d.doc_type === 330) mv.push({ ...base, day: d.doc_date, kind: 'credit', debit: 0, credit: Number(d.total) });
        const c = cancelled(d.id);
        if (c && (d.doc_type === 300 || (d.doc_type === 400 && !d.paid_document_id))) mv.push({ ...base, day: c.created_at ? ilDay(c.created_at) : this.today(), at: c.created_at ?? '', kind: 'cancelled', debit: 0, credit: Number(d.total) });
      }
      for (const p of this.t('payments').filter((x) => ['document', 'credit', 'cancel', 'refund'].includes(x.source))) {
        const docId = p.document_id ?? (p.refund_id ? all.find((r) => r.refund_id === p.refund_id && r.doc_type === 330)?.id : null) ?? p.applies_to;
        if (!docId || !ids.has(docId)) continue;
        const x = all.find((d) => d.id === docId)!;
        mv.push({ day: p.paid_on, at: p.created_at ?? '', kind: `payment_${p.source}`, docType: x.doc_type, docNumber: x.doc_number,
          debit: p.direction === 'out' ? Number(p.amount) : 0, credit: p.direction === 'in' ? Number(p.amount) : 0, method: p.method, rid: p.id });
      }
      // 2.96 (5100): a manual entry of this customer — owed more when it is positive, less when it is negative
      const mineJ = journal.filter((j) => j.party_kind === 'customer' && partyKey({ leadId: j.lead_id, dealer: j.party_dealer, name: j.party_name }) === args.p_key);
      for (const j of mineJ) {
        const gross = Number(j.amount) + Number(j.vat);
        mv.push({ day: j.entry_date, at: j.created_at ?? '', kind: 'manual', docType: null, docNumber: j.number, debit: Math.max(gross, 0), credit: Math.max(-gross, 0), method: '', rid: j.id, note: j.explanation });
      }
      const last = [...mine].sort((a, b) => `${b.doc_date}${b.issued_at ?? ''}`.localeCompare(`${a.doc_date}${a.issued_at ?? ''}`))[0];
      const lastJ = [...mineJ].sort((a, b) => `${b.entry_date}${b.created_at ?? ''}`.localeCompare(`${a.entry_date}${a.created_at ?? ''}`))[0];
      const name = (String(args.p_key).startsWith('l:') ? leadName(String(args.p_key).slice(2)) : null) ?? last?.customer_name ?? lastJ?.party_name ?? '';
      const c = card(mv, 1);
      return ok({ key: args.p_key, from, to, name, ...c, rows: this.journalTables ? c.rows.map((r) => ({ ...r, note: r.note ?? '' })) : c.rows });
    }
    const expenses = this.t('expenses');
    const paidOf = (e: Row) => this.t('payments').filter((p) => p.expense_id === e.id && ['expense', 'reversal'].includes(p.source))
      .reduce((a, p) => a + (p.direction === 'out' ? 1 : -1) * Number(p.amount), 0);
    if (fn === 'report_suppliers') {
      const list = expenses.filter((e) => e.status === 'confirmed' && e.doc_date >= from && e.doc_date <= to)
        .sort((a, b) => `${a.doc_date}${a.created_at ?? ''}`.localeCompare(`${b.doc_date}${b.created_at ?? ''}`))
        .map((e) => { const sg = e.supplier_doc_type === 'credit' ? -1 : 1; return { e, k: supplierKey(e), amount: sg * Number(e.total), net: sg * Number(e.amount_before_vat), vat: sg * Number(e.vat_amount), paid: r2(paidOf(e)), manual: 0, at: `${e.doc_date}${e.created_at ?? ''}` }; })
        // 2.96 (5100): a manual expense entry — by its supplier, or on a line of its own ("m:") without one; never paid, never owed
        .concat(entries.filter((j) => j.kind === 'expense').map((j) => {
          const s = j.party_kind === 'supplier', gross = Number(j.amount) + Number(j.vat);
          return { e: { supplier_name: s ? j.party_name : '', supplier_dealer: j.party_dealer ?? '', category: j.category }, k: s ? partyKey({ dealer: j.party_dealer, name: j.party_name }) : MANUAL_KEY,
            amount: gross, net: Number(j.amount), vat: Number(j.vat), paid: 0, manual: gross, at: `${j.entry_date}${j.created_at ?? ''}` };
        }))
        .sort((a, b) => a.at.localeCompare(b.at));
      const group = (f: (x: Row) => string) => {
        const m = new Map<string, Row>();
        for (const x of list) {
          const g = m.get(f(x)) ?? { count: 0, net: 0, vat: 0, total: 0, paid: 0, manual: 0 };
          Object.assign(g, { count: g.count + 1, net: r2(g.net + x.net), vat: r2(g.vat + x.vat), total: r2(g.total + x.amount), paid: r2(g.paid + x.paid), manual: r2(g.manual + x.manual), name: x.e.supplier_name,
            dealer: x.e.supplier_dealer || g.dealer || '', category: x.e.category });
          m.set(f(x), g);
        }
        return m;
      };
      const suppliers = [...group((x) => x.k).entries()].map(([k, g]) => noManual({ key: k, name: g.name, dealer: g.dealer, count: g.count, net: g.net, vat: g.vat, total: g.total, paid: g.paid,
        open: r2(g.total - g.paid - g.manual), manual: g.manual })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
      const categories = [...group((x) => x.e.category).entries()].map(([c, g]) => noManual({ category: c, count: g.count, net: g.net, total: g.total, paid: g.paid,
        open: r2(g.total - g.paid - g.manual), manual: g.manual })).sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
      const sum = (f: (x: Row) => number) => r2(list.reduce((a, x) => a + f(x), 0));
      return ok({ from, to, total: noManual({ net: sum((x) => x.net), vat: sum((x) => x.vat), total: sum((x) => x.amount), paid: sum((x) => x.paid), open: sum((x) => x.amount - x.paid - x.manual),
        count: list.length, manual: sum((x) => x.manual) }), suppliers, categories });
    }
    if (fn === 'report_supplier_ledger') {
      if (!/^(d|n):/.test(String(args.p_key ?? ''))) return { status: 400, body: { code: '22023', message: 'supplier: a key' } };
      const mine = expenses.filter((e) => supplierKey(e) === args.p_key), ids = new Set(mine.map((e) => e.id));
      const mv: Row[] = mine.filter((e) => e.status === 'confirmed').map((e) => ({ day: e.doc_date, at: e.created_at ?? '', kind: e.supplier_doc_type === 'credit' ? 'supplier_credit' : 'invoice',
        number: e.expense_number, ref: e.supplier_doc_number ?? '', debit: e.supplier_doc_type === 'credit' ? Number(e.total) : 0, credit: e.supplier_doc_type === 'credit' ? 0 : Number(e.total), method: '', rid: e.id }));
      for (const p of this.t('payments').filter((x) => x.expense_id && ids.has(x.expense_id) && ['expense', 'reversal'].includes(x.source))) {
        const e = mine.find((x) => x.id === p.expense_id)!;
        mv.push({ day: p.paid_on, at: p.created_at ?? '', kind: `payment_${p.source}`, number: e.expense_number, ref: e.supplier_doc_number ?? '',
          debit: p.direction === 'out' ? Number(p.amount) : 0, credit: p.direction === 'in' ? Number(p.amount) : 0, method: p.method, rid: p.id });
      }
      // 2.96 (5100): a manual entry of this supplier — the business owes more when it is positive, less when it is negative
      const mineJ = journal.filter((j) => j.party_kind === 'supplier' && partyKey({ dealer: j.party_dealer, name: j.party_name }) === args.p_key);
      for (const j of mineJ) {
        const gross = Number(j.amount) + Number(j.vat);
        mv.push({ day: j.entry_date, at: j.created_at ?? '', kind: 'manual', number: j.number, ref: '', debit: Math.max(-gross, 0), credit: Math.max(gross, 0), method: '', rid: j.id, note: j.explanation });
      }
      const last = [...mine].sort((a, b) => `${b.doc_date}${b.created_at ?? ''}`.localeCompare(`${a.doc_date}${a.created_at ?? ''}`))[0];
      const lastJ = [...mineJ].sort((a, b) => `${b.entry_date}${b.created_at ?? ''}`.localeCompare(`${a.entry_date}${a.created_at ?? ''}`))[0];
      const c = card(mv, -1);
      return ok({ key: args.p_key, from, to, name: last?.supplier_name ?? lastJ?.party_name ?? '', ...c, rows: this.journalTables ? c.rows.map((r) => ({ ...r, note: r.note ?? '' })) : c.rows });
    }
    if (fn === 'report_withholding') {
      const w = this.t('payments').filter((p) => p.method === 'withholding' && p.paid_on >= from && p.paid_on <= to)
        .sort((a, b) => `${a.paid_on}${a.created_at ?? ''}`.localeCompare(`${b.paid_on}${b.created_at ?? ''}`))
        .map((p) => {
          const r = all.find((d) => d.id === p.document_id)!, inv = p.applies_to ? all.find((d) => d.id === p.applies_to) : null;
          return { date: p.paid_on, key: key(r), name: r.customer_name ?? '', dealer: r.customer_dealer ?? '', leadId: r.lead_id ?? null, docType: r.doc_type, docNumber: r.doc_number,
            invoice: inv ? `${inv.doc_type}-${inv.doc_number}` : null, amount: (p.direction === 'in' ? 1 : -1) * Number(p.amount), pct: p.reference?.pct ?? null, dir: p.direction };
        });
      const g = new Map<string, Row>();
      for (const x of w) {
        const c = g.get(x.key) ?? { key: x.key, leadId: null, name: '', dealer: '', amount: 0, count: 0 };
        Object.assign(c, { amount: r2(c.amount + x.amount), count: c.count + (x.dir === 'in' ? 1 : -1), leadId: x.leadId ?? c.leadId, dealer: x.dealer || c.dealer, name: x.name });
        g.set(x.key, c);
      }
      const customers = [...g.values()].map((c): Row => ({ ...c, name: leadName(c.leadId) ?? c.name })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
      return ok({ from, to, total: r2(w.reduce((a, x) => a + x.amount, 0)), customers, rows: w.map(({ leadId: _l, dir: _d, ...x }) => x) });
    }
    return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
  }
  // ---- 2.95 (migration 5000): an order, a delivery note and a return note ------------------------------------------------------
  private docCancelled(id: string) { return this.t('document_cancellations').some((c) => c.document_id === id); }
  /** d_documents_goods (and the base rule of documents_validate): an error string refuses the document */
  private goodsCheck(r: Row): string | null {
    const goodsType = [100, 200, 210].includes(r.doc_type);
    if ((goodsType || [100, 200].includes(r.base_doc_type)) && !this.cashTables) return 'new row for relation "documents" violates check constraint "documents_doc_type_check"';
    if (r.base_doc_type != null && r.doc_type !== 330) {
      const ok = (r.doc_type === 200 && r.base_doc_type === 100) || (r.doc_type === 210 && r.base_doc_type === 200) || ([300, 305, 320].includes(r.doc_type) && [100, 200].includes(r.base_doc_type));
      if (!ok || r.base_doc_number == null) return 'only a credit invoice points to a base document (or a document made from an order or a delivery note)';
    }
    if (goodsType) {
      if (!this.t('business_finance_profile')[0]?.sells_products) return 'goods_off: orders, delivery notes and return notes are for a business that sells products (turned on in the settings)';
      if (r.doc_type === 210 && r.base_doc_type !== 200) return 'goods_return_base: a return note is made from a delivery note';
    }
    if ([100, 200].includes(r.base_doc_type)) {
      if (r.paid_document_id) return 'goods_base_receipt: a receipt for an invoice is not made from an order or a delivery note';
      const base = this.t('documents').find((d) => d.doc_type === r.base_doc_type && d.doc_number === r.base_doc_number);
      if (!base) return 'goods_base_missing: the order / delivery note was not found in this business';
      if (this.docCancelled(base.id)) return 'goods_base_cancelled: the order / delivery note was cancelled';
      r.location_id ??= base.location_id ?? null;
      if (r.base_doc_type === 200) {
        const made = this.t('documents').filter((x) => x.base_doc_type === 200 && x.base_doc_number === base.doc_number && !this.docCancelled(x.id));
        if (made.some((x) => [300, 305, 320].includes(x.doc_type))) return 'goods_invoiced: the delivery note was already invoiced';
        const products = new Set(this.t('catalog_items').filter((i) => i.kind === 'product').map((i) => i.id));
        const sum = (ls: { id: string; variant: string | null; qty: number }[], l: { id: string; variant: string | null }) =>
          ls.filter((x) => x.id === l.id && x.variant === l.variant).reduce((a, x) => a + x.qty, 0);
        const out = this.lines(base.lines), back = made.filter((x) => x.doc_type === 210).flatMap((x) => this.lines(x.lines));
        const over = this.lines(r.lines).filter((l) => products.has(l.id) && l.qty > sum(out, l) - sum(back, l));
        if (over.length) return `goods_over_delivery: more than the delivery note left (${over.map((l) => this.t('catalog_items').find((i) => i.id === l.id)?.name ?? l.id).join(', ')})`;
      }
    }
    return null;
  }
  /** document_cancellations_check: an order / a delivery note a document was made from stays; a return note whose note was invoiced too */
  private goodsCancelCheck(id: string): string | null {
    const d = this.t('documents').find((x) => x.id === id);
    if (!d) return null;
    const live = (type: number, n: number) => this.t('documents').filter((x) => x.base_doc_type === type && x.base_doc_number === n && !this.docCancelled(x.id));
    if ((d.doc_type === 100 || d.doc_type === 200) && live(d.doc_type, d.doc_number).length) return 'cancel_has_followers: a document was made from it — cancel that one first';
    if (d.doc_type === 210 && live(200, d.base_doc_number).some((x) => [300, 305, 320].includes(x.doc_type))) return 'cancel_has_followers: its delivery note was invoiced';
    return null;
  }

  // ---- 2.95 (migration 5000): the desks, deposits, cheques and the bank ----------------------------------------------------------
  private chequeInDrawer(p: Row): boolean {
    return p.direction === 'in' && p.method === 'cheque' && p.source === 'document' && !this.docCancelled(p.document_id)
      && !this.t('bank_deposit_cheques').some((x) => x.payment_id === p.id && x.active) && !this.t('bank_matches').some((m) => m.payment_id === p.id && m.active);
  }
  private seenPayments(): Row[] {
    const f = this.locationFilter();
    return this.t('payments').filter((p) => !f || f.includes(this.rowLocation(p)));
  }
  private seenDeposits(): Row[] {
    const f = this.locationFilter();
    return this.t('bank_deposits').filter((d) => !f || f.includes(d.location_id));
  }
  private cashOf(loc: string | null): number {
    const cents = (n: unknown) => Math.round(Number(n) * 100);
    const pays = this.t('payments').filter((p) => p.method === 'cash' && (!loc || this.rowLocation(p) === loc));
    const deps = this.t('bank_deposits').filter((d) => d.status === 'active' && (!loc || d.location_id === loc));
    return (pays.reduce((a, p) => a + (p.direction === 'in' ? 1 : -1) * cents(p.amount), 0) - deps.reduce((a, d) => a + cents(d.cash), 0)) / 100;
  }
  private payCard(p: Row): Row {
    const d = this.t('documents').find((x) => x.id === (p.document_id ?? p.applies_to));
    const e = this.t('expenses').find((x) => x.id === p.expense_id);
    return { id: p.id, direction: p.direction, amount: Number(p.amount), method: p.method, paidOn: p.paid_on, source: p.source, docType: d?.doc_type ?? null,
      docNumber: d?.doc_number ?? null, customer: d?.customer_name ?? '', expenseNumber: e?.expense_number ?? null, supplier: e?.supplier_name ?? '', note: p.note ?? '',
      cheque: p.method === 'cheque' ? String(p.reference?.number ?? '') : null };
  }
  private bankPaymentOk(p: Row): boolean {
    return !['withholding', 'cash'].includes(p.method) && !['cancel', 'reversal'].includes(p.source)
      && !(p.source === 'document' && this.docCancelled(p.document_id))
      && !(p.expense_id && this.t('expenses').some((e) => e.id === p.expense_id && e.status === 'void'))
      && !this.t('bank_deposit_cheques').some((x) => x.payment_id === p.id && x.active);
  }
  private cashRpc(fn: string, args: any): { status: number; body: any } | null {
    const names = ['cash_desks', 'cheque_book', 'deposit_book', 'bank_deposit_create', 'bank_deposit_cancel', 'bank_import', 'bank_book', 'bank_candidates', 'bank_match',
      'bank_unmatch', 'bank_line_handle', 'bank_line_reopen'];
    if (!names.includes(fn)) return null;
    if (!this.cashTables) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
    const ok = (body: any) => ({ status: 200, body });
    const bad = (code: string, message: string) => ({ status: 400, body: { code, message } });
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const today = this.today();
    const from = String(args.p_from ?? ''), to = String(args.p_to ?? '');
    if (['cash_desks', 'cheque_book', 'deposit_book', 'bank_book', 'bank_candidates'].includes(fn) && (!from || !to || from > to)) return bad('22023', 'bad range');
    if (/^bank_(book|candidates|import|match|unmatch|line_)/.test(fn) && this.memberLocations) return bad('42501', "not allowed: the bank is the whole business's");
    const iso = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
    const doc = (id: string) => this.t('documents').find((x) => x.id === id);
    if (fn === 'cash_desks') {
      const pays = this.seenPayments(), deps = this.seenDeposits();
      const days = Number(this.t('business_finance_profile')[0]?.cheque_remind_days ?? 3);
      const until = new Date(`${today}T12:00:00Z`); until.setUTCDate(until.getUTCDate() + days);
      const lim = until.toISOString().slice(0, 10);
      const inP = (p: Row) => p.paid_on >= from && p.paid_on <= to;
      const chq = pays.filter((p) => this.chequeInDrawer(p));
      const due = chq.filter((p) => iso(p.reference?.dueDate) && p.reference.dueDate <= lim);
      const sum = (l: Row[], k = 'amount') => r2(l.reduce((a, x) => a + Number(x[k]), 0));
      return ok({
        methods: ['cash', 'cheque', 'card', 'transfer', 'bit', 'other'].map((m) => {
          const l = pays.filter((p) => p.method === m && inP(p));
          return { method: m, in: sum(l.filter((p) => p.direction === 'in')), out: sum(l.filter((p) => p.direction === 'out')), count: l.length };
        }),
        cash: r2(pays.filter((p) => p.method === 'cash').reduce((a, p) => a + (p.direction === 'in' ? 1 : -1) * Number(p.amount), 0) - sum(deps.filter((d) => d.status === 'active'), 'cash')),
        cheques: { count: chq.length, total: sum(chq), dueCount: due.length, dueTotal: sum(due) },
        deposits: (() => { const l = deps.filter((d) => d.status === 'active' && d.deposited_on >= from && d.deposited_on <= to); return { count: l.length, total: r2(l.reduce((a, d) => a + Number(d.cash) + Number(d.cheques), 0)) }; })(),
        remindDays: days, today,
      });
    }
    if (fn === 'cheque_book') {
      const card = (p: Row) => {
        const d = doc(p.document_id), dc = this.t('bank_deposit_cheques').find((x) => x.payment_id === p.id && x.active), dep = dc ? this.t('bank_deposits').find((x) => x.id === dc.deposit_id) : null;
        return { id: p.id, amount: Number(p.amount), paidOn: p.paid_on, number: String(p.reference?.number ?? ''), bank: String(p.reference?.bank ?? ''), branch: String(p.reference?.branch ?? ''),
          account: String(p.reference?.account ?? ''), dueDate: iso(p.reference?.dueDate), docType: d?.doc_type ?? null, docNumber: d?.doc_number ?? null, customer: d?.customer_name ?? '',
          location: this.rowLocation(p), matched: this.t('bank_matches').some((m) => m.payment_id === p.id && m.active),
          deposit: dep ? { id: dep.id, number: dep.number, date: dep.deposited_on } : null };
      };
      const all = this.seenPayments().filter((p) => p.direction === 'in' && p.method === 'cheque' && p.source === 'document').map(card);
      return ok({
        drawer: all.filter((c) => !this.docCancelled(this.t('payments').find((p) => p.id === c.id)?.document_id) && !c.deposit && !c.matched)
          .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.paidOn.localeCompare(b.paidOn)),
        deposited: all.filter((c) => c.deposit && c.deposit.date >= from && c.deposit.date <= to).sort((a, b) => a.deposit!.date.localeCompare(b.deposit!.date) || a.deposit!.number - b.deposit!.number),
      });
    }
    if (fn === 'deposit_book') {
      return ok(this.seenDeposits().filter((d) => d.deposited_on >= from && d.deposited_on <= to)
        .sort((a, b) => b.deposited_on.localeCompare(a.deposited_on) || b.number - a.number)
        .map((d) => ({ id: d.id, number: d.number, date: d.deposited_on, location: d.location_id, cash: Number(d.cash), cheques: Number(d.cheques), total: r2(Number(d.cash) + Number(d.cheques)),
          note: d.note ?? '', status: d.status, cancelReason: d.cancel_reason ?? '', matched: this.t('bank_matches').some((m) => m.deposit_id === d.id && m.active),
          items: this.t('bank_deposit_cheques').filter((x) => x.deposit_id === d.id && (x.active || d.status === 'cancelled')).map((x) => {
            const p = this.t('payments').find((y) => y.id === x.payment_id)!, dd = doc(p.document_id);
            return { payment: x.payment_id, amount: Number(x.amount), number: String(p.reference?.number ?? ''), bank: String(p.reference?.bank ?? ''), dueDate: iso(p.reference?.dueDate),
              customer: dd?.customer_name ?? '', docType: dd?.doc_type ?? null, docNumber: dd?.doc_number ?? null };
          }) })));
    }
    if (fn === 'bank_deposit_create') {
      const id = String(args.p_id ?? '');
      if (!id) return bad('22023', 'deposit_id: a new deposit has an id');
      const same = this.t('bank_deposits').find((d) => d.id === id);
      if (same) return ok({ id, number: same.number, created: false });
      const date = String(args.p_date ?? '');
      if (!iso(date) || date > today) return bad('22023', 'deposit_date: a deposit is dated today or before');
      if (this.finance.lockedUntil && date <= this.finance.lockedUntil) return bad('23514', `period_locked: the books are closed until ${this.finance.lockedUntil}`);
      const loc = args.p_location ?? this.locationPick() ?? this.opts.businessId;
      if (!this.mayUse(loc)) return bad('42501', 'not allowed: this location is not yours');
      const cash = Number(args.p_cash ?? 0);
      if (!(cash >= 0) || Math.round(cash * 100) !== cash * 100) return bad('22023', 'deposit_cash: an amount of money');
      const ids: string[] = [...new Set<string>((args.p_cheques ?? []).filter(Boolean))];
      if (!cash && !ids.length) return bad('22023', 'deposit_empty: cash or cheques to deposit');
      const chq = ids.map((x) => this.t('payments').find((p) => p.id === x));
      if (chq.some((p) => !p || p.direction !== 'in' || p.method !== 'cheque' || p.source !== 'document')) return bad('22023', 'deposit_cheque: a cheque received on a receipt of the business');
      if (chq.some((p) => this.rowLocation(p!) !== loc)) return bad('22023', "deposit_cheque_location: the cheques of the deposit's location");
      if (chq.some((p) => !this.chequeInDrawer(p!))) return bad('23514', 'deposit_cheque_taken: a cheque is no longer in the drawer (deposited, matched to the bank or its receipt cancelled)');
      if (cash > 0) { const have = this.cashOf(loc); if (Math.round(cash * 100) > Math.round(have * 100)) return bad('23514', `deposit_cash_over: the cash desk holds ${Math.max(have, 0).toFixed(2)}`); }
      const number = Math.max(0, ...this.t('bank_deposits').map((d) => d.number)) + 1;
      const cheques = r2(chq.reduce((a, p) => a + Number(p!.amount), 0));
      this.t('bank_deposits').push({ id, business_id: this.opts.businessId, location_id: loc, number, deposited_on: date, cash, cheques, note: String(args.p_note ?? '').trim().slice(0, 300),
        status: 'active', cancel_reason: '', cancelled_at: null, user_id: this.opts.userId, created_at: now() });
      for (const p of chq) this.t('bank_deposit_cheques').push({ deposit_id: id, business_id: this.opts.businessId, location_id: loc, payment_id: p!.id, amount: Number(p!.amount), active: true });
      this.log('deposit.created', id, { number, date, cash, cheques: chq.length, total: r2(cash + cheques) });
      return ok({ id, number, created: true });
    }
    if (fn === 'bank_deposit_cancel') {
      const d = this.t('bank_deposits').find((x) => x.id === args.p_id);
      if (!d) return bad('42501', 'not allowed');
      if (!this.mayUse(d.location_id)) return bad('42501', 'not allowed: this location is not yours');
      if (d.status === 'cancelled') return ok({ id: d.id, result: 'already' });
      if (String(args.p_reason ?? '').trim().length < 2) return bad('22023', 'reason_required: a reason or a note, two letters at least');
      if (this.t('bank_matches').some((m) => m.deposit_id === d.id && m.active)) return bad('23514', 'deposit_matched: the bank already matched this deposit — undo that match first');
      Object.assign(d, { status: 'cancelled', cancel_reason: String(args.p_reason).trim(), cancelled_at: now() });
      for (const x of this.t('bank_deposit_cheques').filter((y) => y.deposit_id === d.id)) x.active = false;
      this.log('deposit.cancelled', d.id, { number: d.number, reason: d.cancel_reason });
      return ok({ id: d.id, result: 'cancelled' });
    }
    if (fn === 'bank_import') {
      const id = String(args.p_id ?? ''), acc = String(args.p_account ?? '').trim().slice(0, 60);
      const same = this.t('bank_statements').find((s) => s.id === id);
      if (same) return ok({ id, total: same.lines_total, added: same.lines_new, created: false });
      const lines: Row[] = Array.isArray(args.p_lines) ? args.p_lines : [];
      if (!lines.length || lines.length > 5000) return bad('22023', 'bank_lines: 1 to 5,000 lines in a file');
      if (lines.some((l) => !iso(l.date) || typeof l.amount !== 'number' || !l.amount || Math.round(l.amount * 100) !== l.amount * 100)) return bad('22023', 'bank_lines: each line has a date, an amount (not zero) and its text');
      this.t('bank_statements').push({ id, business_id: this.opts.businessId, account: acc, file_name: String(args.p_file ?? '').slice(0, 200), lines_total: lines.length, lines_new: 0,
        date_from: lines.map((l) => l.date).sort()[0], date_to: lines.map((l) => l.date).sort().at(-1), created_at: now() });
      const seen = new Map<string, number>();
      let added = 0;
      for (const l of lines) {
        const descr = String(l.description ?? '').trim().slice(0, 300), ref = String(l.reference ?? '').trim().slice(0, 60);
        const key = [acc, l.date, Number(l.amount).toFixed(2), descr.toLowerCase().replace(/\s+/g, ' '), ref, l.balance == null ? '' : Number(l.balance).toFixed(2)].join('|');
        const k = (seen.get(key) ?? 0) + 1; seen.set(key, k);
        const fp = createHash('md5').update(`${key}#${k}`).digest('hex');
        if (this.t('bank_lines').some((x) => x.fingerprint === fp)) continue;
        this.t('bank_lines').push({ id: randomUUID(), business_id: this.opts.businessId, statement_id: id, account: acc, line_date: l.date, description: descr, reference: ref,
          amount: Number(l.amount), balance: l.balance ?? null, fingerprint: fp, status: 'open', note: '', created_at: now() });
        added++;
      }
      this.t('bank_statements').find((s) => s.id === id)!.lines_new = added;
      this.log('bank.imported', id, { lines: lines.length, added });
      return ok({ id, total: lines.length, added, created: true });
    }
    if (fn === 'bank_book') {
      const lines = this.t('bank_lines').filter((l) => l.line_date >= from && l.line_date <= to).sort((a, b) => a.line_date.localeCompare(b.line_date) || String(a.created_at).localeCompare(String(b.created_at)));
      return ok({
        lines: lines.map((l) => ({ id: l.id, date: l.line_date, description: l.description, reference: l.reference, amount: Number(l.amount), balance: l.balance, status: l.status, note: l.note,
          account: l.account, statement: l.statement_id, matches: this.t('bank_matches').filter((m) => m.bank_line_id === l.id && m.active).map((m) => {
            const p = m.payment_id ? this.t('payments').find((x) => x.id === m.payment_id) : null, d = m.deposit_id ? this.t('bank_deposits').find((x) => x.id === m.deposit_id) : null;
            return { id: m.id, amount: Number(m.amount), payment: p ? this.payCard(p) : null, deposit: d ? { id: d.id, number: d.number, date: d.deposited_on, cash: Number(d.cash), cheques: Number(d.cheques) } : null };
          }) })),
        statements: [...this.t('bank_statements')].reverse().map((s) => ({ id: s.id, account: s.account, file: s.file_name, total: s.lines_total, added: s.lines_new, from: s.date_from, to: s.date_to, at: s.created_at })),
      });
    }
    if (fn === 'bank_candidates') {
      return ok({
        payments: this.t('payments').filter((p) => p.paid_on >= from && p.paid_on <= to && this.bankPaymentOk(p) && !this.t('bank_matches').some((m) => m.payment_id === p.id && m.active))
          .sort((a, b) => a.paid_on.localeCompare(b.paid_on)).map((p) => this.payCard(p)),
        deposits: this.t('bank_deposits').filter((d) => d.status === 'active' && d.deposited_on >= from && d.deposited_on <= to && !this.t('bank_matches').some((m) => m.deposit_id === d.id && m.active))
          .map((d) => ({ id: d.id, number: d.number, date: d.deposited_on, cash: Number(d.cash), cheques: Number(d.cheques), total: r2(Number(d.cash) + Number(d.cheques)),
            count: this.t('bank_deposit_cheques').filter((x) => x.deposit_id === d.id && x.active).length })),
      });
    }
    const line = this.t('bank_lines').find((l) => l.id === args.p_line);
    if (!line) return bad('42501', 'not allowed');
    if (fn === 'bank_match') {
      if (line.status !== 'open') return bad('23514', 'bank_line_closed: the line is already matched or handled');
      const pays: string[] = [...new Set<string>(args.p_payments ?? [])], deps: string[] = [...new Set<string>(args.p_deposits ?? [])];
      if (!pays.length && !deps.length) return bad('22023', 'bank_match_items: one to 50 receipts, payments or deposits');
      const ps = pays.map((x) => this.t('payments').find((p) => p.id === x)), ds = deps.map((x) => this.t('bank_deposits').find((d) => d.id === x));
      if (ps.some((p) => !p) || ds.some((d) => !d)) return bad('42501', 'not allowed');
      if (ps.some((p) => p!.direction !== (line.amount > 0 ? 'in' : 'out')) || (line.amount < 0 && ds.length)) return bad('23514', 'bank_match_sign: money that came in meets a line of money in; money paid, a line of money out');
      if (ps.some((p) => !this.bankPaymentOk(p!))) return bad('23514', 'bank_match_item: only money that went through the bank (cash and deposited cheques meet it in their deposit)');
      if (ds.some((d) => d!.status !== 'active')) return bad('23514', 'bank_match_item: a cancelled deposit');
      const s = r2(ps.reduce((a, p) => a + Number(p!.amount), 0) + ds.reduce((a, d) => a + Number(d!.cash) + Number(d!.cheques), 0));
      if (Math.round(s * 100) !== Math.round(Math.abs(line.amount) * 100)) return bad('23514', `bank_match_sum: the chosen add up to ${s.toFixed(2)} but the line is ${Math.abs(line.amount).toFixed(2)}`);
      if (ps.some((p) => this.t('bank_matches').some((m) => m.payment_id === p!.id && m.active)) || ds.some((d) => this.t('bank_matches').some((m) => m.deposit_id === d!.id && m.active))) {
        return { status: 409, body: { code: '23505', message: 'bank_match_taken: one of them is already matched to another line' } };
      }
      for (const p of ps) this.t('bank_matches').push({ id: randomUUID(), business_id: this.opts.businessId, bank_line_id: line.id, payment_id: p!.id, deposit_id: null, amount: Number(p!.amount), active: true, approved_at: now() });
      for (const d of ds) this.t('bank_matches').push({ id: randomUUID(), business_id: this.opts.businessId, bank_line_id: line.id, payment_id: null, deposit_id: d!.id, amount: r2(Number(d!.cash) + Number(d!.cheques)), active: true, approved_at: now() });
      line.status = 'matched';
      this.log('bank.matched', line.id, { amount: line.amount, payments: ps.length, deposits: ds.length });
      return ok({ line: line.id, items: ps.length + ds.length });
    }
    if (fn === 'bank_unmatch') {
      if (line.status !== 'matched') return bad('23514', 'bank_line_not_matched: the line is not matched');
      if (String(args.p_reason ?? '').trim().length < 2) return bad('22023', 'reason_required: a reason or a note, two letters at least');
      const hit = this.t('bank_matches').filter((m) => m.bank_line_id === line.id && m.active);
      for (const m of hit) Object.assign(m, { active: false, undone_at: now(), undo_reason: String(args.p_reason).trim() });
      line.status = 'open';
      this.log('bank.unmatched', line.id, { items: hit.length });
      return ok({ line: line.id, undone: hit.length });
    }
    if (fn === 'bank_line_handle') {
      if (line.status !== 'open') return bad('23514', 'bank_line_closed: the line is already matched or handled');
      if (String(args.p_note ?? '').trim().length < 2) return bad('22023', 'reason_required: a reason or a note, two letters at least');
      Object.assign(line, { status: 'handled', note: String(args.p_note).trim().slice(0, 300), handled_at: now() });
      this.log('bank.handled', line.id, { note: line.note });
      return ok({ line: line.id, status: 'handled' });
    }
    if (fn === 'bank_line_reopen') {
      if (line.status !== 'handled') return bad('23514', 'bank_line_not_handled: the line is not marked handled');
      Object.assign(line, { status: 'open', note: '', handled_at: null });
      this.log('bank.reopened', line.id, {});
      return ok({ line: line.id, status: 'open' });
    }
    return null;
  }

  // ---- 2.96 (migration 5100): manual journal entries -------------------------------------------------------------------------
  /** the entries the signed-in user sees (journal_entries_location_gate: the location picked, or the member's own) */
  private journalSeen(): Row[] {
    const seen = this.locationFilter();
    return this.t('journal_entries').filter((j) => j.business_id === this.opts.businessId && (!seen || seen.includes(j.location_id)));
  }
  /** journal_writer(): the business's owners — role owner, full access, every location */
  private journalWriter() {
    const m = this.t('business_members').find((x) => x.user_id === this.opts.userId && (x.business_id ?? this.opts.businessId) === this.opts.businessId);
    return this.owner && !this.memberLocations && this.finance.member && (m?.role ?? 'owner') === 'owner' && (m?.access ?? 'full') === 'full';
  }
  /** journal_writer / journal_entry_create / journal_entry_reverse — their checks (tests/sql/journal.check.sql proves the real ones) */
  private journalRpc(fn: string, args: any): { status: number; body: any } | null {
    if (!['journal_writer', 'journal_entry_create', 'journal_entry_reverse'].includes(fn)) return null;
    if (!this.journalTables) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
    const ok = (body: any) => ({ status: 200, body });
    const refuse = (message: string, code = '22023') => ({ status: 400, body: { code, message, details: null, hint: null } });
    if (fn === 'journal_writer') return ok(this.journalWriter());
    if (!this.journalWriter()) return refuse("journal_not_allowed: only the business's owners record a manual entry", '42501');
    const b = this.opts.businessId, T = this.t('journal_entries'), today = this.today(), lock = this.finance.lockedUntil;
    const id = String(args.p_id ?? '');
    if (!id) return refuse('journal_id: a new entry has an id');
    const same = T.find((j) => j.id === id);
    const nextNumber = () => T.filter((j) => j.business_id === b).reduce((a, j) => Math.max(a, j.number), 0) + 1;
    const explanation = String(args.p_explanation ?? '').trim();
    if (fn === 'journal_entry_reverse') {
      if (same) return same.business_id !== b || same.reverses !== (args.p_entry ?? null) ? refuse('not allowed', '42501') : ok({ id, number: same.number, created: false });
      const o = T.find((j) => j.id === args.p_entry && j.business_id === b);
      if (!o) return refuse('journal_entry: the entry was not found in this business');
      if (o.reverses) return refuse('journal_reverse: a reversing entry is not reversed — record a new entry instead', '23514');
      if (T.some((x) => x.reverses === o.id)) return refuse('journal_reversed: the entry was already reversed', '23514');
      const d = String(args.p_date ?? today);
      if (d > today || d < o.entry_date) return refuse('journal_date: a reversal is dated on or after its entry, today or before');
      if (lock && d <= lock) return refuse(`period_locked: the books are closed until ${lock}`, '23514');
      if (explanation.length < 2 || explanation.length > 500) return refuse('journal_explanation: an explanation, 2 to 500 letters');
      const number = nextNumber();
      T.push({ ...o, id, number, entry_date: d, amount: -Number(o.amount), vat: -Number(o.vat), explanation, reverses: o.id, user_id: this.opts.userId, created_at: now() });
      this.log('journal.reversed', id, { number, reverses: o.number, date: d, kind: o.kind, amount: -Number(o.amount), vat: -Number(o.vat), explanation });
      return ok({ id, number, created: true, reverses: o.number });
    }
    if (same) return same.business_id !== b ? refuse('not allowed', '42501') : ok({ id, number: same.number, created: false });
    const d = String(args.p_date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today || d < '2000-01-01') return refuse('journal_date: an entry is dated today or before');
    if (lock && d <= lock) return refuse(`period_locked: the books are closed until ${lock}`, '23514');
    const kind = String(args.p_kind ?? '');
    if (!['income', 'expense', 'vat', 'other'].includes(kind)) return refuse('journal_kind: income, expense, VAT or other');
    const amt = Number(args.p_amount ?? 0), v = Number(args.p_vat ?? 0);
    const agorot = (x: number) => Number.isFinite(x) && Math.abs(x * 100 - Math.round(x * 100)) < 1e-6 && Math.abs(x) <= 1e8;
    if (!agorot(amt) || !agorot(v)) return refuse('journal_amount: an amount of money (agorot)');
    if (amt === 0 && v === 0) return refuse('journal_amount: an amount or VAT');
    if (v !== 0 && !this.vatBusiness()) return refuse('journal_vat: an exempt dealer records no VAT');
    const side = kind === 'income' ? 'output' : kind === 'expense' ? 'input' : kind === 'vat' ? args.p_vat_side ?? null : null;
    if (kind === 'vat' && !['output', 'input'].includes(side)) return refuse('journal_vat_side: VAT on sales or on inputs');
    if (kind === 'vat' && (amt !== 0 || v === 0)) return refuse('journal_vat: a VAT entry is VAT only');
    if (kind === 'other' && v !== 0) return refuse('journal_vat: an "other" entry carries no VAT');
    const category = kind === 'expense' ? String(args.p_category ?? '').trim() || 'other' : null;
    if (category && !/^[a-z_]{2,30}$/.test(category)) return refuse('journal_category: a kind of expense');
    if (explanation.length < 2 || explanation.length > 500) return refuse('journal_explanation: an explanation, 2 to 500 letters');
    let pk: string | null = null, lead: string | null = null, pname = '', pdealer = '';
    const p = args.p_party;
    if (p && typeof p === 'object' && Object.keys(p).length) {
      pk = String(p.kind ?? '');
      if (kind === 'vat' || !['customer', 'supplier'].includes(pk) || (pk === 'customer' && kind === 'expense') || (pk === 'supplier' && kind === 'income')) {
        return refuse('journal_party: a customer on income, a supplier on an expense, either on "other" — none on VAT');
      }
      if (pk === 'customer' && p.leadId) {
        const l = this.t('leads').find((x) => x.id === p.leadId && (x.business_id ?? b) === b);
        if (!l) return refuse('journal_party: a customer card of the business');
        lead = l.id; pname = String(l.name ?? '').slice(0, 120);
      } else pname = String(p.name ?? '').trim().slice(0, 120);
      pdealer = String(p.dealer ?? '').trim();
      if (pdealer && !/^\d{9}$/.test(pdealer)) return refuse('journal_party: a dealer number is 9 digits');
      if (!lead && pname.length < 2 && !pdealer) return refuse('journal_party: a name or a dealer number');
    }
    const loc = args.p_location ?? this.locationPick();
    if (!loc || !this.places().locations.some((l) => l.id === loc && l.active)) return refuse('journal_location: an active location of the business');
    const number = nextNumber();
    T.push({ id, business_id: b, location_id: loc, number, entry_date: d, kind, amount: amt, vat: v, vat_side: side, category, explanation,
      party_kind: pk, lead_id: lead, party_name: pname, party_dealer: pdealer, reverses: null, user_id: this.opts.userId, created_at: now() });
    this.log('journal.created', id, { number, date: d, kind, amount: amt, vat: v, vatSide: side, category, location: loc,
      party: pk ? { kind: pk, leadId: lead, name: pname, dealer: pdealer } : null, explanation });
    return ok({ id, number, created: true });
  }

  rpc(fn: string, args: any): { status: number; body: any } {
    const journaled = this.journalRpc(fn, args);
    if (journaled) return journaled;
    const placed = this.locationRpc(fn, args);
    if (placed) return placed;
    const stocked = this.stockRpc(fn, args);
    if (stocked) return stocked;
    const itemed = this.itemsRpc(fn, args);
    if (itemed) return itemed;
    const reported = this.reportsRpc(fn, args);
    if (reported) return reported;
    const cashed = this.cashRpc(fn, args);
    if (cashed) return cashed;
    if (fn === 'pos_employees') return { status: 200, body: this.t('employees').filter((e) => e.active !== false).map((e) => ({ id: e.id, name: e.name })) };
    if (fn === 'business_for_user') return { status: 200, body: this.opts.businessId };
    // 2.105 (migration 5700): the team for the calendar — names, colours, who is a practitioner; never a number
    if (fn === 'appointment_staff') {
      if (!this.calendarTables) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} without parameters in the schema cache` } };
      const rows = this.t('lead_staff').filter((s) => s.business_id === this.opts.businessId)
        .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)) || String(x.id).localeCompare(String(y.id)));
      return { status: 200, body: rows.map((s) => ({ id: s.id, name: s.name, color: s.color ?? '', practitioner: Boolean(s.practitioner), member_user_id: s.member_user_id ?? null, active: s.active !== false })) };
    }
    // 2.88 (migration 4300): what was really paid as a deposit for these appointments — never a test link
    if (fn === 'appointment_deposits') {
      const ids: string[] = args.p_ids ?? [];
      const m = new Map<string, number>();
      for (const r of this.t('payment_requests')) {
        if (r.kind === 'deposit' && r.status === 'paid' && !r.is_test && ids.includes(r.appointment_id) && r.business_id === this.opts.businessId) {
          m.set(r.appointment_id, (m.get(r.appointment_id) ?? 0) + Number(r.paid_amount));
        }
      }
      return { status: 200, body: [...m].map(([appointment_id, amount]) => ({ appointment_id, amount })) };
    }
    // 2.97 (migration 5200): the same amounts — and the documents issued for them (not cancelled), for the register's line
    if (fn === 'appointment_deposit_receipts') {
      if (!this.depositDocsFn) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
      const ids: string[] = args.p_ids ?? [];
      const canc = new Set(this.t('document_cancellations').map((c) => c.document_id));
      const m = new Map<string, { amount: number; receipts: { type: number; number: number }[] }>();
      for (const r of this.t('payment_requests')) {
        if (!(r.kind === 'deposit' && r.status === 'paid' && !r.is_test && ids.includes(r.appointment_id) && r.business_id === this.opts.businessId)) continue;
        const e = m.get(r.appointment_id) ?? { amount: 0, receipts: [] };
        e.amount += Number(r.paid_amount);
        const d = r.receipt_status === 'issued' && r.receipt_document_id ? this.t('documents').find((x) => x.id === r.receipt_document_id && x.business_id === r.business_id) : null;
        if (d && !canc.has(d.id)) e.receipts.push({ type: Number(d.doc_type), number: Number(d.doc_number) });
        m.set(r.appointment_id, e);
      }
      return { status: 200, body: [...m].map(([appointment_id, e]) => ({ appointment_id, amount: e.amount, receipts: e.receipts.sort((a, b) => a.number - b.number) })) };
    }
    if (fn === 'reserved_stock') {
      const m = new Map<string, { item_id: string; variant_id: string | null; qty: number }>();
      for (const r of this.t('stock_reservations').filter((x) => x.business_id === this.opts.businessId)) {
        if (!(r.status === 'paid' || (r.status === 'held' && new Date(r.expires_at).getTime() > Date.now()))) continue;
        const k = `${r.item_id}|${r.variant_id ?? ''}`;
        const e = m.get(k) ?? { item_id: r.item_id, variant_id: r.variant_id ?? null, qty: 0 };
        e.qty += Number(r.qty); m.set(k, e);
      }
      return { status: 200, body: [...m.values()].map((x) => (this.stockTables ? { ...x, location: this.shipLocation() } : x)) };
    }
    // the store (3400): the checklist, and "פרסום" of a theme version (the published one is archived)
    if (fn === 'store_checklist') {
      const st = this.t('stores').find((x) => x.id === args.p_store && x.business_id === this.opts.businessId);
      if (!st) return { status: 400, body: { code: '42501', message: 'not allowed' } };
      const missing = this.storeMissing(st);
      return { status: 200, body: { ready: missing.length === 0, missing } };
    }
    // 2.73 (migration 3900): a kit's writes in one call — all of them or none (the tables come back as they were)
    if (fn === 'store_apply_kit') {
      if (!this.applyKitRpc) return { status: 404, body: { code: 'PGRST202', message: 'Could not find the function public.store_apply_kit(p_plan, p_store) in the schema cache' } };
      const before = structuredClone(this.tables);
      const plan = args.p_plan ?? {};
      let step = 'החנות';
      const n = { collections: 0, pages: 0, replacedPages: 0, menus: 0, version: 0, published: false };
      const failWith = (msg: string, code = '23514') => { this.tables = before; return { status: 400, body: { code, message: `${step} — ${msg}` } }; };
      if (!this.t('stores').some((x) => x.id === args.p_store)) return failWith('store not found', '42501');
      for (const c of plan.collections ?? []) {
        step = `הקולקציה "${c.title}"`;
        const r: Row = { ...c, position: Math.max(-1, ...this.t('catalog_collections').map((x) => Number(x.position ?? 0))) + 1 };
        const e = this.beforeInsert('catalog_collections', r); if (e) return failWith(e);
        this.t('catalog_collections').push(r); this.afterInsert('catalog_collections', r); n.collections++;
      }
      for (const pg of plan.pages ?? []) {
        step = `העמוד "${pg.title}"`;
        const r: Row = { ...pg, store_id: args.p_store };
        const e = this.beforeInsert('store_pages', r); if (e) return failWith(e);
        this.t('store_pages').push(r); this.afterInsert('store_pages', r); n.pages++;
      }
      for (const x of plan.replace ?? []) {
        step = `העמוד "${x.row.title}"`;
        const r = this.t('store_pages').find((g) => g.id === x.id && g.store_id === args.p_store);
        if (!r) return failWith('page not found', '42501');
        const e = this.beforeUpdate('store_pages', r, x.row); if (e) return failWith(e);
        const old = { ...r }; Object.assign(r, x.row); this.afterUpdate('store_pages', old, r); n.replacedPages++;
      }
      for (const m of plan.menus ?? []) {
        step = 'התפריט';
        const r = this.t('store_menus').find((x) => x.store_id === args.p_store && x.kind === m.kind);
        if (r) r.items = m.items; else { const row: Row = { store_id: args.p_store, kind: m.kind, items: m.items }; const e = this.beforeInsert('store_menus', row); if (e) return failWith(e); this.t('store_menus').push(row); }
        n.menus++;
      }
      step = 'העיצוב';
      const d = plan.draft ?? {};
      let v: Row | undefined;
      if (d.id) {
        v = this.t('store_theme_versions').find((x) => x.id === d.id && x.store_id === args.p_store && x.status === 'draft');
        if (!v) return failWith('draft not found', '42501');
        Object.assign(v, { settings: d.settings, template: d.template, note: d.note ?? v.note });
      } else {
        v = { store_id: args.p_store, template: d.template, settings: d.settings, note: d.note ?? '' };
        const e = this.beforeInsert('store_theme_versions', v); if (e) return failWith(e);
        this.t('store_theme_versions').push(v); this.afterInsert('store_theme_versions', v);
      }
      n.version = Number(v.version);
      if (plan.publish) { const r = this.rpc('store_publish_theme', { p_version: v.id }); if (r.status !== 200) return failWith(r.body.message); n.published = true; }
      this.applyKitCalls++;
      return { status: 200, body: n };
    }
    if (fn === 'store_publish_theme') {
      const v = this.t('store_theme_versions').find((x) => x.id === args.p_version);
      if (!v) return { status: 400, body: { code: '42501', message: 'version not found' } };
      if (v.status !== 'published') {
        for (const x of this.t('store_theme_versions')) if (x.store_id === v.store_id && x.status === 'published') x.status = 'archived';
        Object.assign(v, { status: 'published', published_at: now() });
      }
      return { status: 200, body: null };
    }
    if (fn === 'adjust_stock') {
      const it = this.t('catalog_items').find((i) => i.id === args.p_item);
      if (!it) return { status: 400, body: { code: '42501', message: 'not allowed' } };
      if (it.has_variants) return { status: 400, body: { code: '22023', message: 'variant_required: an item with variants is counted per variant' } };
      // 4700: a count on the spot is the owner's
      if (this.stockTables && args.p_mode === 'set' && !this.locationOwner()) return { status: 400, body: { code: '42501', message: 'not allowed: the owner counts on the spot (others count in a stock count the owner approves)' } };
      if (!it.track_stock) { it.track_stock = true; it.stock_qty = 0; }
      // 4700: where the user works (the location picked, their only one, else the main one) — with one location, the total
      const at = this.stockTables ? this.locationPick() ?? this.opts.businessId : null;
      const d = args.p_mode === 'add' ? Number(args.p_qty) : Number(args.p_qty) - (at ? this.stockAt(at, it.id, null) : Number(it.stock_qty));
      this.stock(it.id, d, args.p_mode === 'add' ? 'receive' : 'count', { note: args.p_note ?? '', location: at });
      return { status: 200, body: at ? this.stockAt(at, it.id, null) : it.stock_qty };
    }
    // the one catalog (3300): a variant's delivery / count moves the variant and the item's sum; the reconcile drops what no variant holds
    if (fn === 'adjust_variant_stock') {
      const v = this.t('catalog_variants').find((x) => x.id === args.p_variant);
      const it = v && this.t('catalog_items').find((i) => i.id === v.item_id);
      if (!v || !it) return { status: 400, body: { code: '42501', message: 'not allowed' } };
      const qty = Number(args.p_qty);
      if (args.p_mode === 'add' ? !(qty > 0) : !(qty >= 0)) return { status: 400, body: { code: '22023', message: 'a count is zero or more' } };
      if (this.stockTables && args.p_mode === 'set' && !this.locationOwner()) return { status: 400, body: { code: '42501', message: 'not allowed: the owner counts on the spot (others count in a stock count the owner approves)' } };
      it.track_stock = true;
      const at = this.stockTables ? this.locationPick() ?? this.opts.businessId : null;
      const d = args.p_mode === 'add' ? qty : qty - (at ? this.stockAt(at, it.id, v.id) : Number(v.stock_qty ?? 0));
      this.stock(it.id, d, args.p_mode === 'add' ? 'receive' : 'count', { variant: v.id, note: args.p_note ?? '', location: at });
      return { status: 200, body: at ? this.stockAt(at, it.id, v.id) : v.stock_qty };
    }
    if (fn === 'reconcile_variant_stock') {
      const it = this.t('catalog_items').find((i) => i.id === args.p_item);
      if (!it || !it.has_variants) return { status: 400, body: { code: '22023', message: 'the item has no variants' } };
      if (this.stockTables && !this.locationOwner()) return { status: 400, body: { code: '42501', message: 'not allowed: the owner counts on the spot (others count in a stock count the owner approves)' } };
      const total = this.t('catalog_variants').filter((v) => v.item_id === it.id).reduce((a, v) => a + Number(v.stock_qty ?? 0), 0);
      this.stock(it.id, total - Number(it.stock_qty ?? 0), 'count', { note: 'התאמה לסכום הווריאנטים' });
      return { status: 200, body: it.stock_qty };
    }
    // 2.87: the client file's people (the owner here), and a session + its deduction in one step (all or nothing)
    if (fn === 'client_files_allowed') return { status: 200, body: this.clientFiles };
    if (fn === 'client_session_add') {
      if (!this.clientFiles) return { status: 400, body: { code: '42501', message: 'not allowed' } };
      // the id fixed on the device: a retry of the same call is the same session
      if (args.p_id && this.t('client_sessions').some((x) => x.id === args.p_id && x.lead_id === args.p_lead)) return { status: 200, body: args.p_id };
      const t = this.t('client_treatments').find((x) => x.id === args.p_treatment && x.lead_id === args.p_lead);
      if (!t) return { status: 400, body: { code: '23503', message: 'insert or update on table "client_sessions" violates foreign key constraint "client_sessions_treatment_id_business_id_lead_id_fkey"' } };
      if (args.p_at && Date.parse(args.p_at) > Date.now() + 864e5) return { status: 400, body: { code: '22023', message: 'session_time: a session that took place (not in the future)' } };
      const s: Row = { id: args.p_id ?? randomUUID(), business_id: this.opts.businessId, treatment_id: t.id, lead_id: args.p_lead, at: args.p_at ?? now(), notes: args.p_notes ?? '' };
      this.beforeInsert('client_sessions', s);
      this.t('client_sessions').push(s);
      if (args.p_package) {
        const u: Row = { id: randomUUID(), business_id: this.opts.businessId, package_id: args.p_package, lead_id: args.p_lead, session_id: s.id };
        const e = this.useCheck(u);
        if (e) { this.tables.client_sessions = this.t('client_sessions').filter((x) => x !== s); return { status: 400, body: { code: '23514', message: e } }; }
        this.t('client_package_uses').push(u);
      }
      return { status: 200, body: s.id };
    }
    if (fn === 'finance_access_state') {
      const f = this.finance;
      return { status: 200, body: { business: this.opts.businessId, superAdmin: f.superAdmin, access: 'full', member: f.member, open: f.member || Boolean(f.grantUntil), grantUntil: f.grantUntil, lockedUntil: f.lockedUntil } };
    }
    if (fn === 'open_finance_access') {
      if (!this.finance.superAdmin) return { status: 400, body: { code: '42501', message: 'not allowed' } };
      if (String(args.p_reason ?? '').trim().length < 5) return { status: 400, body: { code: '22023', message: 'a reason is required (5 characters or more)' } };
      this.finance.grantUntil = new Date(Date.now() + Number(args.p_minutes ?? 60) * 60_000).toISOString();
      this.t('finance_access_grants').push({ id: randomUUID(), business_id: this.opts.businessId, user_id: this.opts.userId, reason: args.p_reason, granted_at: now(), expires_at: this.finance.grantUntil, revoked_at: null });
      this.log('support.access_opened', this.opts.userId, { reason: args.p_reason, until: this.finance.grantUntil });
      return { status: 200, body: this.finance.grantUntil };
    }
    if (fn === 'close_finance_access') { this.finance.grantUntil = null; return { status: 200, body: 1 }; }
    if (fn === 'finance_summary') return { status: 200, body: this.summary(args.p_from, args.p_to) };
    if (fn === 'finance_audit_verify') return { status: 200, body: { ok: true, rows: this.t('finance_audit_log').length } };
    if (fn === 'log_finance_event') { this.log(args.p_action, args.p_entity_id ?? '', args.p_details ?? {}); return { status: 200, body: null }; }
    if (fn === 'lock_finance_period') { this.finance.lockedUntil = args.p_end; return { status: 200, body: args.p_end }; }
    if (fn === 'record_credit_refund') {
      const d = this.t('documents').find((x) => x.id === args.p_document);
      if (!d || d.doc_type !== 330) return { status: 400, body: { code: '23514', message: 'a refund is recorded on a credit invoice of this business' } };
      const base = this.t('documents').find((x) => x.doc_type === d.base_doc_type && x.doc_number === d.base_doc_number);
      const id = randomUUID();
      this.t('payments').push({ id, business_id: d.business_id, direction: 'out', amount: Number(args.p_amount), method: args.p_method, paid_on: args.p_paid_on ?? this.today(), source: 'credit', document_id: d.id, applies_to: base?.id ?? null, note: args.p_note ?? '', created_at: now() });
      return { status: 200, body: id };
    }
    if (fn === 'record_manual_allocation') {
      if (!/^\d{6,20}$/.test(String(args.p_number ?? ''))) return { status: 400, body: { code: '22023', message: 'an allocation number is digits only' } };
      this.t('tax_allocations').push({ id: randomUUID(), business_id: this.opts.businessId, document_id: args.p_document, status: 'manual', is_test: false, allocation_number: args.p_number, gateway: 'manual', created_at: now() });
      return { status: 200, body: 'ok' };
    }
    if (fn === 'receive_expense_stock') {
      const e = this.t('expenses').find((x) => x.id === args.p_expense);
      let n = 0;
      for (const l of this.lines(e?.stock_lines)) { this.stock(l.id, l.qty, 'receive', { note: `הוצאה ${e!.expense_number}`, variant: l.variant }); n++; }
      return { status: 200, body: n };
    }
    // stage 4 (3600): where the goods stand (an email to the customer on "ready" / "shipped"), the owner saw the alerts
    if (fn === 'order_set_fulfillment') {
      const o = this.t('orders').find((x) => x.id === args.p_order && x.business_id === this.opts.businessId);
      if (!o) return { status: 400, body: { code: '42501', message: 'not allowed' } };
      if (args.p_url && !/^https:\/\//.test(args.p_url)) return { status: 200, body: { ok: false, error: 'url' } };
      const from = o.fulfillment_status;
      Object.assign(o, { fulfillment_status: args.p_status, ...(args.p_status === 'shipped' ? { tracking_number: args.p_tracking ?? '', tracking_url: args.p_url ?? '', shipped_at: now() } : {}) });
      this.t('order_events').push({ id: this.t('order_events').length + 100, order_id: o.id, business_id: o.business_id, kind: 'fulfillment', data: { from, to: args.p_status, tracking: args.p_tracking ?? '' }, at: now() });
      if (args.p_status === 'shipped' && o.delivery_method === 'delivery' && !this.t('email_outbox').some((e) => e.order_id === o.id && e.kind === 'order_shipped')) {
        this.t('email_outbox').push({ id: randomUUID(), business_id: o.business_id, order_id: o.id, kind: 'order_shipped', ref: '', status: 'queued', last_error: '', sent_at: null, created_at: now() });
      }
      return { status: 200, body: { ok: true } };
    }
    if (fn === 'store_alerts_seen') return { status: 200, body: null };
    // 2.89 (4400): a payment plan — the sum is the balance to the agora, one plan in force (a new one only when replacing)
    if (fn === 'payment_plan_create') {
      const bad = (m: string, code = '23514') => ({ status: 400, body: { code, message: m } });
      const r = this.receivables().find((x) => x.id === args.p_document);
      if (!r) return bad('plan_not_found', '42501');
      if (this.t('payment_plans').some((p) => p.id === args.p_id)) return { status: 200, body: { result: 'already', plan: args.p_id } };
      if (r.cancelled) return bad('plan_not_invoice: the invoice was cancelled');
      if (!(r.balance > 0)) return bad('plan_paid: nothing is owed on this invoice');
      const items: Row[] = args.p_items ?? [];
      if (items.length < 2 || items.length > 36) return bad('plan_count: 2 to 36 payments', '22023');
      if (Math.round(items.reduce((a, i) => a + Number(i.amount) * 100, 0)) !== Math.round(r.balance * 100)) return bad(`plan_sum: the payments add up to x, the balance is ${r.balance}`);
      if (items.some((i, k) => i.due < this.today() || (k > 0 && i.due <= items[k - 1].due))) return bad('plan_date: a payment', '22023');
      const old = this.t('payment_plans').find((p) => p.document_id === r.id && p.status === 'active');
      if (old && !args.p_replace) return bad('plan_exists: the invoice already has a plan', '23505');
      if (old) Object.assign(old, { status: 'cancelled', cancelled_at: now(), cancelled_by: this.opts.userId, cancel_reason: 'הוחלפה בפריסה חדשה' });
      this.t('payment_plans').push({ id: args.p_id, business_id: this.opts.businessId, user_id: this.opts.userId, document_id: r.id, lead_id: r.lead_id, total: r.balance,
        payments: items.length, status: 'active', note: args.p_note ?? '', created_at: now(), cancelled_at: null, cancelled_by: null, cancel_reason: '' });
      items.forEach((i, k) => this.t('payment_plan_items').push({ id: randomUUID(), plan_id: args.p_id, business_id: this.opts.businessId, n: k + 1, due_date: i.due, amount: Number(i.amount) }));
      this.log('plan.created', r.id, { plan: args.p_id, total: r.balance, payments: items.length });
      return { status: 200, body: { result: 'ok', plan: args.p_id } };
    }
    if (fn === 'payment_plan_cancel') {
      const p = this.t('payment_plans').find((x) => x.id === args.p_plan);
      if (!p) return { status: 400, body: { code: '42501', message: 'plan_not_found' } };
      if (p.status === 'cancelled') return { status: 200, body: { result: 'already' } };
      Object.assign(p, { status: 'cancelled', cancelled_at: now(), cancelled_by: this.opts.userId, cancel_reason: args.p_reason ?? '' });
      this.log('plan.cancelled', p.document_id, { plan: p.id });
      return { status: 200, body: { result: 'ok' } };
    }
    // 2.89: the reminders — on only by the owner (kept: who and when); off by anyone who may write, and what waits is cancelled
    if (fn === 'debt_reminders_configure') {
      const days = [...new Set((args.p_days ?? []).map(Number))].sort((a: any, b: any) => a - b) as number[];
      if (!days.length || days.length > 5 || days[0] < 1 || days[days.length - 1] > 120) return { status: 400, body: { code: '22023', message: 'reminders_days: 1 to 5 days, each 1 to 120' } };
      const rows = this.t('debt_reminder_settings');
      let s = rows.find((x) => x.business_id === this.opts.businessId);
      if (!s) { s = { business_id: this.opts.businessId, enabled: false, days, channel: 'whatsapp', approved_by: null, approved_at: null }; rows.push(s); }
      if (args.p_enabled) {
        if (!this.owner) return { status: 400, body: { code: '42501', message: 'reminders_owner: only the business owner turns reminders on' } };
        Object.assign(s, { enabled: true, days, channel: args.p_channel, approved_by: this.opts.userId, approved_at: now(), updated_at: now() });
        this.log('reminders.enabled', this.opts.businessId, { days, channel: args.p_channel });
      } else {
        Object.assign(s, { enabled: false, days, channel: args.p_channel, updated_at: now() });
        for (const q of this.t('debt_reminders').filter((x) => x.status === 'queued')) Object.assign(q, { status: 'cancelled', cancelled_at: now(), cancel_reason: 'off' });
        this.log('reminders.disabled', this.opts.businessId, { days });
      }
      return { status: 200, body: s };
    }
    if (fn === 'debt_reminders_preview') {
      const due = this.dueReminders([...new Set((args.p_days ?? []).map(Number))].sort((a: any, b: any) => a - b) as number[], args.p_channel, this.today());
      return { status: 200, body: { email: due.filter((d) => d.channel === 'email').length, whatsapp: due.filter((d) => d.channel === 'whatsapp').length } };
    }
    if (fn === 'debt_reminders_stop') {
      const stops = this.t('debt_reminder_stops');
      if (args.p_stop) {
        if (!stops.some((x) => x.lead_id === args.p_lead && !x.lifted_at)) stops.push({ id: randomUUID(), business_id: this.opts.businessId, lead_id: args.p_lead, created_by: this.opts.userId, created_at: now(), lifted_at: null });
        for (const q of this.t('debt_reminders').filter((x) => x.lead_id === args.p_lead && x.status === 'queued')) Object.assign(q, { status: 'cancelled', cancelled_at: now(), cancel_reason: 'stopped' });
        this.log('reminders.stopped', args.p_lead, {});
        return { status: 200, body: true };
      }
      for (const x of stops.filter((y) => y.lead_id === args.p_lead && !y.lifted_at)) Object.assign(x, { lifted_at: now(), lifted_by: this.opts.userId });
      return { status: 200, body: false };
    }
    if (fn === 'debt_reminder_whatsapp') {
      const q = this.t('debt_reminders').find((x) => x.id === args.p_id);
      if (!q) return { status: 400, body: { code: '42501', message: 'reminder_not_found' } };
      if (q.status !== 'queued') return { status: 200, body: { result: q.status } };
      const l = this.receivableLines().find((x) => x.document_id === q.document_id && (q.item_id ? x.item_id === q.item_id : !x.item_id && !x.plan_id));
      const state = !l ? 'changed' : !(l.open_amount > 0) ? 'paid' : this.t('debt_reminder_stops').some((x) => x.lead_id === q.lead_id && !x.lifted_at) ? 'stopped' : 'ok';
      if (state !== 'ok') { Object.assign(q, { status: 'cancelled', cancelled_at: now(), cancel_reason: state }); return { status: 200, body: { result: state } }; }
      Object.assign(q, { status: 'sent', sent_at: now(), sent_by: this.opts.userId, amount: l!.open_amount });
      this.t('lead_activities').push({ id: randomUUID(), business_id: this.opts.businessId, user_id: this.opts.userId, lead_id: q.lead_id, kind: 'whatsapp', body: `תזכורת תשלום בוואטסאפ: ₪${l!.open_amount}`, created_at: now() });
      this.log('reminder.sent', q.document_id, { reminder: q.id, step: q.step, channel: 'whatsapp' });
      return { status: 200, body: { result: 'ok', state: 'ok', open: l!.open_amount, due: l!.due_date, n: l!.n, of: l!.of_n, docType: l!.doc_type, docNumber: l!.doc_number,
        customer: l!.customer_name, shareToken: l!.share_token, lead: q.lead_id, step: q.step, tone: q.tone } };
    }
    if (fn === 'debt_reminder_skip') {
      const q = this.t('debt_reminders').find((x) => x.id === args.p_id && x.status === 'queued');
      if (!q) return { status: 200, body: false };
      Object.assign(q, { status: 'cancelled', cancelled_at: now(), cancel_reason: 'skipped' });
      return { status: 200, body: true };
    }
    // 2.89: what this expense may repeat (expense_duplicates' rule; a void one never counts)
    if (fn === 'expense_duplicates') {
      const q = { sha: args.p_sha ?? null, dealer: args.p_dealer ?? '', supplier: args.p_supplier ?? '', docNumber: args.p_doc_number ?? '', total: args.p_total == null ? null : Number(args.p_total), docDate: args.p_doc_date ?? null };
      const out = this.t('expenses').filter((e) => e.id !== args.p_exclude).map((e) => ({ e, reasons: duplicateReasons(q, { fileSha256: e.file_sha256 ?? null, supplierDealer: e.supplier_dealer ?? '',
        supplierName: e.supplier_name ?? '', supplierDocNumber: e.supplier_doc_number ?? '', total: Number(e.total), docDate: e.doc_date, status: e.status }) }))
        .filter((x) => x.reasons.length).slice(0, 5)
        .map(({ e, reasons }) => ({ id: e.id, expense_number: e.expense_number, doc_date: e.doc_date, created_at: e.created_at, supplier_name: e.supplier_name, supplier_doc_number: e.supplier_doc_number ?? '', total: e.total, status: e.status, reasons }));
      return { status: 200, body: out };
    }
    // 2.90 (4500): recurring charges — a plan (its id from the editor; the schedule only before its first charge), pause / resume /
    // end (a charge that waited is held), "נסו שוב". The timer is the server's (tests/recurring.test.ts, recurring.check.sql)
    if (/^recurring_/.test(fn) && !this.recurringTables) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
    if (fn === 'recurring_plan_save') {
      const bad = (m: string, code = '22023') => ({ status: 400, body: { code, message: m } });
      const today = this.today();
      if (!this.t('leads').some((l) => l.id === args.p_lead)) return bad('recurring_customer: a customer of this business');
      const lines: Row[] = Array.isArray(args.p_lines) ? args.p_lines : [];
      if (!lines.length || lines.length > 30) return bad('recurring_lines: 1 to 30 lines');
      if (lines.some((l) => !String(l.name ?? '').trim() || !(Number(l.qty) > 0) || !(Number(l.unitPrice) >= 0))) return bad('recurring_lines: line 1');
      if (!(Number(args.p_amount) > 0)) return bad('recurring_amount');
      if (![1, 2, 3, 6, 12].includes(Number(args.p_every))) return bad('recurring_every: 1, 2, 3, 6 or 12 months');
      if (!(Number(args.p_day) >= 1 && Number(args.p_day) <= 28)) return bad('recurring_day: 1 to 28');
      if (args.p_end && args.p_end < args.p_start) return bad('recurring_end: after the start');
      const rows = this.t('recurring_plans');
      const pl = rows.find((p) => p.id === args.p_id);
      const terms = { name: String(args.p_name).trim(), lines, prices_include_vat: args.p_prices_include_vat !== false, amount: Number(args.p_amount), every_months: Number(args.p_every),
        day_of_month: Number(args.p_day), start_date: args.p_start, end_date: args.p_end ?? null, mode: args.p_mode, send_link: args.p_send_link !== false, note: args.p_note ?? '' };
      if (!pl) {
        const next = firstCharge(args.p_start, Number(args.p_every), Number(args.p_day), today)!;
        if (args.p_end && next > args.p_end) return bad('recurring_end: no charge before the end date');
        rows.push({ id: args.p_id, business_id: this.opts.businessId, user_id: this.opts.userId, lead_id: args.p_lead, ...terms, next_date: next, status: 'active',
          paused_at: null, ended_at: null, end_reason: '', created_at: now(), updated_at: now() });
        const every = ({ 1: 'כל חודש', 2: 'כל חודשיים', 3: 'כל 3 חודשים', 6: 'כל חצי שנה', 12: 'כל שנה' } as Record<number, string>)[terms.every_months];
        this.t('lead_activities').push({ id: randomUUID(), business_id: this.opts.businessId, user_id: this.opts.userId, lead_id: args.p_lead, kind: 'note',
          body: `חיוב חוזר: ${terms.name} · ₪${terms.amount} ${every} · ראשון ב-${next.split('-').reverse().join('/')}`, created_at: now() });
        this.log('recurring.created', args.p_id, { lead: args.p_lead, amount: terms.amount, first: next });
        return { status: 200, body: { result: 'created', plan: args.p_id, next, status: 'active' } };
      }
      if (pl.status === 'ended') return bad('recurring_ended: an ended plan does not change', '23514');
      if (pl.lead_id !== args.p_lead) return bad('recurring_customer: a plan keeps its customer (a new plan for another)', '23514');
      const charged = this.t('recurring_charges').some((c) => c.plan_id === pl.id);
      if (charged && (terms.every_months !== pl.every_months || terms.day_of_month !== pl.day_of_month || terms.start_date !== pl.start_date)) {
        return bad('recurring_schedule: a plan that charged keeps its schedule — end it and make a new one', '23514');
      }
      const next = charged ? pl.next_date : firstCharge(terms.start_date, terms.every_months, terms.day_of_month, today)!;
      if (!charged && terms.end_date && next > terms.end_date) return bad('recurring_end: no charge before the end date');
      Object.assign(pl, terms, { next_date: next, updated_at: now() });
      if (pl.end_date && pl.next_date > pl.end_date) Object.assign(pl, { status: 'ended', ended_at: now(), paused_at: null, end_reason: 'הגיע תאריך הסיום' });
      this.log('recurring.changed', pl.id, { amount: pl.amount, next: pl.next_date, status: pl.status });
      return { status: 200, body: { result: 'changed', plan: pl.id, next: pl.next_date, status: pl.status } };
    }
    if (fn === 'recurring_plan_set') {
      const pl = this.t('recurring_plans').find((p) => p.id === args.p_plan);
      if (!pl) return { status: 400, body: { code: '42501', message: 'recurring_not_found' } };
      if (!['pause', 'resume', 'end'].includes(args.p_action)) return { status: 400, body: { code: '22023', message: 'recurring_request: pause, resume or end' } };
      const already = { status: 200, body: { result: 'already', status: pl.status, next: pl.next_date } };
      if (pl.status === 'ended') return already;
      if (args.p_action === 'pause') {
        if (pl.status === 'paused') return already;
        Object.assign(pl, { status: 'paused', paused_at: now() });
      } else if (args.p_action === 'resume') {
        if (pl.status === 'active') return already;
        const today = this.today();
        const next = onOrAfter(pl.start_date, pl.every_months, pl.day_of_month, today > pl.next_date ? today : pl.next_date)!;
        if (pl.end_date && next > pl.end_date) Object.assign(pl, { status: 'ended', ended_at: now(), paused_at: null, next_date: next, end_reason: 'הגיע תאריך הסיום' });
        else Object.assign(pl, { status: 'active', paused_at: null, next_date: next });
      } else Object.assign(pl, { status: 'ended', ended_at: now(), paused_at: null, end_reason: String(args.p_reason ?? '').trim() || 'הסתיים' });
      let held = 0;
      if (pl.status !== 'active') {
        for (const c of this.t('recurring_charges').filter((x) => x.plan_id === pl.id && x.status === 'pending')) {
          Object.assign(c, { status: 'blocked', claimed_at: null, error: pl.status === 'paused' ? 'התוכנית הושהתה לפני שהחיוב הופק' : 'התוכנית הסתיימה לפני שהחיוב הופק' });
          held++;
        }
      }
      const said = pl.status === 'paused' ? 'הושהה' : pl.status === 'active' ? `חזר לפעול — החיוב הבא ב-${String(pl.next_date).split('-').reverse().join('/')}` : 'הסתיים';
      this.t('lead_activities').push({ id: randomUUID(), business_id: this.opts.businessId, user_id: this.opts.userId, lead_id: pl.lead_id, kind: 'note', body: `חיוב חוזר "${pl.name}": ${said}`, created_at: now() });
      this.log(`recurring.${args.p_action}`, pl.id, { status: pl.status, next: pl.next_date, held });
      return { status: 200, body: { result: 'ok', status: pl.status, next: pl.next_date, held } };
    }
    if (fn === 'recurring_charge_retry') {
      const c = this.t('recurring_charges').find((x) => x.id === args.p_charge && x.status === 'blocked');
      if (!c) return { status: 200, body: false };
      Object.assign(c, { status: 'pending', attempts: 0, claimed_at: null, error: '' });
      this.log('recurring.retry', c.id, { plan: c.plan_id, period: c.period_date });
      return { status: 200, body: true };
    }
    if (fn === 'store_slug_available') {
      const c = String(args.p_slug ?? '').trim().toLowerCase();
      if (c === 'taken-one') return { status: 200, body: { ok: false, error: 'taken', suggestion: 'taken-one-2' } };
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { code: 'PGRST202', message: `function ${fn} not found` } };
  }

  /** one HTTP request → { status, body, headers } */
  handle(method: string, href: string, headers: Record<string, string>, bodyText: string | null): { status: number; body?: string; headers?: Record<string, string> } {
    const url = new URL(href);
    const json = (status: number, body: any, extra: Record<string, string> = {}) => ({ status, body: body === undefined ? '' : JSON.stringify(body), headers: { 'content-type': 'application/json', ...extra } });
    // ---- storage: an upload with a signed link (the store's pictures, 2.54) — a binary body, before any JSON ----
    // 2.89: a file uploaded straight to a private bucket (an expense's file, finance-files): kept by path
    const direct = url.pathname.match(/^\/storage\/v1\/object\/(?!upload\/|sign\/|public\/)([^/]+)\/(.+)$/);
    if (direct && method === 'POST') {
      const key = `${direct[1]}/${decodeURIComponent(direct[2])}`;
      if (this.files.has(key)) return json(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      this.files.set(key, { size: (bodyText ?? '').length, type: headers['content-type'] ?? '' });
      return json(200, { Key: key, Id: randomUUID() });
    }
    const signed = url.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/);
    if (signed && (method === 'PUT' || method === 'POST')) {
      if (!url.searchParams.get('token')) return json(400, { message: 'no token' });
      this.files.set(`${signed[1]}/${decodeURIComponent(signed[2])}`, { size: (bodyText ?? '').length, type: headers['content-type'] ?? '' });
      return json(200, { Key: `${signed[1]}/${decodeURIComponent(signed[2])}` });
    }
    const body = bodyText ? JSON.parse(bodyText) : null;
    this.calls.push({ method, path: url.pathname + url.search, body });

    // ---- auth ----
    if (url.pathname.startsWith('/auth/v1/')) {
      // 2.96: the person's own data — updateUser({ data }) merges into it (the favorites of the menu), getUser() reads it back
      if (url.pathname === '/auth/v1/user' && method === 'PUT' && body?.data && typeof body.data === 'object') this.userMeta = { ...this.userMeta, ...body.data };
      const user = { id: this.opts.userId, aud: 'authenticated', role: 'authenticated', email: this.opts.email, app_metadata: {}, user_metadata: { ...this.userMeta }, created_at: now() };
      if (url.pathname === '/auth/v1/user') return json(200, user);
      if (url.pathname === '/auth/v1/token') return json(200, session(this.opts.userId, this.opts.email));
      if (url.pathname === '/auth/v1/logout') return { status: 204 };
      return json(200, {});
    }
    // ---- rpc ----
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rpc) { const r = this.rpc(rpc[1], body ?? {}); return json(r.status, r.body); }

    const m = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
    if (!m) return json(404, { message: 'not found' });
    const table = m[1];
    if (/^recurring_/.test(table) && !this.recurringTables) return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
    if (table === 'receivables') this.tables.receivables = this.receivables();
    if (table === 'receivable_lines') this.tables.receivable_lines = this.receivableLines();
    if (table === 'client_package_status') this.tables.client_package_status = this.packageStatus();
    // 2.92 (4700): before the migration there are no such tables; the view is computed now
    if (['stock_levels', 'stock_transfers', 'stock_counts', 'stock_by_location'].includes(table) && !this.stockTables) {
      return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
    }
    if (table === 'stock_by_location') this.tables.stock_by_location = this.stockByLocation();
    // 2.93 (4800): before the migration there are no such tables; after it they are written only by its functions
    if (FakeSupabase.ITEMS.includes(table)) {
      if (!this.itemsTables) return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
      if (method !== 'GET' && method !== 'HEAD') return json(403, { code: '42501', message: `permission denied for table ${table}` });
    }
    // 2.94 (4900): before the migration its columns are missing — asked for, or written
    if (!this.reportsTables) {
      const cols4900: Record<string, string> = { catalog_items: 'treatment_type_id', business_finance_profile: 'advance_pct' };
      const col = cols4900[table];
      if (col && (url.searchParams.get('select') ?? '').split(',').includes(col)) return json(400, { code: '42703', message: `column ${table}.${col} does not exist` });
      if (col && body && (Array.isArray(body) ? body : [body]).some((b: Row) => b && col in b)) {
        return json(400, { code: 'PGRST204', message: `Could not find the '${col}' column of '${table}' in the schema cache` });
      }
    }
    // 2.95 (5000): before the migration there are no such tables (and no such columns); after it they are written by its functions only
    if (FakeSupabase.CASH.includes(table)) {
      if (!this.cashTables) return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
      if (method !== 'GET' && method !== 'HEAD') return json(403, { code: '42501', message: `permission denied for table ${table}` });
      if (table === 'cheque_reminders') return json(403, { code: '42501', message: 'permission denied for table cheque_reminders' });
    }
    if (!this.cashTables && table === 'business_finance_profile') {
      const cols = ['cash_drawers', 'sells_products', 'cheque_remind_days'];
      const asked = (url.searchParams.get('select') ?? '').split(',').find((c) => cols.includes(c));
      if (asked) return json(400, { code: '42703', message: `column business_finance_profile.${asked} does not exist` });
      const written = body && (Array.isArray(body) ? body : [body]).flatMap((b: Row) => (b ? Object.keys(b) : [])).find((c) => cols.includes(c));
      if (written) return json(400, { code: 'PGRST204', message: `Could not find the '${written}' column of 'business_finance_profile' in the schema cache` });
    }
    // 2.96 (5100): before the migration there is no such table; after it, read through its policies and written by its functions only
    if (table === 'journal_entries') {
      if (!this.journalTables) return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
      if (method !== 'GET' && method !== 'HEAD') return json(403, { code: '42501', message: `permission denied for table ${table}` });
    }
    // 2.105 (5700): before the migration there is no such table, and no staff_id — asked for, or written; after it the history
    // is read through the appointment, and written by the database only
    if (table === 'appointment_events') {
      if (!this.calendarTables) return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
      if (method !== 'GET' && method !== 'HEAD') return json(403, { code: '42501', message: `permission denied for table ${table}` });
    }
    if (table === 'appointments' && !this.calendarTables) {
      if ((url.searchParams.get('select') ?? '').split(',').map((c) => c.trim()).includes('staff_id')) return json(400, { code: '42703', message: 'column appointments.staff_id does not exist' });
      if (body && (Array.isArray(body) ? body : [body]).some((b: Row) => b && 'staff_id' in b)) {
        return json(400, { code: 'PGRST204', message: "Could not find the 'staff_id' column of 'appointments' in the schema cache" });
      }
    }
    // 2.91: the *_location_gate policies — a signed-in user reads and changes only the rows of the locations they see now
    const seen = FakeSupabase.LOCATED.includes(table) || table === 'journal_entries' ? this.locationFilter() : null;
    const all = this.t(table);
    const gate = this.stockGate(table);
    let rows = seen ? all.filter((r) => seen.includes(this.rowLocation(r))) : gate ? all.filter(gate) : all;
    if (table === 'appointment_events') {
      const where = this.locationFilter();
      const mine = new Set(this.t('appointments').filter((a) => !where || where.includes(this.rowLocation(a))).map((a) => a.id));
      rows = rows.filter((e) => mine.has(e.appointment_id));
    }
    const wantsObject = (headers.accept ?? '').includes('vnd.pgrst.object');
    const prefer = headers.prefer ?? '';
    const ret = (list: Row[], status = 200, extra: Record<string, string> = {}) => {
      if (wantsObject) return list.length === 1 ? json(status, list[0], extra) : json(406, { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned (${list.length})` });
      return json(status, list, extra);
    };
    const err = (message: string) => json(400, { code: message.includes('duplicate key') ? '23505' : message.includes('exclusion constraint') ? '23P01'
      : message.startsWith('appointment_staff:') ? '23514' : 'P0001', message, details: null, hint: null });

    if (method === 'GET' || method === 'HEAD') {
      let list = rows.filter((r) => filtersOf(url).every((f) => f(r)));
      const order = url.searchParams.get('order');
      if (order) {
        const keys = order.split(',').map((o) => { const [c, dir] = o.split('.'); return { c, desc: dir === 'desc' }; });
        list = [...list].sort((a, b) => { for (const k of keys) { const x = a[k.c] ?? '', y = b[k.c] ?? ''; if (x < y) return k.desc ? 1 : -1; if (x > y) return k.desc ? -1 : 1; } return 0; });
      }
      const limit = Number(url.searchParams.get('limit') ?? Infinity);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const page = list.slice(offset, offset + limit);
      // { count: 'exact' } (a receipt's / credit's "next" key counts what exists): PostgREST answers in Content-Range
      const range: Record<string, string> = prefer.includes('count=exact') ? { 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/${list.length}` } : {};
      return ret(page, 200, range);
    }
    if (method === 'POST') {
      const list: Row[] = Array.isArray(body) ? body : [body];
      const out: Row[] = [];
      const conflict = url.searchParams.get('on_conflict')?.split(',');
      for (const raw of list) {
        const r = { ...raw };
        const keys = conflict ?? (prefer.includes('merge-duplicates') ? ['id'] : null);
        const same = keys && rows.find((x) => keys.every((k) => x[k] !== undefined && x[k] === (r[k] ?? (k === 'business_id' ? this.opts.businessId : undefined))));
        if (same) { Object.assign(same, r); out.push(same); continue; }
        const e = this.beforeInsert(table, r);
        if (e) return err(e);
        all.push(r); this.afterInsert(table, r); out.push(r);
      }
      if (!prefer.includes('return=representation')) return { status: 201 };
      return ret(out, 201);
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => filtersOf(url).every((f) => f(r)));
      for (const r of hit) {
        const e = this.beforeUpdate(table, r, body ?? {});
        if (e) return err(e);
        const old = { ...r }; Object.assign(r, body); this.afterUpdate(table, old, r);
      }
      if (!prefer.includes('return=representation')) return { status: 204 };
      return ret(hit);
    }
    if (method === 'DELETE') {
      const hit = rows.filter((r) => filtersOf(url).every((f) => f(r)));
      this.tables[table] = all.filter((r) => !hit.includes(r));
      if (table === 'catalog_variants') for (const id of new Set(hit.map((r) => r.item_id))) this.hasVariants(id);
      return prefer.includes('return=representation') ? ret(hit) : { status: 204 };
    }
    return json(405, { message: 'method' });
  }
}

/** a session as supabase-js keeps it in localStorage (the token is never checked by the fake) */
export function session(userId: string, email: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600 * 12;
  const access_token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userId, email, role: 'authenticated', aud: 'authenticated', exp })}.sig`;
  return { access_token, refresh_token: 'refresh', token_type: 'bearer', expires_in: 3600 * 12, expires_at: exp,
    user: { id: userId, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: now() } };
}
