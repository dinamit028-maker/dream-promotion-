import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import {
  missingFromError, toCollection, toDomain, toPage, toStore, toVersion,
  type CollectionRow, type DomainRow, type MenuLink, type Missing, type PageRow, type PolicyKind, type StoreRow, type ThemeVersion,
} from './store';

/**
 * The store's reads and writes from the dashboard (2.55). Row-level security decides: the business worked in now, its
 * writers write, a viewer reads, a cashier sees nothing. A domain's connection, a preview link and store pictures go
 * through the server (/api/store/…). Before migration 3400 runs, the tables are missing: the screens say so.
 */
export const MIGRATION_3400 = 'החנות עוד לא מוכנה במסד הנתונים: צריך להריץ את מיגרציה 20261005003400_commerce_store.sql.';
type Result<T> = { ok: true; data: T } | { ok: false; error: string };
const missingTable = (e: any) => /PGRST20[2-5]|does not exist|schema cache/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
export function storeError(e: any, general = 'משהו השתבש. נסו שוב.'): string {
  if (!e) return general;
  if (missingTable(e)) return MIGRATION_3400;
  const m = String(e.message ?? '');
  if (/store_not_ready/.test(m)) return 'החנות עוד לא מוכנה לעלות לאוויר — השלימו את מה שחסר ברשימה.';
  if (/stores_business_uq/.test(m)) return 'לעסק הזה כבר יש חנות.';
  if (/store_domains_domain_uq/.test(m)) return 'הדומיין כבר מחובר לחנות (אולי של עסק אחר). אם הוא שלכם — פנו אלינו.';
  if (/catalog_collections_slug_uq|store_pages_store_id_slug_key/.test(m)) return 'הכתובת הזו כבר בשימוש. בחרו כתובת אחרת.';
  if (/store_pages_policy_uq/.test(m)) return 'כבר יש עמוד למדיניות הזו. רעננו את העמוד.';
  if (/store_links_ok|store_menus_items_check/.test(m)) return 'אחד הקישורים בתפריט לא תקין.';
  if (/store_theme_versions_draft_uq/.test(m)) return 'כבר יש טיוטה פתוחה. רעננו את העמוד.';
  if (/only the draft is edited/.test(m)) return 'גרסה שפורסמה לא משתנה. ערכו את הטיוטה.';
  if (/not of this business/.test(m)) return 'המוצר לא שייך לעסק הזה.';
  if (/row-level security|permission denied|42501/.test(`${e.code ?? ''} ${m}`)) return 'אין הרשאה לשנות את החנות (הרשאת צפייה בלבד?).';
  if (e.code === 'PGRST116') return 'לא נשמר — אין הרשאה, או שהפריט נמחק בינתיים.';
  if (e.code === '23514') return 'אחד הערכים לא תקין. בדקו את השדות ונסו שוב.';
  return general;
}
const fail = (e: any, general?: string): { ok: false; error: string } => ({ ok: false, error: storeError(e, general) });

export interface StoreBundle {
  store: StoreRow | null; domains: DomainRow[]; versions: ThemeVersion[]; pages: PageRow[];
  menus: { main: MenuLink[]; footer: MenuLink[] }; collections: CollectionRow[];
}

export async function loadStore(): Promise<Result<StoreBundle>> {
  const sb = supabase();
  const s = await sb.from('stores').select('*').maybeSingle();
  if (s.error) return fail(s.error, 'החנות לא נטענה — בדקו את החיבור ונסו שוב.');
  if (!s.data) return { ok: true, data: { store: null, domains: [], versions: [], pages: [], menus: { main: [], footer: [] }, collections: [] } };
  const id = (s.data as any).id as string;
  const [d, v, p, m, c, ci] = await Promise.all([
    sb.from('store_domains').select('*').eq('store_id', id).order('is_primary', { ascending: false }).order('domain'),
    sb.from('store_theme_versions').select('*').eq('store_id', id).order('version', { ascending: false }),
    sb.from('store_pages').select('*').eq('store_id', id).order('kind').order('title'),
    sb.from('store_menus').select('*').eq('store_id', id),
    sb.from('catalog_collections').select('*').order('position').order('title'),
    sb.from('catalog_collection_items').select('*'),
  ]);
  const bad = [d, v, p, m, c, ci].find((x) => x.error);
  if (bad) return fail(bad.error, 'החנות לא נטענה — בדקו את החיבור ונסו שוב.');
  const menus = { main: [] as MenuLink[], footer: [] as MenuLink[] };
  for (const r of (m.data ?? []) as any[]) if (r.kind === 'main' || r.kind === 'footer') menus[r.kind as 'main' | 'footer'] = Array.isArray(r.items) ? r.items : [];
  return { ok: true, data: {
    store: toStore(s.data), domains: ((d.data ?? []) as any[]).map(toDomain), versions: ((v.data ?? []) as any[]).map(toVersion),
    pages: ((p.data ?? []) as any[]).map(toPage), menus, collections: ((c.data ?? []) as any[]).map((r) => toCollection(r, (ci.data ?? []) as any[])),
  } };
}

export async function openStore(name: string): Promise<Result<StoreRow>> {
  const { data, error } = await supabase().from('stores').insert({ name: name.trim().slice(0, 80), template: 'bags' }).select('*').single();
  return error || !data ? fail(error, 'החנות לא נפתחה — נסו שוב.') : { ok: true, data: toStore(data) };
}

export type StorePatch = Partial<{ name: string; description: string; logo_url: string; phone: string; whatsapp: string; email: string; address: string;
  ga4_id: string; gsc_code: string; show_stock_count: boolean; status: 'draft' | 'published' | 'paused' }>;
export async function updateStore(id: string, patch: StorePatch): Promise<Result<StoreRow> & { missing?: Missing[] }> {
  const { data, error } = await supabase().from('stores').update(patch).eq('id', id).select('*').single();
  if (error) return { ...fail(error, 'לא נשמר — נסו שוב.'), missing: missingFromError(String(error.message ?? '')) };
  return { ok: true, data: toStore(data) };
}

export async function checklist(id: string): Promise<Result<{ ready: boolean; missing: Missing[] }>> {
  const { data, error } = await supabase().rpc('store_checklist', { p_store: id });
  if (error || !data) return fail(error, 'רשימת הבדיקה לא נטענה.');
  return { ok: true, data: { ready: Boolean((data as any).ready), missing: ((data as any).missing ?? []) as Missing[] } };
}

// ---- the theme: one draft, published versions ----------------------------------------------------------------------------
export async function saveDraft(storeId: string, template: string, settings: Record<string, unknown>, draft: ThemeVersion | null): Promise<Result<ThemeVersion>> {
  const sb = supabase();
  const q = draft
    ? sb.from('store_theme_versions').update({ settings }).eq('id', draft.id).select('*').single()
    : sb.from('store_theme_versions').insert({ store_id: storeId, template, settings }).select('*').single();
  const { data, error } = await q;
  return error || !data ? fail(error, 'הטיוטה לא נשמרה — נסו שוב.') : { ok: true, data: toVersion(data) };
}
export async function publishVersion(id: string): Promise<Result<true>> {
  const { error } = await supabase().rpc('store_publish_theme', { p_version: id });
  return error ? fail(error, 'הפרסום נכשל — נסו שוב.') : { ok: true, data: true };
}

// ---- pages, menus, collections -------------------------------------------------------------------------------------------
export type PageInput = { kind: 'page' | 'policy'; policy: PolicyKind | null; slug: string; title: string; body: string; seo_title: string; seo_description: string; published: boolean };
export async function savePage(storeId: string, id: string | null, row: PageInput): Promise<Result<PageRow>> {
  const sb = supabase();
  const q = id ? sb.from('store_pages').update(row).eq('id', id).select('*').single() : sb.from('store_pages').insert({ ...row, store_id: storeId }).select('*').single();
  const { data, error } = await q;
  return error || !data ? fail(error, 'העמוד לא נשמר — נסו שוב.') : { ok: true, data: toPage(data) };
}
export async function deletePage(id: string): Promise<Result<true>> {
  const { error } = await supabase().from('store_pages').delete().eq('id', id);
  return error ? fail(error, 'העמוד לא נמחק — נסו שוב.') : { ok: true, data: true };
}

export async function saveMenu(storeId: string, kind: 'main' | 'footer', items: MenuLink[]): Promise<Result<true>> {
  const { error } = await supabase().from('store_menus').upsert({ store_id: storeId, kind, items }, { onConflict: 'store_id,kind' });
  return error ? fail(error, 'התפריט לא נשמר — נסו שוב.') : { ok: true, data: true };
}

export type CollectionInput = { title: string; slug: string; description: string; image_url: string; kind: 'manual' | 'auto'; rules: { tags?: string[] };
  sort: CollectionRow['sort']; publish_online: boolean; seo_title: string; seo_description: string; position: number };
export async function saveCollection(id: string | null, row: CollectionInput, items: string[]): Promise<Result<CollectionRow>> {
  const sb = supabase();
  if (!id) {
    // a new collection comes last on the site (read now: the screen's list may be a moment old)
    const last = await sb.from('catalog_collections').select('position').order('position', { ascending: false }).limit(1).maybeSingle();
    if (last.error) return fail(last.error, 'הקולקציה לא נשמרה — נסו שוב.');
    row = { ...row, position: Number((last.data as { position?: number } | null)?.position ?? -1) + 1 };
  }
  const q = id ? sb.from('catalog_collections').update(row).eq('id', id).select('*').single() : sb.from('catalog_collections').insert(row).select('*').single();
  const { data, error } = await q;
  if (error || !data) return fail(error, 'הקולקציה לא נשמרה — נסו שוב.');
  const cid = (data as any).id as string;
  // the hand-picked products, in their order: replace the list (only the collection's own rows)
  const del = await sb.from('catalog_collection_items').delete().eq('collection_id', cid);
  if (del.error) return fail(del.error, 'רשימת המוצרים לא נשמרה — נסו שוב.');
  if (row.kind === 'manual' && items.length) {
    const ins = await sb.from('catalog_collection_items').insert(items.map((item_id, i) => ({ collection_id: cid, item_id, position: i })));
    if (ins.error) return fail(ins.error, 'רשימת המוצרים לא נשמרה — נסו שוב.');
  }
  return { ok: true, data: toCollection(data, row.kind === 'manual' ? items.map((item_id, i) => ({ collection_id: cid, item_id, position: i })) : []) };
}
/** the order of the collections on the site: 0…n-1 as on the screen (only the rows that moved are written) */
export async function orderCollections(list: { id: string; position: number }[]): Promise<Result<true>> {
  const sb = supabase();
  const moved = list.map((c, k) => ({ id: c.id, was: c.position, k })).filter((c) => c.was !== c.k);
  const results = await Promise.all(moved.map((c) => sb.from('catalog_collections').update({ position: c.k }).eq('id', c.id)));
  const bad = results.find((r) => r.error);
  return bad ? fail(bad.error, 'הסדר לא נשמר — נסו שוב.') : { ok: true, data: true };
}
export async function deleteCollection(id: string): Promise<Result<true>> {
  const { error } = await supabase().from('catalog_collections').delete().eq('id', id);
  return error ? fail(error, 'הקולקציה לא נמחקה — נסו שוב.') : { ok: true, data: true };
}

// ---- the server: domains, a preview link, store pictures ------------------------------------------------------------------
async function api<T>(path: string, body: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: j?.message || 'משהו השתבש. נסו שוב.' };
    return { ok: true, data: j as T };
  } catch { return { ok: false, error: 'אין חיבור לשרת. בדקו את האינטרנט ונסו שוב.' }; }
}
export interface DomainAnswer { domains: any[]; vercel: 'connected' | 'not_configured' | 'error'; message?: string }
export const connectDomain = (domain: string) => api<DomainAnswer>('/api/store/domains', { action: 'connect', domain });
export const checkDomains = () => api<DomainAnswer>('/api/store/domains', { action: 'check' });
export const removeDomain = (id: string) => api<DomainAnswer>('/api/store/domains', { action: 'remove', domainId: id });
export const previewLink = () => api<{ url: string; expires: number }>('/api/store/preview-token', {});
export const storeMediaApi = <T>(body: unknown) => api<T>('/api/store/media', body);
