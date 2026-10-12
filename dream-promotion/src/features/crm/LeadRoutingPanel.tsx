'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import { Button, SmallSelect } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import type { Lead } from '@/types';
import { NO_DEPARTMENT, WA_NOT_CONNECTED, noticeLine, type NoticeView } from './lead-routing';
import { loadCard, patchLeadRouting, postAssignment, useLeadRouting, type CardRouting } from './lead-routing-data';

const TONE = { ok: 'text-(--ok,#16a34a)', wait: 'text-ink-2', bad: 'text-(--danger)', off: 'text-muted' } as const;

/**
 * The contact card's department, person and WhatsApp messages (2.99): which department, who is responsible ("אחראי"), why
 * (the form / the campaign / the question), when the message went out — or why not, with Meta's code. The owner moves the lead
 * to another person (and may send it to them on WhatsApp), and sends again a message that failed or was skipped.
 * Shown only in a business that uses departments (a team, or a contact that was routed).
 */
export function LeadRoutingPanel({ lead }: { lead: Lead }) {
  const { view } = useLeadRouting();
  const ids = useId();
  const [card, setCard] = useState<CardRouting | null>(null);
  const [to, setTo] = useState('');
  const [send, setSend] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const uses = Boolean(view && (view.staff.length || lead.routedAt || lead.assignedStaffId));

  const load = useCallback(async () => {
    const r = await loadCard(lead.id);
    if (r.ok && r.body?.ready) { setCard(r.body); patchLeadRouting(r.body.lead); }
  }, [lead.id]);
  useEffect(() => {
    setCard(null); setMsg(null); setTo(''); setSend(true);
    if (uses) void load();
  }, [lead.id, uses, load]);

  if (!view || !uses) return null;
  const staffName = (id: string | null | undefined) => view.staff.find((s) => s.id === id)?.name ?? '';
  const dept = view.departments.find((d) => d.id === lead.departmentId);
  const active = view.staff.filter((s) => s.active);
  const notices = card?.notifications ?? [];

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key); setMsg(null);
    const r = await postAssignment(body);
    setBusy(null);
    if (!r.ok) { setMsg({ ok: false, text: r.body?.message ?? 'הפעולה לא הצליחה.' }); return; }
    if (r.body?.lead) { setCard(r.body); patchLeadRouting(r.body.lead); }
    const sent = r.body?.sent;
    if (sent?.status === 'sent') setMsg({ ok: true, text: 'נשלח בוואטסאפ ✓' });
    else if (sent?.status === 'failed') setMsg({ ok: false, text: `לא נשלח — קוד ${sent.code}` });
    else if (sent?.message) setMsg({ ok: false, text: sent.message });
    else setMsg({ ok: true, text: 'נשמר ✓' });
  }

  return (
    <section aria-label="מחלקה ואחראי" className="mb-4 rounded-2xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-semibold">🏷️ {dept ? `מחלקה: ${dept.name}${dept.active ? '' : ' (הוסרה)'}` : lead.routedAt ? NO_DEPARTMENT : 'מחלקה: —'}</span>
        <span className="font-semibold">👤 אחראי: {staffName(lead.assignedStaffId) || '—'}</span>
      </div>
      {lead.routedBy && <p className="mt-0.5 text-xs text-muted" dir="auto">לפי {lead.routedBy}</p>}

      {notices.length > 0 && (
        <ul className="mt-2 grid gap-1.5">
          {notices.map((n: NoticeView) => {
            const line = noticeLine(n);
            return (
              <li key={n.id} className="text-sm">
                <span className={cx('font-semibold', TONE[line.tone])}>{line.text}</span>
                {line.hint && <span className="block text-xs text-ink-2">{line.hint}</span>}
                {n.error?.message && n.status === 'failed' && <span className="block text-xs text-muted" dir="ltr">{n.error.message}{n.error.fbtrace ? ` · fbtrace ${n.error.fbtrace}` : ''}</span>}
                {view.owner && line.resend && (
                  <button type="button" disabled={Boolean(busy) || !view.connected} onClick={() => act(n.id, { action: 'resend', id: n.id })}
                    className="min-h-9 text-xs font-semibold text-primary underline disabled:text-muted disabled:no-underline">
                    {busy === n.id ? 'בשליחה…' : n.status === 'failed' ? 'לשלוח שוב' : 'לשלוח עכשיו'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!view.connected && notices.length === 0 && <p className="mt-1 text-xs text-muted">{WA_NOT_CONNECTED} — הלידים משויכים, אבל הודעות לא נשלחות.</p>}

      {view.owner && active.length > 0 && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <div className="grid min-w-0 gap-1">
            <label htmlFor={`${ids}-to`} className="text-xs font-semibold text-ink-2">העברה לאחראי אחר</label>
            <SmallSelect id={`${ids}-to`} value={to} onChange={(e) => setTo(e.target.value)} className="w-48">
              <option value="">בחירה…</option>
              {active.filter((s) => s.id !== lead.assignedStaffId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              {lead.assignedStaffId && <option value="none">בלי אחראי</option>}
            </SmallSelect>
          </div>
          {to && to !== 'none' && (
            <label className="flex min-h-10 items-center gap-1.5 text-sm">
              <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} className="h-4 w-4" />
              לשלוח את הליד בוואטסאפ
            </label>
          )}
          <Button size="sm" variant="primary" disabled={!to || Boolean(busy)}
            onClick={() => act('assign', { action: 'assign', leadId: lead.id, staffId: to === 'none' ? null : to, send: to !== 'none' && send })}>
            {busy === 'assign' ? <><Spinner />בהעברה…</> : 'העברה'}
          </Button>
        </div>
      )}
      {msg && <p role="status" className={cx('mt-2 text-sm font-semibold', msg.ok ? 'text-(--ok,#16a34a)' : 'text-warn')}>{msg.text}</p>}
    </section>
  );
}
