/**
 * An in-memory stand-in for Supabase (PostgREST + auth) for browser tests: Playwright routes every request
 * to http://sb.test here. It answers the queries the register makes and mirrors the database rules that the
 * screens rely on (document numbering, stock moving with sales / refunds / cancels, refunds never beyond what
 * was paid). The real rules are tested on Postgres in tests/sql — this only lets the real UI run end to end.
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
  linkNo = 0;
  calls: { method: string; path: string; body?: any }[] = [];
  constructor(public tables: Tables, public opts: { businessId: string; userId: string; email: string }) {}

  private t(name: string) { return (this.tables[name] ||= []); }
  private stock(itemId: string, delta: number, reason: string, ref: { sale?: string; refund?: string; note?: string } = {}) {
    const it = this.t('catalog_items').find((i) => i.id === itemId && i.track_stock);
    if (!it || !delta) return;
    it.stock_qty = Number(it.stock_qty ?? 0) + delta;
    this.t('stock_movements').push({ id: randomUUID(), business_id: this.opts.businessId, item_id: itemId, delta, qty_after: it.stock_qty, reason,
      sale_id: ref.sale ?? null, refund_id: ref.refund ?? null, note: ref.note ?? '', created_at: now() });
  }
  private lines(items: any): { id: string; qty: number }[] {
    const m = new Map<string, number>();
    for (const l of Array.isArray(items) ? items : []) if (l?.itemId && Number(l.qty) > 0) m.set(l.itemId, (m.get(l.itemId) ?? 0) + Math.floor(Number(l.qty)));
    return [...m.entries()].map(([id, qty]) => ({ id, qty }));
  }

  /** the database's BEFORE INSERT side: defaults, numbering, checks — an error string refuses the row */
  private beforeInsert(table: string, r: Row): string | null {
    r.id ??= randomUUID();
    r.created_at ??= now();
    if (!['businesses', 'business_members', 'profiles'].includes(table)) r.business_id ??= this.opts.businessId;
    if (table === 'documents') {
      const n = (this.counters.get(r.doc_type) ?? 0) + 1; this.counters.set(r.doc_type, n);
      Object.assign(r, { doc_number: n, issued_at: now(), print_count: 0, link_no: ++this.linkNo, share_token: randomBytes(32).toString('hex') });
    }
    if (table === 'sales') { r.status ??= 'paid'; r.payments ??= []; r.discount ??= 0; r.note ??= ''; }
    if (table === 'sale_refunds') {
      const s = this.t('sales').find((x) => x.id === r.sale_id);
      if (!s) return 'sale not found';
      if (s.status !== 'paid') return 'only a paid sale can be refunded';
      const done = this.t('sale_refunds').filter((x) => x.sale_id === r.sale_id).reduce((a, x) => a + Math.round(Number(x.amount) * 100), 0);
      if (done + Math.round(Number(r.amount) * 100) > Math.round(Number(s.total) * 100)) return `refund_exceeds_paid: ${(Number(s.total) * 100 - done) / 100} left`;
      r.created_at = now();
    }
    if (table === 'register_shifts') { r.opened_at ??= now(); if (this.t('register_shifts').some((x) => !x.closed_at)) return 'duplicate key value violates unique constraint "register_shifts_one_open_idx"'; }
    return null;
  }
  private afterInsert(table: string, r: Row) {
    if (table === 'sales' && ['paid', 'pending'].includes(r.status)) for (const l of this.lines(r.items)) this.stock(l.id, -l.qty, 'sale', { sale: r.id });
    if (table === 'sale_refunds' && r.restock) for (const l of this.lines(r.items)) this.stock(l.id, l.qty, 'refund', { sale: r.sale_id, refund: r.id });
  }
  private beforeUpdate(table: string, old: Row, patch: Row): string | null {
    if (table === 'sales' && patch.status === 'cancelled' && old.status !== 'cancelled' && this.t('sale_refunds').some((x) => x.sale_id === old.id)) return 'a refunded sale can not be cancelled';
    if (table === 'catalog_items' && 'stock_qty' in patch && patch.stock_qty !== old.stock_qty) return 'stock changes only through adjust_stock';
    return null;
  }
  private afterUpdate(table: string, old: Row, r: Row) {
    if (table === 'sales' && r.status === 'cancelled' && ['paid', 'pending'].includes(old.status)) for (const l of this.lines(r.items)) this.stock(l.id, l.qty, 'cancel', { sale: r.id });
  }

  rpc(fn: string, args: any): { status: number; body: any } {
    if (fn === 'pos_employees') return { status: 200, body: this.t('employees').filter((e) => e.active !== false).map((e) => ({ id: e.id, name: e.name })) };
    if (fn === 'business_for_user') return { status: 200, body: this.opts.businessId };
    if (fn === 'adjust_stock') {
      const it = this.t('catalog_items').find((i) => i.id === args.p_item);
      if (!it) return { status: 400, body: { code: '42501', message: 'not allowed' } };
      if (!it.track_stock) { it.track_stock = true; it.stock_qty = 0; }
      const d = args.p_mode === 'add' ? Number(args.p_qty) : Number(args.p_qty) - Number(it.stock_qty);
      this.stock(it.id, d, args.p_mode === 'add' ? 'receive' : 'count', { note: args.p_note ?? '' });
      return { status: 200, body: it.stock_qty };
    }
    return { status: 404, body: { code: 'PGRST202', message: `function ${fn} not found` } };
  }

  /** one HTTP request → { status, body, headers } */
  handle(method: string, href: string, headers: Record<string, string>, bodyText: string | null): { status: number; body?: string; headers?: Record<string, string> } {
    const url = new URL(href);
    const json = (status: number, body: any, extra: Record<string, string> = {}) => ({ status, body: body === undefined ? '' : JSON.stringify(body), headers: { 'content-type': 'application/json', ...extra } });
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
      return ret(list.slice(0, limit));
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
