/** A tiny in-memory stand-in for the Supabase query builder — enough for the booking routes. */
type Row = Record<string, any>;
export function fakeDb(tables: Record<string, Row[]>, rules: {
  onInsert?: (table: string, row: Row, all: Row[]) => { code: string; message: string } | null;
  /** a database function the test stands in for; none = "no such function" (as before its migration) */
  rpc?: Record<string, (args: any) => any>;
} = {}) {
  const from = (table: string) => {
    tables[table] ||= [];
    let filters: ((r: Row) => boolean)[] = [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: any = null; let conflict: string[] = ['id']; let single = false; let maybe = false; let limit = Infinity;
    const q: any = {
      select() { return q; }, order() { return q; },
      // or('a.is.null,b.eq.x'): any of them (is / eq / lt / gt — the value is the rest, so a timestamp's dots stay in it)
      or(list: string) {
        const parts = list.split(',').map((p) => {
          const [k, op, ...rest] = p.split('.'); const v = rest.join('.');
          return (r: Row) => (op === 'is' ? (r[k] ?? null) === (v === 'null' ? null : v) : op === 'eq' ? String(r[k] ?? '') === v
            : op === 'lt' ? r[k] != null && r[k] < v : op === 'gt' ? r[k] != null && r[k] > v : true);
        });
        filters.push((r) => parts.some((f) => f(r))); return q;
      },
      not(k: string, op: string, v: any) { if (op === 'is') filters.push((r) => (r[k] ?? null) !== v); return q; },
      lte(k: string, v: any) { filters.push((r) => r[k] <= v); return q; }, limit(n: number) { limit = n; return q; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
      neq(k: string, v: any) { filters.push((r) => r[k] !== v); return q; },
      ilike(k: string, v: string) { filters.push((r) => String(r[k] ?? '').toLowerCase() === v.toLowerCase()); return q; },
      in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
      lt(k: string, v: any) { filters.push((r) => r[k] < v); return q; },
      gt(k: string, v: any) { filters.push((r) => r[k] > v); return q; },
      gte(k: string, v: any) { filters.push((r) => r[k] >= v); return q; },
      is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return q; },
      insert(row: any) { op = 'insert'; payload = row; return q; },
      upsert(row: any, o: { onConflict?: string } = {}) { op = 'upsert' as any; payload = row; conflict = (o.onConflict ?? 'id').split(','); return q; },
      update(p: any) { op = 'update'; payload = p; return q; },
      delete() { op = 'delete'; return q; },
      single() { single = true; return q; }, maybeSingle() { maybe = true; return q; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    const run = () => {
      const rows = tables[table];
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: r.id ?? `${table}-${rows.length + 1}`, created_at: new Date().toISOString(), ...r }));
        for (const r of list) { const e = rules.onInsert?.(table, r, rows); if (e) return { data: null, error: e }; rows.push(r); }
        return { data: single ? list[0] : list, error: null };
      }
      if ((op as string) === 'upsert') {
        const list = Array.isArray(payload) ? payload : [payload];
        for (const r of list) {
          const same = rows.find((x) => conflict.every((k) => x[k] === r[k]));
          if (same) Object.assign(same, r); else rows.push({ ...r });
        }
        return { data: single || maybe ? list[0] : list, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return { data: single || maybe ? hit[0] ?? null : hit, error: null }; }
      if (op === 'delete') { tables[table] = rows.filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
      const out = hit.slice(0, limit);
      if (single || maybe) return { data: out[0] ?? null, error: single && !out[0] ? { message: 'no rows' } : null };
      return { data: out, error: null };
    };
    return q;
  };
  const rpc = async (fn: string, args: any) => {
    const f = rules.rpc?.[fn];
    return f ? { data: f(args), error: null } : { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
  };
  return { from, rpc };
}
