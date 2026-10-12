'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { authHeaders } from '@/lib/services/http';
import { isCloudConfigured } from '@/lib/supabase/client';
import { useApp } from '@/lib/store';
import type { Lead } from '@/types';
import type { NoticeView, RoutingView } from './lead-routing';

/**
 * The lead departments of the business worked in (2.99), for the contacts list ("הלידים שלי", "ללא מחלקה", who is responsible),
 * the card and the departments screen: read once per business through /api/leads/departments and shared by every screen.
 * Every change goes through the server (the owner only) and answers with the fresh view.
 */
export type NotReady = { ready: false; connected: boolean; owner: boolean; code: string; message: string };
type State = { view: RoutingView | NotReady | null; biz: string | null; error: string | null };
let state: State = { view: null, biz: null, error: null };
const subs = new Set<() => void>();
const put = (s: Partial<State>) => { state = { ...state, ...s }; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const snapshot = () => state;
let inflight: { biz: string | null; p: Promise<void> } | null = null;

async function api(path: string, init: RequestInit = {}) {
  try {
    const r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...(init.headers ?? {}) } });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body: j as any };
  } catch {
    return { ok: false, status: 0, body: { message: 'אין חיבור כרגע. כדאי לנסות שוב בעוד רגע.' } };
  }
}

export function loadLeadRouting(force = false): Promise<void> {
  if (!isCloudConfigured) return Promise.resolve();
  const biz = useApp.getState().businessId ?? null;
  if (!force && state.view && state.biz === biz) return Promise.resolve();
  if (!force && inflight && inflight.biz === biz) return inflight.p;
  const p = (async () => {
    const r = await api('/api/leads/departments');
    if (useApp.getState().businessId !== biz) return; // switched business meanwhile
    if (r.ok && r.body) put({ view: r.body, biz, error: null });
    else put({ view: null, biz, error: r.body?.message ?? 'לא הצלחנו לטעון את המחלקות.' });
  })().finally(() => { if (inflight?.p === p) inflight = null; });
  inflight = { biz, p };
  return p;
}

/** the view (null while loading, or without the cloud); loads it on first use and again when the business changes */
export function useLeadRouting() {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const biz = useApp((x) => x.businessId ?? null);
  useEffect(() => { void loadLeadRouting(); }, [biz]);
  const view = s.biz === biz ? s.view : null;
  return { view: view && view.ready ? view : null, notReady: view && !view.ready ? view : null, error: s.biz === biz ? s.error : null };
}

/** an answer of the server with the whole view — kept for every screen */
export function keepView(view: RoutingView) { put({ view, biz: useApp.getState().businessId ?? null, error: null }); }

export const postDepartments = (body: Record<string, unknown>) => api('/api/leads/departments', { method: 'POST', body: JSON.stringify(body) });
export const loadSetup = () => api('/api/leads/departments?view=setup');
export const loadForms = () => api('/api/leads/departments?view=forms');

export type CardRouting = {
  lead: { id: string; departmentId: string | null; assignedStaffId: string | null; routedAt: string | null; routedBy: string };
  notifications: NoticeView[]; connected: boolean; owner: boolean;
};
export const loadCard = (leadId: string) => api(`/api/leads/assignment?lead=${encodeURIComponent(leadId)}`);
export const postAssignment = (body: Record<string, unknown>) => api('/api/leads/assignment', { method: 'POST', body: JSON.stringify(body) });

/** the contact on the screen gets what the server set (the database refuses these columns from the browser — nothing is saved here) */
export function patchLeadRouting(l: CardRouting['lead']) {
  useApp.setState((s) => ({
    leads: s.leads.map((x): Lead => (x.id === l.id ? { ...x, departmentId: l.departmentId, assignedStaffId: l.assignedStaffId, routedAt: l.routedAt, routedBy: l.routedBy } : x)),
  }));
}

/** the list's filters */
export const isMine = (l: Pick<Lead, 'assignedStaffId'>, me: string[]) => Boolean(l.assignedStaffId && me.includes(l.assignedStaffId));
export const noDepartment = (l: Pick<Lead, 'routedAt' | 'departmentId'>) => Boolean(l.routedAt && !l.departmentId);
