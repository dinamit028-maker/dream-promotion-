'use client';
import { supabase } from '@/lib/supabase/client';
import {
  PACKAGES_MIGRATION, packageError, toCatalogPackage, toClientPackage, toPackageUse,
  type CatalogPackage, type ClientPackage, type PackageUse,
} from './packages';

/**
 * Packages from the browser (migration 20261010004200). Row-level security decides what the signed-in member sees and may
 * write: the business worked in now, its money open to them, never a cashier, a viewer only reads — the database checks
 * every rule again (a sold package keeps its terms, one deduction per session, never beyond the package).
 * Before the migration runs, every read answers `missing` and the screens say which migration to run (or show nothing).
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string; missing: boolean };
const fail = (e: unknown): { ok: false; error: string; missing: boolean } => {
  const error = packageError(e);
  return { ok: false, error, missing: error === PACKAGES_MIGRATION };
};
export const PACKAGES_CHANGED = 'dp-packages-changed';
/** tell the card and the screens a customer's packages changed (a sale, a deduction, a cancelled session) */
export function packagesChanged(leadId: string) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<string>(PACKAGES_CHANGED, { detail: leadId }));
}

/** the sold packages with their numbers (client_package_status), newest first — of one customer when given */
export async function loadPackages(leadId?: string): Promise<Result<ClientPackage[]>> {
  let q = supabase().from('client_package_status').select('*').order('created_at', { ascending: false }).limit(500);
  if (leadId) q = q.eq('lead_id', leadId);
  const { data, error } = await q;
  return error ? fail(error) : { ok: true, data: ((data ?? []) as any[]).map(toClientPackage) };
}
export async function loadPackage(id: string): Promise<Result<ClientPackage | null>> {
  const { data, error } = await supabase().from('client_package_status').select('*').eq('id', id).maybeSingle();
  return error ? fail(error) : { ok: true, data: data ? toClientPackage(data) : null };
}
/** the treatments taken from these packages (and given back), newest first */
export async function loadUses(packageIds: string[]): Promise<Result<PackageUse[]>> {
  if (!packageIds.length) return { ok: true, data: [] };
  const { data, error } = await supabase().from('client_package_uses').select('*').in('package_id', packageIds).order('used_at', { ascending: false });
  return error ? fail(error) : { ok: true, data: ((data ?? []) as any[]).map(toPackageUse) };
}
/** the catalog's packages (catalog_items, kind 'package') with their terms */
export async function loadCatalogPackages(): Promise<Result<CatalogPackage[]>> {
  const { data, error } = await supabase().from('catalog_items')
    .select('id, name, price, active, description, package_sessions, package_type_id, package_valid_months')
    .eq('kind', 'package').order('sort').order('created_at');
  return error ? fail(error) : { ok: true, data: ((data ?? []) as any[]).map(toCatalogPackage) };
}
export interface TreatmentType { id: string; name: string; active: boolean }
/** the clinic's treatment types (every member reads them; the client file's people add them) — [] when there are none */
export async function loadTreatmentTypes(): Promise<TreatmentType[]> {
  const { data, error } = await supabase().from('treatment_types').select('id, name, active, sort').order('sort').order('name');
  return error ? [] : ((data ?? []) as any[]).map((t) => ({ id: String(t.id), name: String(t.name), active: t.active !== false }));
}
/** is migration 4200 in this database? (a probe of one column: the editor shows the package's terms only when it is) */
let readyCache: boolean | null = null;
export async function packagesReady(): Promise<boolean> {
  if (readyCache !== null) return readyCache;
  const { error } = await supabase().from('catalog_items').select('package_sessions').limit(1);
  readyCache = !error;
  return readyCache;
}

export interface NewPackage {
  id: string; userId: string; leadId: string; itemId: string | null; name: string; typeId: string | null;
  sessions: number; price: number; validUntil: string | null; notes: string;
}
/** a sale: the package with the terms copied from the catalog (the id is fixed when the dialog opens — a retry is the same sale) */
export async function insertPackage(p: NewPackage): Promise<Result<ClientPackage>> {
  const sb = supabase();
  const { error } = await sb.from('client_packages').insert({
    id: p.id, user_id: p.userId, lead_id: p.leadId, item_id: p.itemId, name: p.name.trim().slice(0, 120), treatment_type_id: p.typeId,
    sessions_total: p.sessions, price: Math.round(p.price * 100) / 100, valid_until: p.validUntil, notes: p.notes.trim().slice(0, 500),
  });
  // a retry of a sale that was saved (the answer was lost): the same package, never a second one
  if (error && !(error.code === '23505' && /client_packages_pkey/.test(`${error.message} ${error.details ?? ''}`))) return fail(error);
  const r = await loadPackage(p.id);
  if (!r.ok) return r;
  return r.data ? { ok: true, data: r.data } : { ok: false, error: 'החבילה לא נמצאה אחרי השמירה — רעננו ובדקו.', missing: false };
}
export async function cancelPackage(id: string, reason: string): Promise<Result<true>> {
  const { error } = await supabase().from('client_packages').update({ status: 'cancelled', cancel_reason: reason.trim().slice(0, 300) }).eq('id', id);
  return error ? fail(error) : { ok: true, data: true };
}
/** the owner moves the validity (null = no expiry) — written in the audit log by the database */
export async function setPackageValidity(id: string, validUntil: string | null): Promise<Result<true>> {
  const { data, error } = await supabase().from('client_packages').update({ valid_until: validUntil }).eq('id', id).select('id');
  if (error) return fail(error);
  return (data ?? []).length ? { ok: true, data: true } : { ok: false, error: 'אין הרשאה לשנות את החבילה.', missing: false };
}
/** a deduction by mistake: the treatment goes back to its package (the session itself stays) */
export async function giveBack(useId: string, reason: string): Promise<Result<true>> {
  const { data, error } = await supabase().from('client_package_uses').update({ returned_at: new Date().toISOString(), return_reason: reason.trim().slice(0, 300) })
    .eq('id', useId).is('returned_at', null).select('id');
  if (error) return fail(error);
  return (data ?? []).length ? { ok: true, data: true } : { ok: false, error: 'הניכוי כבר הוחזר, או שאין הרשאה.', missing: false };
}
/** a session given earlier, taken from a package now */
export async function deduct(p: { packageId: string; leadId: string; sessionId: string; userId: string }): Promise<Result<true>> {
  const { error } = await supabase().from('client_package_uses').insert({ package_id: p.packageId, lead_id: p.leadId, session_id: p.sessionId, user_id: p.userId });
  return error ? fail(error) : { ok: true, data: true };
}
