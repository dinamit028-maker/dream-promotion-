'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import { Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { formatIL, israelParts } from '@/lib/il-time';
import {
  deductibleFor, ddmmyyyy, packageError, packageLine, packagesFor, type ClientPackage, type PackageUse,
} from '@/features/finance/packages';
import { deduct, giveBack, loadPackages, loadTreatmentTypes, loadUses, packagesChanged, PACKAGES_CHANGED, type TreatmentType } from '@/features/finance/packages-data';
import { CLIENT_FILE_CHANGED, type TreatmentRow } from './photos';
import { MAX_SESSION_NOTES, SESSION_COLUMNS, activeUseOf, sessionAt, sessionsOf, toSession, type SessionRow } from './sessions';

/**
 * "טיפולים שבוצעו" in the client card (docs/FINANCE_ADDITIONS_HE.md, T1, on the client file of 4100) — for the owner and the
 * practitioners the owner marked (client_files_allowed(); nobody else sees anything here). "+ רישום טיפול שבוצע" records a
 * session of one of the customer's treatments, and when a package of the customer fits it (same type, or any; active, valid,
 * with treatments left) the screen offers to take it from that package — preselected, "בלי ניכוי" is one tap. The session and
 * its deduction are one step in the database (client_session_add): a refusal leaves nothing. A session is never deleted:
 * "ביטול" is final and gives its treatment back to the package (the database, in the same statement).
 * Shown only once migration 20261010004200 is in the database.
 */
const apiTreatment = async (leadId: string, title: string, typeId: string | null): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
  try {
    const r = await fetch('/api/client-file/photos', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ action: 'treatment', leadId, title, treatmentTypeId: typeId }) });
    const j = await r.json().catch(() => null);
    return r.ok && j?.treatment?.id ? { ok: true, id: String(j.treatment.id) } : { ok: false, error: j?.message ?? 'הטיפול לא נשמר — נסו שוב.' };
  } catch { return { ok: false, error: 'אין חיבור כרגע.' }; }
};
const changedFile = (leadId: string) => {
  packagesChanged(leadId);
  window.dispatchEvent(new CustomEvent<string>(CLIENT_FILE_CHANGED, { detail: leadId }));
};

export function ClientSessions({ leadId }: { leadId: string }) {
  const userId = useApp((s) => s.userId);
  const [shown, setShown] = useState<'loading' | 'hidden' | 'ready'>('loading');
  const [treatments, setTreatments] = useState<TreatmentRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [types, setTypes] = useState<TreatmentType[]>([]);
  const [packages, setPackages] = useState<ClientPackage[]>([]);
  const [uses, setUses] = useState<PackageUse[]>([]);
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'cancel' | 'deduct' | 'undo'; session: SessionRow } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = supabase();
    const allowed = await sb.rpc('client_files_allowed');
    if (allowed.error || allowed.data !== true) { setShown('hidden'); return; }
    const [t, s, y, p] = await Promise.all([
      sb.from('client_treatments').select('id, lead_id, title, area, started_at, status, treatment_type_id').eq('lead_id', leadId).order('started_at', { ascending: false }),
      sb.from('client_sessions').select(SESSION_COLUMNS).eq('lead_id', leadId).order('at', { ascending: false }).limit(300),
      loadTreatmentTypes(),
      loadPackages(leadId),
    ]);
    // the client file or migration 4200 is not in this database: nothing is shown (the card works as before)
    if (t.error || s.error || (!p.ok && p.missing)) { setShown('hidden'); return; }
    const pk = p.ok ? p.data : [];
    const u = await loadUses(pk.map((x) => x.id));
    setTreatments((t.data ?? []) as TreatmentRow[]);
    setSessions(((s.data ?? []) as any[]).map(toSession));
    setTypes(y); setPackages(pk); setUses(u.ok ? u.data : []);
    setShown('ready');
  }, [leadId]);
  useEffect(() => { setShown('loading'); setDialog(null); void load(); }, [load]);
  useEffect(() => {
    const again = (e: Event) => { if ((e as CustomEvent<string>).detail === leadId) void load(); };
    window.addEventListener(PACKAGES_CHANGED, again);
    window.addEventListener(CLIENT_FILE_CHANGED, again);
    return () => { window.removeEventListener(PACKAGES_CHANGED, again); window.removeEventListener(CLIENT_FILE_CHANGED, again); };
  }, [leadId, load]);
  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash((x) => (x === m ? null : x)), 4000); };

  const pkgName = useMemo(() => new Map(packages.map((p) => [p.id, p.name])), [packages]);
  const typeOf = (treatmentId: string) => treatments.find((t) => t.id === treatmentId)?.treatment_type_id ?? null;
  const typeName = (id: string | null) => types.find((t) => t.id === id)?.name ?? null;
  if (shown !== 'ready') return null;

  const today = israelParts(Date.now()).date;
  const withSessions = treatments.filter((t) => sessions.some((s) => s.treatmentId === t.id));
  const activePackages = packages.filter((p) => p.status === 'active' && p.remaining > 0);
  return (
    <div className="mb-4 rounded-2xl border border-line p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold">🩺 טיפולים שבוצעו</p>
        <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'add' })}>+ רישום טיפול שבוצע</Button>
      </div>
      {activePackages.length > 0 && (
        <p className="mb-2 text-xs text-muted">חבילה פעילה: {activePackages.map((p) => `${p.name} — ${packageLine(p, today)}`).join(' · ')}</p>
      )}
      {flash && <p role="status" className="mb-2 rounded-xl bg-emerald-500/15 px-3 py-2 text-sm font-semibold">✓ {flash}</p>}
      {!withSessions.length ? <p className="text-xs text-muted">עוד לא נרשמו טיפולים שבוצעו. כל טיפול שנרשם נכנס לתיק הלקוח, ואפשר לנכות אותו מחבילה.</p> : (
        <div className="grid gap-2">
          {withSessions.map((t) => (
            <div key={t.id}>
              <p className="text-xs font-semibold text-ink-2">{[t.title || 'טיפול', t.area, typeName(t.treatment_type_id)].filter(Boolean).join(' · ')}</p>
              <ul className="mt-1 grid gap-1">
                {sessionsOf(sessions, t.id).map((s) => {
                  const use = activeUseOf(s.id, uses);
                  const options = deductibleFor(packages, t.treatment_type_id);
                  return (
                    <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                      <span className={s.cancelledAt ? 'text-muted line-through' : ''}>{formatIL(s.at, { dateStyle: 'short' })}</span>
                      {s.notes && <span className="min-w-0 flex-1 truncate text-xs text-muted" dir="auto">{s.notes}</span>}
                      {s.cancelledAt ? <span className="text-xs text-muted">בוטל{s.cancelReason ? `: ${s.cancelReason}` : ''}</span>
                        : use ? <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">נוכה מ&quot;{pkgName.get(use.packageId) ?? 'חבילה'}&quot;</span> : null}
                      {!s.cancelledAt && (
                        <span className="ms-auto flex gap-2">
                          {use ? <button type="button" className="text-xs text-muted hover:text-primary" onClick={() => setDialog({ kind: 'undo', session: s })}>ביטול הניכוי</button>
                            : options.length > 0 && <button type="button" className="text-xs font-semibold text-primary" onClick={() => setDialog({ kind: 'deduct', session: s })}>ניכוי מחבילה</button>}
                          <button type="button" className="text-xs text-muted hover:text-(--danger)" onClick={() => setDialog({ kind: 'cancel', session: s })}>ביטול הטיפול</button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {dialog?.kind === 'add' && <AddSession leadId={leadId} treatments={treatments} types={types} packages={packages} onClose={() => setDialog(null)}
        onDone={(m) => { setDialog(null); say(m); changedFile(leadId); }} />}
      {dialog?.kind === 'cancel' && <CancelSession session={dialog.session} use={activeUseOf(dialog.session.id, uses)} pkgName={pkgName} onClose={() => setDialog(null)}
        onDone={(m) => { setDialog(null); say(m); changedFile(leadId); }} />}
      {dialog?.kind === 'deduct' && userId && <DeductSession session={dialog.session} leadId={leadId} userId={userId}
        options={deductibleFor(packages, typeOf(dialog.session.treatmentId))} offered={packagesFor(packages, typeOf(dialog.session.treatmentId), israelParts(new Date(dialog.session.at)).date)}
        onClose={() => setDialog(null)} onDone={(m) => { setDialog(null); say(m); changedFile(leadId); }} />}
      {dialog?.kind === 'undo' && (() => {
        const use = activeUseOf(dialog.session.id, uses);
        return use ? <UndoDeduction use={use} name={pkgName.get(use.packageId) ?? 'החבילה'} onClose={() => setDialog(null)}
          onDone={(m) => { setDialog(null); say(m); changedFile(leadId); }} /> : null;
      })()}
    </div>
  );
}

/** a package to take the session from: the offered ones first (the first is chosen), an expired one only on purpose */
function PackagePick({ offered, others, value, onChange, today }: {
  offered: ClientPackage[]; others: ClientPackage[]; value: string; onChange: (id: string) => void; today: string;
}) {
  if (!offered.length && !others.length) return null;
  const row = (p: ClientPackage, warn?: string) => (
    <label key={p.id} className="flex min-h-11 items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
      <input type="radio" name="pkg" checked={value === p.id} onChange={() => onChange(p.id)} className="h-5 w-5" />
      <span className="min-w-0 flex-1"><strong>לנכות מהחבילה &quot;{p.name}&quot;</strong>
        <span className="block text-xs text-muted">{packageLine(p, today)}</span>
        {warn && <span className="block text-xs font-semibold text-amber-700 dark:text-amber-300">{warn}</span>}</span>
    </label>
  );
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1 text-sm font-bold">חבילה</legend>
      {offered.map((p) => row(p))}
      {others.map((p) => row(p, `⚠️ התוקף פג ב-${ddmmyyyy(p.validUntil)} — לנכות בכל זאת?`))}
      <label className="flex min-h-11 items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
        <input type="radio" name="pkg" checked={value === ''} onChange={() => onChange('')} className="h-5 w-5" />
        <span>בלי ניכוי מחבילה</span>
      </label>
    </fieldset>
  );
}

function AddSession({ leadId, treatments, types, packages, onClose, onDone }: {
  leadId: string; treatments: TreatmentRow[]; types: TreatmentType[]; packages: ClientPackage[]; onClose: () => void; onDone: (message: string) => void;
}) {
  const today = israelParts(Date.now()).date;
  const open = treatments.filter((t) => t.status === 'active');
  const [treatment, setTreatment] = useState<string>(open[0]?.id ?? treatments[0]?.id ?? '+');
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState('');
  const [day, setDay] = useState(today);
  const [notes, setNotes] = useState('');
  const [created, setCreated] = useState<{ id: string; typeId: string | null } | null>(null);
  // the session's id, fixed when the dialog opens: a retry after an answer lost on the way back is the same session
  const [sessionId] = useState(() => crypto.randomUUID());
  const typeId = treatment === '+' ? (created?.typeId ?? (newType || null)) : treatments.find((t) => t.id === treatment)?.treatment_type_id ?? null;
  const offered = useMemo(() => packagesFor(packages, typeId, day), [packages, typeId, day]);
  const others = useMemo(() => deductibleFor(packages, typeId).filter((p) => !offered.includes(p)), [packages, typeId, offered]);
  const [pkg, setPkg] = useState<string>('');
  const [picked, setPicked] = useState(false);
  // the system offers: the first fitting package is chosen — until the user picks
  useEffect(() => { if (!picked) setPkg(offered[0]?.id ?? ''); }, [offered, picked]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      let tid = treatment;
      if (treatment === '+') {
        if (created) tid = created.id;
        else {
          if (!newTitle.trim()) { setError('תנו שם לטיפול (למשל: הסרת שיער · רגליים).'); return; }
          const r = await apiTreatment(leadId, newTitle.trim(), newType || null);
          if (!r.ok) { setError(r.error); return; }
          setCreated({ id: r.id, typeId: newType || null }); tid = r.id;   // a retry does not create it twice
        }
      }
      const { error: e } = await supabase().rpc('client_session_add', {
        p_lead: leadId, p_treatment: tid, p_at: sessionAt(day), p_notes: notes.trim().slice(0, MAX_SESSION_NOTES), p_package: pkg || null, p_id: sessionId,
      });
      // a press that raced another one of this dialog: the session with this id is already saved
      if (e && !/client_sessions_pkey/.test(`${e.message} ${e.details ?? ''}`)) { setError(packageError(e)); return; }
      // what was saved, not what is picked now (a retry of a saved session does not change it)
      const { data: use } = await supabase().from('client_package_uses').select('package_id').eq('session_id', sessionId).is('returned_at', null).maybeSingle();
      const name = packages.find((p) => p.id === use?.package_id)?.name;
      onDone(name ? `הטיפול נרשם ונוכה מהחבילה "${name}"` : 'הטיפול נרשם');
    } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="font-display text-lg font-extrabold">רישום טיפול שבוצע</h3>
        <CloseButton onClick={onClose} />
      </div>
      <div className="grid gap-3">
        <Field label="טיפול">
          <Select value={treatment} disabled={Boolean(created)} onChange={(e) => { setTreatment(e.target.value); setPicked(false); }}>
            {treatments.map((t) => <option key={t.id} value={t.id}>{[t.title || 'טיפול', t.area].filter(Boolean).join(' · ')}{t.status === 'active' ? '' : ' (לא פעיל)'}</option>)}
            <option value="+">+ טיפול חדש</option>
          </Select>
        </Field>
        {treatment === '+' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Input value={newTitle} disabled={Boolean(created)} maxLength={200} onChange={(e) => setNewTitle(e.target.value)} placeholder="שם הטיפול (למשל הסרת שיער · רגליים)" aria-label="שם הטיפול" />
            <Select value={newType} disabled={Boolean(created)} onChange={(e) => { setNewType(e.target.value); setPicked(false); }} aria-label="סוג הטיפול">
              <option value="">בלי סוג</option>
              {types.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </div>
        )}
        <Field label="תאריך"><Input type="date" value={day} max={today} onChange={(e) => { setDay(e.target.value || today); setPicked(false); }} className="w-44" /></Field>
        <Field label="הערות (לא חובה)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={MAX_SESSION_NOTES} className="min-h-16" placeholder="אזור, פרמטרים, איך הלך" /></Field>
        <PackagePick offered={offered} others={others} value={pkg} onChange={(id) => { setPkg(id); setPicked(true); }} today={today} />
        {error && <p role="alert" className="text-sm text-(--danger)">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : pkg ? 'רישום וניכוי מהחבילה' : 'רישום הטיפול'}</Button>
          <Button variant="ghost" onClick={onClose}>ביטול</Button>
        </div>
      </div>
    </Modal>
  );
}

function CancelSession({ session, use, pkgName, onClose, onDone }: {
  session: SessionRow; use: PackageUse | null; pkgName: Map<string, string>; onClose: () => void; onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true); setError(null);
    const { data, error: e } = await supabase().from('client_sessions').update({ cancelled_at: new Date().toISOString(), cancel_reason: reason.trim().slice(0, 300) })
      .eq('id', session.id).is('cancelled_at', null).select('id');
    setBusy(false);
    if (e) { setError(packageError(e)); return; }
    if (!(data ?? []).length) { setError('הטיפול כבר בוטל, או שאין הרשאה.'); return; }
    onDone(use ? `הטיפול בוטל, וחזר לחבילה "${pkgName.get(use.packageId) ?? ''}"` : 'הטיפול בוטל');
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">ביטול הטיפול מ-{formatIL(session.at, { dateStyle: 'short' })}</h3>
      <p className="mb-3 text-sm text-muted">הטיפול נשאר בתיק ומסומן &quot;בוטל&quot; — לא נמחק, ואי אפשר להחזיר אותו.{use ? ` הוא חוזר לחבילה "${pkgName.get(use.packageId) ?? ''}".` : ''}</p>
      <Field label="סיבה (לא חובה)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="למשל: לא הגיעה, נרשם בטעות" /></Field>
      {error && <p role="alert" className="text-sm text-(--danger)">{error}</p>}
      <div className="mt-3 flex gap-2"><Button variant="primary" disabled={busy} onClick={() => void go()}>ביטול הטיפול</Button><Button variant="ghost" onClick={onClose}>חזרה</Button></div>
    </Modal>
  );
}

function DeductSession({ session, leadId, userId, options, offered, onClose, onDone }: {
  session: SessionRow; leadId: string; userId: string; options: ClientPackage[]; offered: ClientPackage[]; onClose: () => void; onDone: (message: string) => void;
}) {
  const today = israelParts(Date.now()).date;
  const others = options.filter((p) => !offered.includes(p));
  const [pkg, setPkg] = useState(offered[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    if (!pkg) { onClose(); return; }
    setBusy(true); setError(null);
    const r = await deduct({ packageId: pkg, leadId, sessionId: session.id, userId });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onDone(`נוכה מהחבילה "${options.find((p) => p.id === pkg)?.name ?? ''}"`);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-3 font-display text-lg font-extrabold">ניכוי הטיפול מ-{formatIL(session.at, { dateStyle: 'short' })} מחבילה</h3>
      <PackagePick offered={offered} others={others} value={pkg} onChange={setPkg} today={today} />
      {error && <p role="alert" className="mt-2 text-sm text-(--danger)">{error}</p>}
      <div className="mt-3 flex gap-2"><Button variant="primary" disabled={busy || !pkg} onClick={() => void go()}>ניכוי</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}

function UndoDeduction({ use, name, onClose, onDone }: { use: PackageUse; name: string; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true); setError(null);
    const r = await giveBack(use.id, 'הניכוי בוטל מהכרטיס');
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onDone(`הטיפול חזר לחבילה "${name}"`);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">ביטול הניכוי מ&quot;{name}&quot;</h3>
      <p className="mb-3 text-sm text-muted">הטיפול שבוצע נשאר בתיק — רק הניכוי מהחבילה מתבטל, והטיפול חוזר אליה.</p>
      {error && <p role="alert" className="text-sm text-(--danger)">{error}</p>}
      <div className="mt-3 flex gap-2"><Button variant="primary" disabled={busy} onClick={() => void go()}>ביטול הניכוי</Button><Button variant="ghost" onClick={onClose}>חזרה</Button></div>
    </Modal>
  );
}
