/**
 * An in-memory stand-in for Supabase (PostgREST + auth) for browser tests: Playwright routes every request
 * to http://sb.test here. It answers the queries the register makes and mirrors the database rules that the
 * screens rely on (document numbering, stock moving with sales / refunds / cancels, refunds never beyond what
 * was paid; 2.54: stock per variant, an item's sum of its variants, a signed upload to storage; 2.55: the store — one per
 * business, its checklist before it goes on the air, theme versions, unique addresses of pages and collections).
 * The real rules are tested on Postgres in tests/sql — this only lets the real UI run end to end.
 */
import { randomUUID, randomBytes } from 'node:crypto';

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
      receivables: { open: r2(recv.reduce((a, x) => a + x.balance, 0)), count: recv.length, overdue: r2(recv.filter((x) => x.due_date && x.due_date < today).reduce((a, x) => a + x.balance, 0)),
        overdueCount: recv.filter((x) => x.due_date && x.due_date < today).length },
      pending: { count: this.t('sales').filter((x) => x.status === 'pending').length, total: 0 }, posWithoutDocument: { count: 0, total: 0 }, allocationMissing: 0,
      months: [{ month, revenue: r2(rev(docs)), expenses: r2(eNet + eVat - eDed) }], lockedUntil: this.finance.lockedUntil,
    };
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
      const n = (this.numbers.get('expense') ?? 0) + 1; this.numbers.set('expense', n);
      Object.assign(r, { expense_number: n, status: r.status ?? 'confirmed', confirmed_at: (r.status ?? 'confirmed') === 'confirmed' ? now() : null, stock_lines: r.stock_lines ?? [], updated_at: now() });
    }
    if (table === 'document_drafts') Object.assign(r, { status: 'open', document_id: null, updated_at: now() });
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
        show_stock_count: false, published_at: null, updated_at: now() });
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
    if (!this.t('store_domains').some((d) => d.store_id === s.id && d.is_primary && d.status === 'active')) out.push('domain');
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
    if (table === 'quotes' && patch.status && patch.status !== old.status) {
      const next: Record<string, string[]> = { draft: ['sent', 'cancelled', 'converted'], sent: ['draft', 'accepted', 'rejected', 'expired', 'cancelled', 'converted'], accepted: ['converted', 'cancelled'], expired: ['sent', 'cancelled'] };
      if (!(next[old.status] ?? []).includes(patch.status)) return `quote_status: ${old.status} → ${patch.status} is not allowed`;
      if (patch.status === 'sent') patch.sent_at = now();
      if (patch.status === 'accepted' || patch.status === 'rejected') patch.decided_at = now();
    }
    if (table === 'document_drafts' && old.status !== 'open') return 'the draft was already issued';
    if (table === 'expenses' && old.status === 'void') return 'a void expense does not change';
    if (table === 'expenses' && patch.status === 'void') patch.voided_at = now();
    if (table === 'sales' && patch.status === 'cancelled' && old.status !== 'cancelled' && this.t('sale_refunds').some((x) => x.sale_id === old.id)) return 'a refunded sale can not be cancelled';
    if (table === 'catalog_items' && 'stock_qty' in patch && patch.stock_qty !== old.stock_qty) return 'stock changes only through adjust_stock';
    if (table === 'catalog_variants' && 'stock_qty' in patch && patch.stock_qty !== old.stock_qty) return 'stock changes only through a delivery or a count (adjust_variant_stock)';
    if (table === 'catalog_items' && patch.publish_online && !old.published_at) patch.published_at = now();
    if (table === 'stores') {
      patch.updated_at = now();
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
    if (table === 'sales' && r.status === 'cancelled' && ['paid', 'pending'].includes(old.status)) for (const l of this.lines(r.items)) this.stock(l.id, l.qty, 'cancel', { sale: r.id, variant: l.variant });
  }

  rpc(fn: string, args: any): { status: number; body: any } {
    if (fn === 'pos_employees') return { status: 200, body: this.t('employees').filter((e) => e.active !== false).map((e) => ({ id: e.id, name: e.name })) };
    if (fn === 'business_for_user') return { status: 200, body: this.opts.businessId };
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
    return { status: 404, body: { code: 'PGRST202', message: `function ${fn} not found` } };
  }

  /** one HTTP request → { status, body, headers } */
  handle(method: string, href: string, headers: Record<string, string>, bodyText: string | null): { status: number; body?: string; headers?: Record<string, string> } {
    const url = new URL(href);
    const json = (status: number, body: any, extra: Record<string, string> = {}) => ({ status, body: body === undefined ? '' : JSON.stringify(body), headers: { 'content-type': 'application/json', ...extra } });
    // ---- storage: an upload with a signed link (the store's pictures, 2.54) — a binary body, before any JSON ----
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
    if (table === 'receivables') this.tables.receivables = this.receivables();
    const rows = this.t(table);
    const wantsObject = (headers.accept ?? '').includes('vnd.pgrst.object');
    const prefer = headers.prefer ?? '';
    const ret = (list: Row[], status = 200) => {
      if (wantsObject) return list.length === 1 ? json(status, list[0]) : json(406, { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned (${list.length})` });
      return json(status, list);
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
      return ret(list.slice(offset, offset + limit));
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
