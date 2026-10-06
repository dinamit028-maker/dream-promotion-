import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import {
  checkoutError, couponError, toCoupon, toOrder, toOrderEvent, toOrderLine,
  type CheckoutPatch, type Coupon, type CouponRow, type OrderEvent, type OrderLine, type OrderRow, type TerminalInfo,
} from './checkout';
import { planBlocked, type KitChoices, type KitPlan } from './kits';
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
export const MIGRATION_3600 = 'רישום מכירות מהאתר עוד לא מוכן במסד הנתונים: צריך להריץ את מיגרציה 20261006003600_commerce_finance.sql.';
export const MIGRATION_3500 = 'המכירה באתר עוד לא מוכנה במסד הנתונים: צריך להריץ את מיגרציה 20261006003500_commerce_checkout.sql.';
type Result<T> = { ok: true; data: T } | { ok: false; error: string };
const missingTable = (e: any) => /PGRST20[2-5]|does not exist|schema cache/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
export function storeError(e: any, general = 'משהו השתבש. נסו שוב.'): string {
  if (!e) return general;
  if (missingTable(e) && /email_outbox|store_alerts|store_email_domains|order_set_fulfillment|store_alerts_seen|commerce_live|tracking|document_error|request_kind/.test(String(e.message ?? ''))) return MIGRATION_3600;
  if (missingTable(e)) return /store_coupons|orders|order_|payment_|checkout|reserve|pickup|delivery/.test(String(e.message ?? '')) ? MIGRATION_3500 : MIGRATION_3400;
  const m = String(e.message ?? '');
  const sale = checkoutError(m) ?? couponError(m);
  if (sale) return sale;
  if (/store_slug_reserved/.test(m)) return 'השם הזה שמור למערכת. בחרו כתובת אחרת.';
  if (/store_slug_invalid|stores_slug_check/.test(m)) return 'הכתובת לא תקינה: 3–40 אותיות באנגלית, ספרות ומקף.';
  if (/stores_slug_uq/.test(m)) return 'הכתובת הזו כבר של חנות אחרת. בחרו אחרת.';
  if (/stores_password_check/.test(m)) return 'סיסמה של 4 עד 40 תווים (או ריקה).';
  if (/store_lock_needs_password/.test(m)) return 'כדי לנעול את האתר צריך סיסמה.';
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

/** a new store is on the open template of the starter kits (2.58): the kit of its field is applied right after */
export async function openStore(name: string): Promise<Result<StoreRow>> {
  const { data, error } = await supabase().from('stores').insert({ name: name.trim().slice(0, 80), template: 'kit' }).select('*').single();
  return error || !data ? fail(error, 'החנות לא נפתחה — נסו שוב.') : { ok: true, data: toStore(data) };
}

export type StorePatch = Partial<{ name: string; description: string; logo_url: string; phone: string; whatsapp: string; email: string; address: string;
  ga4_id: string; gsc_code: string; show_stock_count: boolean; status: 'draft' | 'published' | 'paused' } & CheckoutPatch & { checkout_enabled: boolean }
  & { slug: string; storefront_password: string; password_lock: boolean }>;
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
export async function saveDraft(storeId: string, template: string, settings: Record<string, unknown>, draft: Pick<ThemeVersion, 'id'> | null, note?: string): Promise<Result<ThemeVersion>> {
  const sb = supabase();
  // a draft may change its template (a kit moves it to "kit"); a published version never does (the database refuses)
  const q = draft
    ? sb.from('store_theme_versions').update({ settings, template, ...(note !== undefined ? { note } : {}) }).eq('id', draft.id).select('*').single()
    : sb.from('store_theme_versions').insert({ store_id: storeId, template, settings, ...(note !== undefined ? { note } : {}) }).select('*').single();
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

// ---- starter kits (2.58) -------------------------------------------------------------------------------------------------------
/** the business's booking page, when it takes appointments online (the existing appointments system) — else '' */
export async function bookingUrl(origin: string): Promise<string> {
  const { data } = await supabase().from('booking_settings').select('slug, enabled').maybeSingle();
  const slug = (data as { slug?: string; enabled?: boolean } | null)?.slug;
  return (data as any)?.enabled && slug && /^https:\/\//.test(origin) ? `${origin}/book/${slug}` : '';
}

export interface KitApplied { collections: number; pages: number; replacedPages: number; menus: number; version: number; published: boolean }
/**
 * A kit's plan, written: the missing collections and pages (drafts), the menus that were empty or that the owner chose to
 * replace, and the theme as the one draft (published only for a store that never published a theme). Each step through the
 * existing tables and row-level security; it stops at the first failure and says what was already done (a second run
 * creates only what is still missing).
 */
export async function applyKit(storeId: string, plan: KitPlan, choices: KitChoices): Promise<Result<KitApplied> & { done?: Partial<KitApplied> }> {
  const blocked = planBlocked(plan, choices);
  if (blocked) return { ok: false, error: blocked };
  const done: KitApplied = { collections: 0, pages: 0, replacedPages: 0, menus: 0, version: 0, published: false };
  const stop = (error: string) => ({ ok: false as const, error, done });
  for (const c of plan.collections) {
    const r = await saveCollection(null, c, []);
    if (!r.ok) return stop(`הקולקציה "${c.title}": ${r.error}`);
    done.collections++;
  }
  for (const p of plan.pages) {
    const r = await savePage(storeId, null, p);
    if (!r.ok) return stop(`העמוד "${p.title}": ${r.error}`);
    done.pages++;
  }
  for (const c of plan.pageConflicts.filter((x) => choices.replacePages.includes(x.id))) {
    const r = await savePage(storeId, c.id, c.row);
    if (!r.ok) return stop(`העמוד "${c.row.title}": ${r.error}`);
    done.replacedPages++;
  }
  for (const kind of ['main', 'footer'] as const) {
    const m = plan.menus[kind];
    if (m.action === 'create' || (m.action === 'conflict' && choices.replaceMenus.includes(kind))) {
      const r = await saveMenu(storeId, kind, m.items);
      if (!r.ok) return stop(`התפריט: ${r.error}`);
      done.menus++;
    }
  }
  const v = await saveDraft(storeId, 'kit', plan.settings, plan.draft.id ? { id: plan.draft.id } : null, `ערכה: ${plan.kit.name}`);
  if (!v.ok) return stop(`העיצוב: ${v.error}`);
  done.version = v.data.version;
  if (plan.publishTheme) {
    const r = await publishVersion(v.data.id);
    if (!r.ok) return stop(`העיצוב: ${r.error}`);
    done.published = true;
  }
  return { ok: true, data: done };
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
export const previewLink = () => api<{ url: string; expires: number; token: string; base: string }>('/api/store/preview-token', {});
export const storeMediaApi = <T>(body: unknown) => api<T>('/api/store/media', body);

// ---- selling on the site (2.56): the terminal, coupons, orders -----------------------------------------------------------
async function apiGet<T>(path: string): Promise<Result<T>> {
  try {
    const res = await fetch(path, { headers: { ...(await authHeaders()) }, cache: 'no-store' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: j?.message || 'משהו השתבש. נסו שוב.' };
    return { ok: true, data: j as T };
  } catch { return { ok: false, error: 'אין חיבור לשרת. בדקו את האינטרנט ונסו שוב.' }; }
}
export const terminalInfo = () => apiGet<TerminalInfo>('/api/store/payments');
export const connectTerminal = (apiKey: string, secretKey: string, pageUid: string, mode: 'test' | 'live' = 'test') =>
  api<TerminalInfo>('/api/store/payments', { action: 'connect', apiKey, secretKey, pageUid, mode });
export const disconnectTerminal = () => api<TerminalInfo>('/api/store/payments', { action: 'disconnect' });

export async function loadCoupons(): Promise<Result<Coupon[]>> {
  const { data, error } = await supabase().from('store_coupons').select('*').order('created_at', { ascending: false });
  return error ? fail(error, 'הקופונים לא נטענו.') : { ok: true, data: ((data ?? []) as any[]).map(toCoupon) };
}
export async function saveCoupon(storeId: string, id: string | null, row: CouponRow): Promise<Result<Coupon>> {
  const sb = supabase();
  const q = id ? sb.from('store_coupons').update(row).eq('id', id).select('*').single() : sb.from('store_coupons').insert({ ...row, store_id: storeId }).select('*').single();
  const { data, error } = await q;
  return error || !data ? fail(error, 'הקופון לא נשמר — נסו שוב.') : { ok: true, data: toCoupon(data) };
}
export async function setCouponActive(id: string, active: boolean): Promise<Result<Coupon>> {
  const { data, error } = await supabase().from('store_coupons').update({ active }).eq('id', id).select('*').single();
  return error || !data ? fail(error, 'לא נשמר — נסו שוב.') : { ok: true, data: toCoupon(data) };
}
export async function deleteCoupon(id: string): Promise<Result<true>> {
  const { error } = await supabase().from('store_coupons').delete().eq('id', id);
  return error ? fail(error, 'הקופון לא נמחק — נסו שוב.') : { ok: true, data: true };
}

/** the latest orders of the business worked in now (row-level security: not a cashier; a super admin only with open access) */
export async function loadOrders(limit = 200): Promise<Result<OrderRow[]>> {
  const { data, error } = await supabase().from('orders').select('*').order('created_at', { ascending: false }).limit(limit);
  return error ? fail(error, 'ההזמנות לא נטענו.') : { ok: true, data: ((data ?? []) as any[]).map(toOrder) };
}
export interface OrderEmail { kind: string; status: 'queued' | 'sending' | 'sent' | 'failed'; error: string; sentAt: string | null }
export interface OrderDoc { id: string; type: number; number: number; token: string }
export interface OrderRefund { id: string; amount: number; at: string; restock: boolean; reason: string }
export interface OrderDetail {
  order: OrderRow; lines: OrderLine[]; events: OrderEvent[];
  /** stage 4 (migration 3600): what was sent to the customer, the documents and refunds of its sale */
  emails: OrderEmail[]; docs: OrderDoc[]; refunds: OrderRefund[]; saleItems: { name: string; qty: number; price: number }[]; storeName: string;
}
export async function loadOrder(id: string): Promise<Result<OrderDetail | null>> {
  const sb = supabase();
  const [o, l, e] = await Promise.all([
    sb.from('orders').select('*').eq('id', id).maybeSingle(),
    sb.from('order_lines').select('*').eq('order_id', id).order('position'),
    sb.from('order_events').select('*').eq('order_id', id).order('id'),
  ]);
  const bad = [o, l, e].find((x) => x.error);
  if (bad) return fail(bad.error, 'ההזמנה לא נטענה.');
  if (!o.data) return { ok: true, data: null };
  const order = toOrder(o.data);
  // before migration 3600 these are missing: the page shows the order without them
  const [m, d, r, s, st] = await Promise.all([
    sb.from('email_outbox').select('kind, status, last_error, sent_at, created_at').eq('order_id', id).order('created_at'),
    order.saleId ? sb.from('documents').select('id, doc_type, doc_number, share_token').eq('sale_id', order.saleId).order('issued_at') : Promise.resolve({ data: [], error: null }),
    order.saleId ? sb.from('sale_refunds').select('id, amount, created_at, restock, reason').eq('sale_id', order.saleId).order('created_at') : Promise.resolve({ data: [], error: null }),
    order.saleId ? sb.from('sales').select('items').eq('id', order.saleId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    sb.from('stores').select('name').eq('id', (o.data as any).store_id).maybeSingle(),
  ]);
  return { ok: true, data: {
    order, lines: ((l.data ?? []) as any[]).map(toOrderLine), events: ((e.data ?? []) as any[]).map(toOrderEvent),
    emails: ((m.data ?? []) as any[]).map((x) => ({ kind: x.kind, status: x.status, error: x.last_error ?? '', sentAt: x.sent_at ?? null })),
    docs: ((d.data ?? []) as any[]).map((x) => ({ id: x.id, type: Number(x.doc_type), number: Number(x.doc_number), token: x.share_token })),
    refunds: ((r.data ?? []) as any[]).map((x) => ({ id: x.id, amount: Number(x.amount), at: x.created_at, restock: Boolean(x.restock), reason: x.reason ?? '' })),
    saleItems: (((s.data as any)?.items ?? []) as any[]).map((x) => ({ name: String(x.name ?? ''), qty: Number(x.qty ?? 0), price: Number(x.price ?? 0) })),
    storeName: String((st.data as any)?.name ?? ''),
  } };
}

// ---- stage 4: handling an order ------------------------------------------------------------------------------------------
/** where the goods stand; "ready" / "shipped" email the customer (the server sends it now, the cron otherwise) */
export async function setFulfillment(id: string, status: string, tracking = '', url = ''): Promise<Result<true>> {
  const { data, error } = await supabase().rpc('order_set_fulfillment', { p_order: id, p_status: status, p_tracking: tracking, p_url: url });
  if (error) return fail(error, 'לא נשמר — נסו שוב.');
  const r = data as { ok: boolean; error?: string };
  if (!r?.ok) return { ok: false, error: r?.error === 'url' ? 'קישור המעקב צריך להתחיל ב-https://' : r?.error === 'not_paid' ? 'אפשר לעדכן רק הזמנה ששולמה.' : 'לא נשמר — נסו שוב.' };
  void api('/api/commerce/finalize', { orderId: id });
  return { ok: true, data: true };
}
export const retryOrderDocument = (id: string) => api<{ document: string; error?: string }>('/api/commerce/finalize', { orderId: id, retry: true });
export interface RefundBody { orderId: string; mode: 'full' | 'items' | 'amount'; qty?: number[]; amount?: number; restock: boolean; reason: string; confirmed: boolean }
export const refundOrder = (b: RefundBody) => api<{ ok: true; refundId: string; amount: number; credit: string }>('/api/store/orders/refund', b);
export async function alertsSeen(id: string) { try { await supabase().rpc('store_alerts_seen', { p_order: id }); } catch { /* a mark only */ } }

/** the store's sending domain for customers' emails (written by the server with Resend's answer) */
export interface EmailDomain { domain: string; status: 'pending' | 'verified' | 'failed'; fromName: string; records: { type: string; name: string; value: string; priority?: number }[]; checkedAt: string | null }
export async function loadEmailDomain(): Promise<Result<EmailDomain | null>> {
  const { data, error } = await supabase().from('store_email_domains').select('domain, status, from_name, records, checked_at').maybeSingle();
  if (error) return fail(error, 'כתובת השליחה לא נטענה.');
  return { ok: true, data: data ? { domain: data.domain, status: data.status, fromName: data.from_name ?? '', records: Array.isArray(data.records) ? data.records : [], checkedAt: data.checked_at ?? null } : null };
}
export const connectEmailDomain = (domain: string, fromName: string) => api<{ ok: true }>('/api/store/email-domain', { action: 'connect', domain, fromName });
export const verifyEmailDomain = () => api<{ ok: true; status: string }>('/api/store/email-domain', { action: 'verify' });

/** is an address free (the store's own address is) — {ok} or {ok: false, error, suggestion} */
export async function slugAvailable(slug: string): Promise<Result<{ ok: boolean; error?: 'invalid' | 'reserved' | 'taken'; suggestion?: string }>> {
  const { data, error } = await supabase().rpc('store_slug_available', { p_slug: slug });
  return error ? fail(error, 'לא הצלחנו לבדוק את הכתובת.') : { ok: true, data: data as any };
}
