'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Chip } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL, israelParts } from '@/lib/il-time';
import { authHeaders } from '@/lib/services/http';
import { useApp } from '@/lib/store';
import { waLink } from '@/features/crm/crm';
import { CLIENT_FILE_CHANGED } from './photos';
import { REQUEST_LABEL, declarationMessage, requestState, validOn, type RequestStatus } from './declarations';

/**
 * Health declarations in the client card (docs/CLIENT FILE ENGINEERING HE.md §5.2, 5.4): a badge at the top ("בתוקף
 * עד…" / "אין הצהרה בתוקף"), "📝 שלח הצהרת בריאות" with the approved declarations by treatment type (those of the
 * customer's open treatment pre-selected), the links sent (sent / opened / signed / expired, with "שלח שוב" and "בטל"),
 * and the signed declarations with "צפה ב-PDF" (the view is written in the log first).
 * Shown only to the owner and the practitioners the owner marked, and only once migration 4100 is in the database.
 */
interface Tpl { id: string; family_id: string; title: string; treatment_type_ids: string[]; version: number; status: string; valid_days: number | null }
interface Req { id: string; template_ids: string[]; status: RequestStatus; sent_at: string; opened_at: string | null; signed_at: string | null; expires_at: string }
interface Decl { id: string; template_id: string; template_version: number; signer_name: string; signed_at: string; valid_until: string | null; marketing_ok: boolean; flags: string[] }
interface Data { requests: Req[]; declarations: Decl[]; templates: Tpl[]; types: { id: string; name: string }[]; openTypes: string[]; business: string; owner?: boolean }

async function api<T>(body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; code: string; error: string }> {
  try {
    const r = await fetch('/api/client-file/declarations', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return r.ok ? { ok: true, data: j as T } : { ok: false, code: j?.code ?? 'error', error: j?.message ?? 'משהו השתבש — נסו שוב.' };
  } catch { return { ok: false, code: 'offline', error: 'אין חיבור כרגע.' }; }
}
const ddmmyyyy = (d: string) => d.split('-').reverse().join('/');

export function ClientDeclarations({ leadId }: { leadId: string }) {
  const addActivity = useApp((s) => s.addActivity);
  const [data, setData] = useState<Data | null>(null);
  const [hidden, setHidden] = useState(false);
  const [picking, setPicking] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; link?: string } | null>(null);
  const [purging, setPurging] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const load = useCallback(async () => {
    const r = await api<Data>({ action: 'lead', leadId });
    if (!r.ok) { if (['no_access', 'not_ready', 'no_session', 'no_business', 'business_locked'].includes(r.code)) setHidden(true); else setMsg({ text: r.error }); return; }
    setData(r.data);
  }, [leadId]);
  useEffect(() => { setData(null); setHidden(false); setPicking(null); setMsg(null); load(); }, [load]);

  const title = useMemo(() => new Map((data?.templates ?? []).map((t) => [t.id, t])), [data]);
  if (hidden || !data) return null;

  const today = israelParts(Date.now()).date;
  const valid = data.declarations.filter((d) => validOn(d.valid_until, today));
  const best = valid.some((d) => d.valid_until === null) ? null : valid.map((d) => d.valid_until!).sort().at(-1);
  const approved = data.templates.filter((t) => t.status === 'approved');
  // the picker's groups: each treatment type, then the general declarations
  const groups = [
    ...data.types.map((y) => ({ name: y.name, list: approved.filter((t) => t.treatment_type_ids.includes(y.id)) })),
    { name: 'כללית — לכל טיפול', list: approved.filter((t) => !t.treatment_type_ids.length) },
  ].filter((g) => g.list.length);
  const names = (ids: string[]) => ids.map((id) => title.get(id)?.title ?? 'הצהרה').join(' + ');

  /** the link goes out on WhatsApp — the window is opened in the tap itself (phones block one opened after a request) */
  async function send(body: Record<string, unknown>) {
    const phone = useApp.getState().leads.find((l) => l.id === leadId)?.phone ?? '';
    const win = waLink(phone) ? window.open('', '_blank') : null;
    setBusy(true); setMsg(null);
    const r = await api<{ token: string; request: Req; firstName: string; phone: string; business: string }>(body);
    setBusy(false);
    if (!r.ok) { win?.close(); setMsg({ text: r.error }); return; }
    const link = `${window.location.origin}/h/${r.data.token}`;
    const text = declarationMessage(r.data.business, r.data.firstName, link, r.data.request.template_ids.length);
    const url = waLink(r.data.phone, text);
    if (win && url) { win.location.href = url; setMsg({ text: 'נפתח וואטסאפ עם ההודעה והקישור.' }); }
    else { win?.close(); setMsg({ text: 'אין מספר וואטסאפ ללקוח/ה — העתיקו את הקישור ושלחו אותו בעצמכם:', link }); }
    addActivity(leadId, 'whatsapp', `נשלחה הצהרת בריאות: ${names(r.data.request.template_ids)}`);
    setPicking(null);
    await load();
  }
  async function openPdf(id: string) {
    const win = window.open('', '_blank');
    const r = await api<{ url: string }>({ action: 'open', declarationId: id });
    if (!r.ok || !win) { win?.close(); setMsg({ text: r.ok ? 'הדפדפן חסם את החלון החדש.' : r.error }); return; }
    win.location.href = r.data.url;
  }
  async function cancel(id: string) {
    if (!window.confirm('לבטל את הקישור? הלקוח/ה לא יוכלו לחתום עליו.')) return;
    const r = await api({ action: 'cancel', requestId: id });
    if (!r.ok) setMsg({ text: r.error });
    await load();
  }

  async function purge() {
    const name = useApp.getState().leads.find((l) => l.id === leadId)?.name ?? '';
    setBusy(true);
    try {
      const r = await fetch('/api/client-file/purge', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ leadId, confirmName: confirmName }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) { setMsg({ text: j?.message ?? 'המחיקה לא הצליחה — נסו שוב.' }); return; }
      setMsg({ text: `תיק הלקוח של ${name} נמחק: ${j.counts.photos} צילומים, ${j.counts.declarations} הצהרות, ${j.counts.treatments} טיפולים. המחיקה נרשמה ביומן, בלי התוכן.` });
      setConfirmName(''); setPurging(false);
      window.dispatchEvent(new CustomEvent(CLIENT_FILE_CHANGED, { detail: leadId }));
      const { userId, businessId, hydrate } = useApp.getState();
      if (userId) void hydrate(userId, businessId);   // the timeline note
      await load();
    } catch { setMsg({ text: 'אין חיבור כרגע.' }); } finally { setBusy(false); }
  }

  return (
    <div className="mb-4 rounded-2xl border border-line p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">📝 הצהרות בריאות</p>
        <span className={cx('rounded-full px-2.5 py-0.5 text-xs font-bold', valid.length ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>
          {valid.length ? (best ? `הצהרה בתוקף עד ${ddmmyyyy(best)}` : 'הצהרה בתוקף') : 'אין הצהרה בתוקף'}
        </span>
      </div>

      {picking === null ? (
        <Button size="sm" variant="primary" disabled={!approved.length}
          onClick={() => setPicking(approved.filter((t) => t.treatment_type_ids.some((y) => data.openTypes.includes(y))).map((t) => t.id))}>
          📝 שלח הצהרת בריאות
        </Button>
      ) : (
        <div className="rounded-xl bg-surface-2 p-3">
          <p className="mb-2 text-sm font-semibold">אילו הצהרות לשלוח? (אפשר כמה בקישור אחד)</p>
          {groups.map((g) => (
            <div key={g.name} className="mb-2">
              <p className="mb-1 text-xs font-semibold text-muted">{g.name}</p>
              <div className="flex flex-wrap gap-1.5">
                {g.list.map((t) => (
                  <Chip key={t.id} on={picking.includes(t.id)} onClick={() => setPicking(picking.includes(t.id) ? picking.filter((x) => x !== t.id) : [...picking, t.id])}>{t.title}</Chip>
                ))}
              </div>
            </div>
          ))}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={!picking.length || busy} onClick={() => send({ action: 'send', leadId, templateIds: picking })}>
              {busy ? <><Spinner />שולח…</> : 'שלח בוואטסאפ'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicking(null)}>ביטול</Button>
          </div>
        </div>
      )}
      {!approved.length && <p className="mt-1.5 text-xs text-muted">עוד אין הצהרה מאושרת. בונים ומאשרים אותה במסך "הצהרות בריאות".</p>}
      {msg && (
        <div className="mt-2 text-sm" role="status">
          <p>{msg.text}</p>
          {msg.link && <div className="mt-1 flex gap-2"><code className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1 text-xs" dir="ltr">{msg.link}</code>
            <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(msg.link!)}>העתקה</Button></div>}
        </div>
      )}

      {data.declarations.length > 0 && (
        <ul className="mt-3 grid gap-2">
          {data.declarations.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{title.get(d.template_id)?.title ?? 'הצהרה'} · גרסה {d.template_version}</span>
                <span className="block text-xs text-muted">
                  נחתמה {formatIL(d.signed_at)} · {d.valid_until ? (validOn(d.valid_until, today) ? `בתוקף עד ${ddmmyyyy(d.valid_until)}` : `פגה ב-${ddmmyyyy(d.valid_until)}`) : 'בלי הגבלת תוקף'}
                  {d.marketing_ok ? ' · הסכים/ה לשימוש בתמונות לפרסום' : ''}
                </span>
                {d.flags?.length > 0 && (
                  <span className="mt-1 block rounded-lg bg-amber-500/15 px-2 py-1 text-xs font-semibold text-amber-800 dark:text-amber-200">
                    ⚠️ לתשומת לב — "כן" בהתווית נגד: {d.flags.join(' · ')}
                  </span>
                )}
              </span>
              <Button size="sm" variant="ghost" onClick={() => openPdf(d.id)}>צפה ב-PDF</Button>
            </li>
          ))}
        </ul>
      )}

      {data.requests.filter((r) => r.status !== 'signed').length > 0 && (
        <ul className="mt-3 grid gap-2">
          {data.requests.filter((r) => r.status !== 'signed').slice(0, 5).map((r) => {
            const st = requestState(r);
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-surface-2 px-2 py-0.5 font-semibold">{REQUEST_LABEL[st]}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{names(r.template_ids)} · נשלח {formatIL(r.sent_at, { dateStyle: 'short' })}</span>
                <button type="button" className="font-semibold text-primary hover:underline" disabled={busy} onClick={() => send({ action: 'resend', requestId: r.id })}>שלח שוב</button>
                {(st === 'sent' || st === 'opened') && <button type="button" className="text-muted hover:text-(--danger)" onClick={() => cancel(r.id)}>בטל</button>}
              </li>
            );
          })}
        </ul>
      )}
      {data.owner && (
        <div className="mt-4 border-t border-line pt-3">
          {!purging ? (
            <button type="button" className="text-xs text-(--danger) hover:underline" onClick={() => setPurging(true)}>🗑️ מחיקת תיק הלקוח (לבקשת הלקוח/ה)…</button>
          ) : (
            <div className="rounded-xl bg-red-500/10 p-3 text-sm">
              <p className="mb-2 font-semibold">כל הצילומים, הטיפולים וההצהרות החתומות של הלקוח/ה יימחקו לצמיתות, כולל הקבצים. אי אפשר לשחזר.</p>
              <p className="mb-2 text-xs text-muted">המחיקה נרשמת ביומן (מי ומתי), בלי התוכן. פרטי הקשר וההיסטוריה בכרטיס נשארים.</p>
              <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder="הקלידו את שם הלקוח/ה לאישור"
                className="mb-2 w-full rounded-xl border border-line bg-surface px-3 py-2" aria-label="שם הלקוח/ה לאישור המחיקה" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" className="bg-red-600 shadow-none" disabled={busy || !confirmName.trim()} onClick={purge}>{busy ? <><Spinner />מוחק…</> : 'מחיקה לצמיתות'}</Button>
                <Button size="sm" variant="ghost" onClick={() => { setPurging(false); setConfirmName(''); }}>ביטול</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
