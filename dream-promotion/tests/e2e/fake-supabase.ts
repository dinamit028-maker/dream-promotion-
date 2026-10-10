/**
 * An in-memory stand-in for Supabase (PostgREST + auth) for browser tests: Playwright routes every request
 * to http://sb.test here. It answers the queries the register makes and mirrors the database rules that the
 * screens rely on (document numbering, stock moving with sales / refunds / cancels, refunds never beyond what
 * was paid; 2.54: stock per variant, an item's sum of its variants, a signed upload to storage; 2.55: the store — one per
 * business, its checklist before it goes on the air, theme versions, unique addresses of pages and collections).
 * 2.89 (4400): payment plans and the view receivable_lines (planLines — the view's arithmetic), the reminders' functions, a
 * duplicate expense (duplicateReasons — expense_duplicates' rule).
 * The real rules are tested on Postgres in tests/sql — this only lets the real UI run end to end.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { planLines } from '../../src/features/finance/plans';
import { duplicateReasons } from '../../src/features/finance/expenses';
import { firstCharge, onOrAfter } from '../../src/features/finance/recurring';

type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;

const now = () => new Date().toISOString();
const unq = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

function cond(col: string, op: string, raw: string): (r: Row) => boolean {
  const v = decodeURIComponent(raw);
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
  constructor(public tables: Tables, public opts: { businessId: string; userId: string; email: string }) {}
  private today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()); }
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
    const pays = this.t('payments').filter((p) => p.paid_on >= from && p.paid_on <= to);
    const cin = pays.filter((p) => p.direction === 'in').reduce((a, p) => a + Number(p.amount), 0), cout = pays.filter((p) => p.direction === 'out').reduce((a, p) => a + Number(p.amount), 0);
    const methods = [...new Set(pays.map((p) => p.method))].map((m) => ({ method: m, in: pays.filter((p) => p.method === m && p.direction === 'in').reduce((a, p) => a + Number(p.amount), 0),
      out: pays.filter((p) => p.method === m && p.direction === 'out').reduce((a, p) => a + Number(p.amount), 0) }));
    const recv = this.receivables().filter((x) => !x.cancelled && x.balance > 0), today = this.today();
    const types: Row = {};
    for (const d of docs) { const k = String(d.doc_type); types[k] ??= { count: 0, total: 0, cancelled: 0 }; types[k].count++; types[k].total = r2(types[k].total + Number(d.total)); if (canc.has(d.id)) types[k].cancelled++; }
    const cats = [...new Set(exp.map((e) => e.category))].map((c) => { const l = exp.filter((e) => e.category === c); return { category: c, net: r2(l.reduce((a, e) => a + Number(e.amount_before_vat), 0)), vat: r2(l.reduce((a, e) => a + Number(e.vat_amount), 0)), total: r2(l.reduce((a, e) => a + Number(e.total), 0)), count: l.length }; });
    const month = to.slice(0, 7);
    return {
      from, to, entity: vat ? 'licensed_dealer' : 'exempt_dealer', vat,
      revenue: { net: r2(rev(docs)), vat: r2(outVat), gross: r2(rev(docs) + outVat) }, documents: types,
      expenses: { net: r2(eNet), vat: r2(eVat), vatDeductible: r2(eDed), total: r2(eNet + eVat), count: exp.length, byCategory: cats },
      vatPayable: vat ? r2(outVat - eDed) : 0, profit: r2(rev(docs) - (eNet + eVat - eDed)),
      cash: { in: r2(cin), out: r2(cout), net: r2(cin - cout), byMethod: methods },
      // 2.89: "overdue" by the lines (a plan's payments by their own dates)
      receivables: { open: r2(recv.reduce((a, x) => a + x.balance, 0)), count: recv.length,
        overdue: r2(this.receivableLines().filter((l) => l.open_amount > 0 && l.due_date && l.due_date < today).reduce((a, l) => a + l.open_amount, 0)),
        overdueCount: new Set(this.receivableLines().filter((l) => l.open_amount > 0 && l.due_date && l.due_date < today).map((l) => l.document_id)).size },
      pending: { count: this.t('sales').filter((x) => x.status === 'pending').length, total: 0 }, posWithoutDocument: { count: 0, total: 0 }, allocationMissing: 0,
      months: [{ month, revenue: r2(rev(docs)), expenses: r2(eNet + eVat - eDed) }], lockedUntil: this.finance.lockedUntil,
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
  /** as stock_move_v (3300): the item's sum moves, and the variant named by the line when it is one of this item's */
  private stock(itemId: string, delta: number, reason: string, ref: { sale?: string; refund?: string; note?: string; variant?: string | null } = {}) {
    const it = this.t('catalog_items').find((i) => i.id === itemId && i.track_stock);
    if (!it || !delta) return;
    it.stock_qty = Number(it.stock_qty ?? 0) + delta;
    const v = ref.variant ? this.t('catalog_variants').find((x) => x.id === ref.variant && x.item_id === itemId) : null;
    if (v) v.stock_qty = Number(v.stock_qty ?? 0) + delta;
    const note = !v && it.has_variants ? ['לא משויך לווריאנט', ref.note].filter(Boolean).join(' · ') : ref.note ?? '';
    this.t('stock_movements').push({ id: randomUUID(), business_id: this.opts.businessId, item_id: itemId, variant_id: v?.id ?? null, delta,
      qty_after: v ? v.stock_qty : it.stock_qty, reason, sale_id: ref.sale ?? null, refund_id: ref.refund ?? null, note, created_at: now() });
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
    if (table === 'documents') {
      if (r.idempotency_key && this.t('documents').some((d) => d.idempotency_key === r.idempotency_key)) return 'duplicate key value violates unique constraint "documents_idempotency_uq"';
      if (r.doc_type === 330) {
        const base = this.t('documents').find((d) => d.doc_type === r.base_doc_type && d.doc_number === r.base_doc_number);
        if (!base) return 'the credited invoice was not found in this business';
        const done = this.t('documents').filter((d) => d.doc_type === 330 && d.base_doc_type === r.base_doc_type && d.base_doc_number === r.base_doc_number).reduce((a, d) => a + Number(d.total), 0);
        if (Math.round((done + Number(r.total)) * 100) > Math.round(Number(base.total) * 100)) return `credit_exceeds_original: ${Number(base.total) - done} left`;
      }
      const st = this.t('register_settings')[0] ?? {};
      const n = (this.counters.get(r.doc_type) ?? 0) + 1; this.counters.set(r.doc_type, n);
      Object.assign(r, { doc_number: n, issued_at: now(), print_count: 0, link_no: ++this.linkNo, share_token: randomBytes(32).toString('hex'),
        issuer: { name: st.legal_name ?? '', dealerNumber: st.dealer_number ?? '', entityType: st.entity_type ?? (st.business_type === 'exempt' ? 'exempt_dealer' : 'licensed_dealer'), vatRate: st.vat_rate },
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
    if (table === 'sales') { r.status ??= 'paid'; r.payments ??= []; r.discount ??= 0; r.note ??= ''; }
    if (table === 'store_coupons') { r.code = String(r.code ?? '').toUpperCase(); r.active ??= true; r.used_count = 0; r.min_subtotal ??= 0; }
    // 3500: a sale of the register does not take units held for an order on the site (c_sales_reserved)
    if (table === 'sales' && ['paid', 'pending'].includes(r.status)) {
      for (const l of this.lines(r.items)) {
        const it = this.t('catalog_items').find((i) => i.id === l.id);
        if (!it?.track_stock) continue;
        const v = l.variant ? this.t('catalog_variants').find((x) => x.id === l.variant && x.item_id === it.id) : null;
        const held = this.heldQty(it.id, v?.id ?? null);
        if (held && l.qty > Number(v ? v.stock_qty : it.stock_qty) - held) return `שמור להזמנה באתר: ${it.name}`;
      }
    }
    // the one catalog (3300): the database's defaults and checks the screens rely on
    if (table === 'catalog_items') {
      Object.assign(r, { active: r.active ?? true, favorite: r.favorite ?? false, fav_order: r.fav_order ?? 0, sort: r.sort ?? 0, image_url: r.image_url ?? '',
        track_stock: r.track_stock ?? false, stock_qty: r.stock_qty ?? 0, low_stock: r.low_stock ?? 2, kind: r.kind ?? 'service',
        slug: r.slug ?? null, description: r.description ?? '', seo_title: r.seo_title ?? '', seo_description: r.seo_description ?? '', publish_online: r.publish_online ?? false,
        online_price: r.online_price ?? null, compare_at_price: r.compare_at_price ?? null, sku: r.sku ?? '', barcode: r.barcode ?? '', has_variants: false,
        tags: r.tags ?? [], custom_fields: r.custom_fields ?? {}, manufacturer: r.manufacturer ?? '', country_of_origin: r.country_of_origin ?? '', updated_at: now() });
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
      r.created_at = now();
    }
    if (table === 'register_shifts') { r.opened_at ??= now(); if (this.t('register_shifts').some((x) => !x.closed_at)) return 'duplicate key value violates unique constraint "register_shifts_one_open_idx"'; }
    // the store (3400): its defaults and the unique rules the screens rely on
    const fill = (d: Row) => { for (const [k, v] of Object.entries(d)) if (r[k] === undefined) r[k] = v; };
    if (table === 'stores') {
      if (this.t('stores').some((x) => x.business_id === r.business_id)) return 'duplicate key value violates unique constraint "stores_business_uq"';
      fill({ status: 'draft', template: 'bags', lang: 'he', logo_url: '', description: '', phone: '', whatsapp: '', email: '', address: '', ga4_id: '', gsc_code: '',
        show_stock_count: false, published_at: null, updated_at: now(),
        // 3700: an address from the business's name, and a password (the database makes them; here, fixed)
        slug: 'sagabot', storefront_password: 'e2epass123', password_lock: false, subdomain_seen_at: null });
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
    if (table === 'documents') {
      if (r.doc_type === 320 || r.doc_type === 400) for (const p of r.payments ?? []) {
        this.t('payments').push({ id: randomUUID(), business_id: r.business_id, user_id: r.user_id, direction: 'in', amount: Number(p.amount), method: p.m ?? ({ 1: 'cash', 2: 'cheque', 3: 'card', 4: 'transfer' } as Row)[p.method] ?? 'other',
          paid_on: p.date ?? r.doc_date, source: 'document', document_id: r.id, applies_to: r.paid_document_id ?? null, sale_id: r.sale_id ?? null, lead_id: r.lead_id ?? null, reference: p.cheque ?? {}, note: '', created_at: now() });
      }
      if (r.draft_id) { const d = this.t('document_drafts').find((x) => x.id === r.draft_id); if (d) Object.assign(d, { status: 'finalized', document_id: r.id }); }
      if (r.quote_id) { const q = this.t('quotes').find((x) => x.id === r.quote_id); if (q) Object.assign(q, { status: 'converted', converted_document_id: r.id }); }
      // 2.87: a package's document is linked to it (z_documents_package_link)
      const pk = /^package:([0-9a-f-]{36})$/.exec(r.idempotency_key ?? '');
      if (pk) { const p = this.t('client_packages').find((x) => x.id === pk[1] && !x.document_id); if (p) p.document_id = r.id; }
      this.log('document.issued', r.id, { type: r.doc_type, number: r.doc_number, total: r.total });
    }
    if (table === 'document_cancellations') {
      for (const p of this.t('payments').filter((x) => x.document_id === r.document_id && x.direction === 'in')) this.t('payments').push({ ...p, id: randomUUID(), direction: 'out', source: 'cancel', paid_on: this.today() });
      this.log('document.cancelled', r.document_id, { reason: r.reason });
    }
    if (table === 'expenses' && r.status === 'confirmed' && r.paid_on) {
      this.t('payments').push({ id: randomUUID(), business_id: r.business_id, user_id: r.user_id, direction: 'out', amount: Number(r.total), method: r.payment_method, paid_on: r.paid_on, source: 'expense', expense_id: r.id, note: r.supplier_name, created_at: now() });
    }
    if (table === 'expenses') this.log('expense.created', r.id, { number: r.expense_number, total: r.total });
    if (table === 'quotes') this.log('quote.created', r.id, { number: r.quote_number, total: r.total });
    if (table === 'sales' && ['paid', 'pending'].includes(r.status)) for (const l of this.lines(r.items)) this.stock(l.id, -l.qty, 'sale', { sale: r.id, variant: l.variant });
    if (table === 'sale_refunds' && r.restock) for (const l of this.lines(r.items)) this.stock(l.id, l.qty, 'refund', { sale: r.sale_id, refund: r.id, variant: l.variant });
    if (table === 'catalog_variants') this.hasVariants(r.item_id);
  }
  private beforeUpdate(table: string, old: Row, patch: Row): string | null {
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
    if (table === 'client_sessions' && r.cancelled_at && !old.cancelled_at) {
      for (const u of this.t('client_package_uses').filter((x) => x.session_id === r.id && !x.returned_at)) {
        Object.assign(u, { returned_at: now(), returned_by: this.opts.userId, return_reason: `הטיפול בוטל${r.cancel_reason ? `: ${r.cancel_reason}` : ''}` });
      }
    }
    if (table === 'sales' && r.status === 'cancelled' && ['paid', 'pending'].includes(old.status)) for (const l of this.lines(r.items)) this.stock(l.id, l.qty, 'cancel', { sale: r.id, variant: l.variant });
  }

  rpc(fn: string, args: any): { status: number; body: any } {
    if (fn === 'pos_employees') return { status: 200, body: this.t('employees').filter((e) => e.active !== false).map((e) => ({ id: e.id, name: e.name })) };
    if (fn === 'business_for_user') return { status: 200, body: this.opts.businessId };
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
    if (fn === 'reserved_stock') {
      const m = new Map<string, { item_id: string; variant_id: string | null; qty: number }>();
      for (const r of this.t('stock_reservations').filter((x) => x.business_id === this.opts.businessId)) {
        if (!(r.status === 'paid' || (r.status === 'held' && new Date(r.expires_at).getTime() > Date.now()))) continue;
        const k = `${r.item_id}|${r.variant_id ?? ''}`;
        const e = m.get(k) ?? { item_id: r.item_id, variant_id: r.variant_id ?? null, qty: 0 };
        e.qty += Number(r.qty); m.set(k, e);
      }
      return { status: 200, body: [...m.values()] };
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
      if (!it.track_stock) { it.track_stock = true; it.stock_qty = 0; }
      const d = args.p_mode === 'add' ? Number(args.p_qty) : Number(args.p_qty) - Number(it.stock_qty);
      this.stock(it.id, d, args.p_mode === 'add' ? 'receive' : 'count', { note: args.p_note ?? '' });
      return { status: 200, body: it.stock_qty };
    }
    // the one catalog (3300): a variant's delivery / count moves the variant and the item's sum; the reconcile drops what no variant holds
    if (fn === 'adjust_variant_stock') {
      const v = this.t('catalog_variants').find((x) => x.id === args.p_variant);
      const it = v && this.t('catalog_items').find((i) => i.id === v.item_id);
      if (!v || !it) return { status: 400, body: { code: '42501', message: 'not allowed' } };
      const qty = Number(args.p_qty);
      if (args.p_mode === 'add' ? !(qty > 0) : !(qty >= 0)) return { status: 400, body: { code: '22023', message: 'a count is zero or more' } };
      it.track_stock = true;
      const d = args.p_mode === 'add' ? qty : qty - Number(v.stock_qty ?? 0);
      this.stock(it.id, d, args.p_mode === 'add' ? 'receive' : 'count', { variant: v.id, note: args.p_note ?? '' });
      return { status: 200, body: v.stock_qty };
    }
    if (fn === 'reconcile_variant_stock') {
      const it = this.t('catalog_items').find((i) => i.id === args.p_item);
      if (!it || !it.has_variants) return { status: 400, body: { code: '22023', message: 'the item has no variants' } };
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
      const user = { id: this.opts.userId, aud: 'authenticated', role: 'authenticated', email: this.opts.email, app_metadata: {}, user_metadata: {}, created_at: now() };
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
    const rows = this.t(table);
    const wantsObject = (headers.accept ?? '').includes('vnd.pgrst.object');
    const prefer = headers.prefer ?? '';
    const ret = (list: Row[], status = 200, extra: Record<string, string> = {}) => {
      if (wantsObject) return list.length === 1 ? json(status, list[0], extra) : json(406, { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned (${list.length})` });
      return json(status, list, extra);
    };
    const err = (message: string) => json(400, { code: message.includes('duplicate key') ? '23505' : 'P0001', message, details: null, hint: null });

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
        rows.push(r); this.afterInsert(table, r); out.push(r);
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
      this.tables[table] = rows.filter((r) => !hit.includes(r));
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
