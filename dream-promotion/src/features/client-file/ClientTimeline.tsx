'use client';
import { useEffect, useMemo, useState } from 'react';
import { Chip } from '@/components/ui/primitives';
import { formatIL } from '@/lib/il-time';
import { authHeaders } from '@/lib/services/http';
import { ACTIVITY_HE } from '@/features/crm/crm';
import type { LeadActivity } from '@/types';
import { CLIENT_FILE_CHANGED } from './photos';

/**
 * One timeline in the client card (docs/CLIENT FILE ENGINEERING HE.md §6): the CRM activities of the card together with
 * the client file — treatments, sessions, photos, declarations — and the appointments, newest first, with a filter by kind
 * and a jump to a treatment's photos. Anyone without access to the client file sees the CRM activities only, as before.
 */
type Kind = 'crm' | 'treatment' | 'session' | 'photo' | 'declaration' | 'appointment';
interface Ev { at: string; kind: Exclude<Kind, 'crm'>; title: string; sub?: string; treatmentId?: string | null }
const KIND: Record<Kind, { icon: string; label: string }> = {
  crm: { icon: '💬', label: 'CRM' }, treatment: { icon: '🩺', label: 'טיפולים' }, session: { icon: '🩺', label: 'טיפולים' },
  photo: { icon: '📷', label: 'צילומים' }, declaration: { icon: '📝', label: 'הצהרות' }, appointment: { icon: '📅', label: 'תורים' },
};
const FILTERS: { id: 'all' | Kind; label: string }[] = [
  { id: 'all', label: 'הכל' }, { id: 'treatment', label: 'טיפולים' }, { id: 'photo', label: 'צילומים' },
  { id: 'declaration', label: 'הצהרות' }, { id: 'appointment', label: 'תורים' }, { id: 'crm', label: 'CRM' },
];

export function ClientTimeline({ leadId, history, onDelete }: { leadId: string; history: LeadActivity[]; onDelete: (id: string) => void }) {
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [filter, setFilter] = useState<'all' | Kind>('all');

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch('/api/client-file/declarations', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
          body: JSON.stringify({ action: 'timeline', leadId }) });
        const j = r.ok ? await r.json() : null;
        if (live) setEvents(j?.events ?? null);   // no access / not installed: the CRM activities only
      } catch { if (live) setEvents(null); }
    };
    void load();
    const again = (e: Event) => { if ((e as CustomEvent<string>).detail === leadId) void load(); };
    window.addEventListener(CLIENT_FILE_CHANGED, again);
    return () => { live = false; window.removeEventListener(CLIENT_FILE_CHANGED, again); };
  }, [leadId, history.length]);

  type Row = { key: string; at: string; kind: Kind; icon: string; label: string; title: string; sub?: string; treatmentId?: string | null; activityId?: string };
  const rows = useMemo<Row[]>(() => {
    const crm: Row[] = history.map((a) => ({ key: `a-${a.id}`, at: a.at, kind: 'crm', icon: ACTIVITY_HE[a.kind].icon, label: ACTIVITY_HE[a.kind].label, title: a.body, activityId: a.id }));
    const file: Row[] = (events ?? []).map((e, i) => ({ key: `e-${i}-${e.at}`, at: e.at, kind: e.kind, icon: KIND[e.kind].icon, label: KIND[e.kind].label, title: e.title, sub: e.sub, treatmentId: e.treatmentId }));
    return [...crm, ...file].sort((a, b) => b.at.localeCompare(a.at));
  }, [history, events]);
  const shown = rows.filter((r) => filter === 'all' || r.kind === filter || (filter === 'treatment' && r.kind === 'session'));
  if (!rows.length) return null;

  return (
    <div className="mb-5">
      <p className="mb-2 text-sm font-semibold">היסטוריה</p>
      {events && (
        <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="סינון לפי סוג">
          {FILTERS.map((f) => <Chip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</Chip>)}
        </div>
      )}
      <ol className="grid max-h-72 gap-2 overflow-y-auto pe-1">
        {shown.map((r) => (
          <li key={r.key} className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
            <span aria-hidden>{r.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="text-xs text-muted">{r.label} · {formatIL(r.at)}</span>
              {r.title && <span className="block whitespace-pre-wrap" dir="auto">{r.title}</span>}
              {r.sub && <span className="block text-xs text-muted" dir="auto">{r.sub}</span>}
              {r.treatmentId && (
                <button type="button" className="text-xs font-semibold text-primary hover:underline"
                  onClick={() => document.getElementById(`cf-treatment-${r.treatmentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
                  לצילומי הטיפול ↑
                </button>
              )}
            </span>
            {r.activityId && <button type="button" onClick={() => onDelete(r.activityId!)} className="text-xs text-muted hover:text-(--danger)" aria-label="מחיקה">✕</button>}
          </li>
        ))}
        {!shown.length && <li className="text-xs text-muted">אין אירועים מהסוג הזה.</li>}
      </ol>
    </div>
  );
}
