/** A tiny in-memory stand-in for the Supabase query builder — enough for the booking routes. */
type Row = Record<string, any>;
export function fakeDb(tables: Record<string, Row[]>, rules: { onInsert?: (table: string, row: Row, all: Row[]) => { code: string; message: string } | null } = {}) {
  const from = (table: string) => {
    tables[table] ||= [];
    let filters: ((r: Row) => boolean)[] = [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: any = null; let single = false; let maybe = false; let limit = Infinity;
    const q: any = {
      select() { return q; }, order() { return q; }, limit(n: number) { limit = n; return q; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
      in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
      lt(k: string, v: any) { filters.push((r) => r[k] < v); return q; },
      gt(k: string, v: any) { filters.push((r) => r[k] > v); return q; },
      gte(k: string, v: any) { filters.push((r) => r[k] >= v); return q; },
      is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return q; },
      insert(row: any) { op = 'insert'; payload = row; return q; },
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
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return { data: hit, error: null }; }
      if (op === 'delete') { tables[table] = rows.filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
      const out = hit.slice(0, limit);
      if (single || maybe) return { data: out[0] ?? null, error: single && !out[0] ? { message: 'no rows' } : null };
      return { data: out, error: null };
    };
    return q;
  };
  return { from };
}
