import { pageHref, PAGE_SIZE, SORT_LABELS } from '@/lib/query';
import type { ProductList, ProductQuery, Sort } from '@/lib/types';
import { ProductGrid } from './ui';

type Params = Record<string, string | string[] | undefined>;
const has = (sp: Params, k: string, v: string) => (Array.isArray(sp[k]) ? (sp[k] as string[]).includes(v) : sp[k] === v);

/** filters and sort: a plain form (GET) — it works without JavaScript, and the address keeps the choice */
export function Filters({ list, query, sp, path, sorts, showSearch = false }: {
  list: ProductList; query: ProductQuery; sp: Params; path: string; sorts: Sort[]; showSearch?: boolean;
}) {
  const optionNames = Object.keys(list.facets.options);
  const active = Object.keys(query.options ?? {}).length + (query.in_stock ? 1 : 0) + (query.min_price != null ? 1 : 0) + (query.max_price != null ? 1 : 0);
  return (
    <form method="get" action={path} className="filters" role="search" aria-label="סינון ומיון">
      {showSearch && (
        <div className="search-row">
          <label htmlFor="q" className="sr-only">חיפוש</label>
          <input id="q" name="q" type="search" defaultValue={query.q ?? ''} placeholder="מה מחפשים?" maxLength={80} autoComplete="off" />
          <button type="submit" className="btn btn-primary">חיפוש</button>
        </div>
      )}
      <details className="filter-panel" open={active > 0}>
        <summary>סינון ומיון{active > 0 ? ` (${active})` : ''}</summary>
        <div className="filter-body">
          <div className="filter-group">
            <label htmlFor="sort">מיון</label>
            <select id="sort" name="sort" defaultValue={query.sort ?? list.sort}>
              {sorts.map((s) => <option key={s} value={s}>{SORT_LABELS[s]}</option>)}
            </select>
          </div>
          {optionNames.map((name) => (
            <fieldset key={name} className="filter-group">
              <legend>{name}</legend>
              <div className="checks">
                {list.facets.options[name].map((v) => (
                  <label key={v} className="check">
                    <input type="checkbox" name={`o.${name}`} value={v} defaultChecked={has(sp, `o.${name}`, v)} /> {v}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {list.facets.price.min != null && list.facets.price.max != null && list.facets.price.max > list.facets.price.min && (
            <fieldset className="filter-group">
              <legend>מחיר (₪)</legend>
              <div className="price-range">
                <label>מ-<input name="min" type="number" inputMode="decimal" min={0} step="any" defaultValue={query.min_price ?? ''} placeholder={String(Math.floor(list.facets.price.min))} /></label>
                <label>עד<input name="max" type="number" inputMode="decimal" min={0} step="any" defaultValue={query.max_price ?? ''} placeholder={String(Math.ceil(list.facets.price.max))} /></label>
              </div>
            </fieldset>
          )}
          <label className="check"><input type="checkbox" name="stock" value="1" defaultChecked={query.in_stock} /> רק מה שבמלאי</label>
          <div className="filter-actions">
            {!showSearch && query.q && <input type="hidden" name="q" value={query.q} />}
            <button type="submit" className="btn btn-primary">הצגה</button>
            {active > 0 && <a href={query.q ? `${path}?q=${encodeURIComponent(query.q)}` : path} className="btn btn-ghost">ניקוי</a>}
          </div>
        </div>
      </details>
    </form>
  );
}

export function Pagination({ total, page, path, sp }: { total: number; page: number; path: string; sp: Params }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label="עמודים">
      {page > 1 ? <a href={pageHref(path, sp, page - 1)} rel="prev">הקודם</a> : <span aria-hidden="true" />}
      <span>עמוד {page} מתוך {pages}</span>
      {page < pages ? <a href={pageHref(path, sp, page + 1)} rel="next">הבא</a> : <span aria-hidden="true" />}
    </nav>
  );
}

export function Results({ list, currency, page, path, sp }: { list: ProductList; currency: string; page: number; path: string; sp: Params }) {
  return (
    <>
      <p className="count" aria-live="polite">{list.total === 1 ? 'מוצר אחד' : `${list.total} מוצרים`}</p>
      {list.items.length ? <ProductGrid items={list.items} currency={currency} eagerFirst={2} /> : <p className="empty">לא נמצאו מוצרים. אפשר לנסות סינון אחר.</p>}
      <Pagination total={list.total} page={page} path={path} sp={sp} />
    </>
  );
}
