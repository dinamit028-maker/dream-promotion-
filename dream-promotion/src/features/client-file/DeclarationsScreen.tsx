'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Chip, Field as FieldBox, Input, PageHead, Select, Textarea } from '@/components/ui/primitives';
import { CloseButton, EmptyState, Modal, Spinner } from '@/components/ui/feedback';
import { ClipboardText } from '@/components/ui/Icon';
import { formatIL } from '@/lib/il-time';
import { authHeaders } from '@/lib/services/http';
import {
  CONFIRM_LINE, FIELD_TYPES, FOLLOW_UP_TYPES, MARKETING_LABEL, STATUS_LABEL, canApprove, cleanAcks, cleanFields, isTextOnly, newKey,
  type Answers, type Field, type FieldType, type FollowUp, type TemplateStatus,
} from './declarations';
import { Question } from './DeclarationForm';

/**
 * "הצהרות בריאות" (docs/CLIENT FILE ENGINEERING HE.md §5.1): every declaration of the business, by status and treatment
 * type. Built once, by the clinic — no ready-made wording. A draft is edited freely; "אישור" (the owner only) shows the
 * declaration exactly as the customer will, and asks to tick "הנוסח נבדק ומאושר לשימוש"; from then it can be sent from
 * every client card. Editing an approved declaration makes a new version (a draft) — the approved one is still sent
 * until the new one is approved. Archive instead of delete.
 */
interface Template {
  id: string; family_id: string; title: string; treatment_type_ids: string[]; version: number; status: TemplateStatus;
  fields: Field[]; acks: string[]; valid_days: number | null; created_at: string; approved_at: string | null; archived_at: string | null;
}
interface TType { id: string; name: string; active: boolean }
type Draft = { id?: string; familyOf?: string; title: string; typeIds: string[]; validDays: string; fields: Field[]; acks: string[] };

async function api<T>(body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; code: string; error: string }> {
  try {
    const r = await fetch('/api/client-file/declarations', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return r.ok ? { ok: true, data: j as T } : { ok: false, code: j?.code ?? 'error', error: j?.message ?? 'משהו השתבש — נסו שוב.' };
  } catch { return { ok: false, code: 'offline', error: 'אין חיבור כרגע.' }; }
}

export function DeclarationsScreen() {
  const [state, setState] = useState<'loading' | 'ready' | { message: string }>('loading');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [types, setTypes] = useState<TType[]>([]);
  const [owner, setOwner] = useState(false);
  const [newType, setNewType] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<{ t: Template; approve: boolean } | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ templates: Template[]; types: TType[]; owner: boolean }>({ action: 'templates' });
    if (!r.ok) { setState({ message: r.error }); return; }
    setTemplates(r.data.templates); setTypes(r.data.types); setOwner(r.data.owner); setState('ready');
  }, []);
  useEffect(() => { load(); }, [load]);

  const typeName = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);
  const typesOf = (t: { treatment_type_ids: string[] }) => (t.treatment_type_ids.length ? t.treatment_type_ids.map((id) => typeName.get(id) ?? '—').join(', ') : 'כללית — לכל טיפול');

  async function addType() {
    const r = await api<{ type: TType }>({ action: 'type-add', name: newType });
    if (!r.ok) { setMsg(r.error); return; }
    setTypes((ts) => [...ts, r.data.type]); setNewType(''); setMsg('');
  }
  async function act(body: Record<string, unknown>, done?: string) {
    const r = await api<{ template?: Template }>(body);
    if (!r.ok) { setMsg(r.error); return false; }
    setMsg(done ?? ''); await load(); return true;
  }

  if (state === 'loading') return <div className="flex justify-center py-16"><Spinner /></div>;
  if (typeof state === 'object') {
    return (<><PageHead title="הצהרות בריאות" /><EmptyState icon={<ClipboardText size={28} aria-hidden />} title="האזור לא זמין" body={state.message} /></>);
  }

  const by = (s: TemplateStatus) => templates.filter((t) => t.status === s).sort((a, b) => a.title.localeCompare(b.title, 'he') || b.version - a.version);
  const hasDraft = (family: string) => templates.some((t) => t.family_id === family && t.status === 'draft');

  return (
    <div>
      <PageHead title="הצהרות בריאות" sub="ההצהרות של הקליניקה, לכל סוג טיפול. רק הצהרה מאושרת נשלחת ללקוחות."
        action={<div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center rounded-full border border-line bg-surface px-4 py-2 text-sm font-semibold hover:bg-surface-2">
            ייבוא טיוטה מקובץ
            <input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => {
              const file = e.target.files?.[0]; e.target.value = '';
              if (!file) return;
              const r = await importDraft(file, types);
              if (!r.ok) { setMsg(r.error); return; }
              setMsg(r.note); setDraft(r.draft);
            }} />
          </label>
          <Button variant="primary" onClick={() => setDraft({ title: '', typeIds: [], validDays: '365', fields: [], acks: [] })}>+ הצהרה חדשה</Button>
        </div>} />
      {msg && <p className="mb-4 rounded-xl bg-primary-soft p-3 text-sm" role="status">{msg}</p>}

      <Card className="mb-6 p-4">
        <p className="mb-2 text-sm font-semibold">סוגי טיפול של הקליניקה</p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {types.length ? types.map((t) => <span key={t.id} className="rounded-full bg-surface-2 px-3 py-1 text-sm">{t.name}</span>) : <span className="text-sm text-muted">עוד אין. לדוגמה: לייזר, מיצוק, מיקרובליידינג, קרבון.</span>}
        </div>
        <div className="flex gap-2">
          <Input value={newType} onChange={(e) => setNewType(e.target.value)} placeholder="סוג טיפול חדש" aria-label="סוג טיפול חדש" className="h-9 py-1"
            onKeyDown={(e) => { if (e.key === 'Enter' && newType.trim()) addType(); }} />
          <Button size="sm" onClick={addType} disabled={!newType.trim()}>הוספה</Button>
        </div>
      </Card>

      {!templates.length && (
        <EmptyState icon={<ClipboardText size={28} aria-hidden />} title="עוד אין הצהרות"
          body="בונים כל הצהרה פעם אחת, בנוסח של הקליניקה (כפי שנבדק אצל עורך הדין שלה). אין כאן נוסח מוכן — הנוסח שלכם." />
      )}

      {(['draft', 'approved', 'archived'] as TemplateStatus[]).map((s) => {
        const list = by(s);
        if (!list.length) return null;
        return (
          <section key={s} className="mb-6">
            <h3 className="mb-2 text-sm font-bold text-ink-2">{s === 'draft' ? 'טיוטות — עוד לא נשלחות' : s === 'approved' ? 'מאושרות — זמינות בכל כרטיס לקוח' : 'בארכיון'}</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {list.map((t) => (
                <Card key={t.id} className="p-4">
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <p className="font-semibold">{t.title}</p>
                    <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs">{STATUS_LABEL[t.status]} · גרסה {t.version}</span>
                  </div>
                  <p className="text-xs text-muted">{typesOf(t)} · {t.fields.filter((f) => !isTextOnly(f.type)).length} שאלות · {t.acks.length} אישורים · {t.valid_days ? `תוקף ${t.valid_days} ימים` : 'בלי הגבלת תוקף'}</p>
                  {t.approved_at && <p className="text-xs text-muted">אושרה {formatIL(t.approved_at, { dateStyle: 'short' })}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {s === 'draft' && <>
                      <Button size="sm" onClick={() => setDraft(toDraft(t, { id: t.id }))}>עריכה</Button>
                      {owner
                        ? <Button size="sm" variant="primary" onClick={() => setPreview({ t, approve: true })} disabled={!canApprove(t.fields, t.acks)}>אישור…</Button>
                        : <span className="self-center text-xs text-muted">רק בעל/ת העסק מאשר/ת</span>}
                      <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('למחוק את הטיוטה?')) act({ action: 'template-delete', id: t.id }, 'הטיוטה נמחקה.'); }}>מחיקה</Button>
                    </>}
                    {s === 'approved' && <>
                      <Button size="sm" variant="ghost" onClick={() => setPreview({ t, approve: false })}>תצוגה</Button>
                      <Button size="sm" onClick={() => setDraft(toDraft(t, { familyOf: t.id }))} disabled={hasDraft(t.family_id)}
                        title={hasDraft(t.family_id) ? 'כבר יש טיוטה של ההצהרה הזו' : undefined}>עריכה (גרסה חדשה)</Button>
                      {owner && <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('להעביר לארכיון? היא לא תישלח יותר, וההצהרות שכבר נחתמו נשמרות.')) act({ action: 'template-archive', id: t.id }, 'ההצהרה הועברה לארכיון.'); }}>ארכיון</Button>}
                    </>}
                    {s === 'archived' && <Button size="sm" variant="ghost" onClick={() => setPreview({ t, approve: false })}>תצוגה</Button>}
                  </div>
                </Card>
              ))}
            </div>
          </section>
        );
      })}

      {draft && <Editor draft={draft} types={types} onClose={() => setDraft(null)} onSaved={async (m) => { setDraft(null); setMsg(m); await load(); }} />}
      {preview && <Preview t={preview.t} approve={preview.approve} typesLine={typesOf(preview.t)} onClose={() => setPreview(null)}
        onApprove={async () => { if (await act({ action: 'template-approve', id: preview.t.id, confirmed: true }, `"${preview.t.title}" אושרה — מעכשיו אפשר לשלוח אותה מכל כרטיס לקוח.`)) setPreview(null); }} />}
    </div>
  );
}

/**
 * A draft prepared from the clinic's own form (a .json file: { title, treatmentTypes?: [names], validDays?, fields, acks }).
 * It opens in the editor as a NEW draft — nothing is saved until the owner reviews it against the original and saves it.
 */
async function importDraft(file: File, types: TType[]): Promise<{ ok: true; draft: Draft; note: string } | { ok: false; error: string }> {
  if (file.size > 512 * 1024) return { ok: false, error: 'הקובץ גדול מדי.' };
  let j: any;
  try { j = JSON.parse(await file.text()); } catch { return { ok: false, error: 'הקובץ לא נקרא — צריך קובץ טיוטה (.json).' }; }
  const f = cleanFields(j?.fields); if (!f.ok) return { ok: false, error: f.error };
  const a = cleanAcks(j?.acks ?? []); if (!a.ok) return { ok: false, error: a.error };
  const wanted: string[] = Array.isArray(j?.treatmentTypes) ? j.treatmentTypes.map((x: unknown) => String(x).trim()) : [];
  const typeIds = types.filter((t) => wanted.some((w) => w === t.name.trim())).map((t) => t.id);
  const missing = wanted.filter((w) => !types.some((t) => t.name.trim() === w));
  const days = Number(j?.validDays);
  return {
    ok: true,
    draft: { title: String(j?.title ?? '').slice(0, 200), typeIds, validDays: Number.isInteger(days) && days > 0 ? String(days) : '', fields: f.fields, acks: a.acks },
    note: `הטיוטה נטענה לעורך. עברו עליה מול הטופס המקורי ושמרו.${missing.length ? ` סוגי טיפול שלא קיימים עדיין: ${missing.join(', ')} — הוסיפו אותם ובחרו.` : ''}`,
  };
}

const toDraft = (t: Template, o: { id?: string; familyOf?: string }): Draft =>
  ({ ...o, title: t.title, typeIds: [...t.treatment_type_ids], validDays: t.valid_days ? String(t.valid_days) : '', fields: structuredClone(t.fields), acks: [...t.acks] });

/** the editor: fields, follow-ups, confirmations, types and validity. The text is the clinic's — saved as typed. */
function Editor({ draft: start, types, onClose, onSaved }: { draft: Draft; types: TType[]; onClose: () => void; onSaved: (m: string) => void }) {
  const [d, setD] = useState<Draft>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setField = (i: number, p: Partial<Field>) => setD((x) => ({ ...x, fields: x.fields.map((f, k) => (k === i ? { ...f, ...p } : f)) }));
  const move = (i: number, by: number) => setD((x) => {
    const f = [...x.fields]; const j = i + by;
    if (j < 0 || j >= f.length) return x;
    [f[i], f[j]] = [f[j], f[i]]; return { ...x, fields: f };
  });
  const add = (type: FieldType) => setD((x) => ({
    ...x, fields: [...x.fields, {
      key: newKey(x.fields), type, label: type === 'marketing' ? MARKETING_LABEL : '', required: !isTextOnly(type) && type !== 'marketing',
      ...(type === 'choice' || type === 'multi' ? { options: [] } : {}), ...(type === 'yesno' ? { showFollowUpsWhen: 'yes' as const, followUps: [] } : {}),
    }],
  }));
  const options = (v: string) => v.split('\n').map((o) => o.trim()).filter(Boolean);

  async function save() {
    const f = cleanFields(d.fields); if (!f.ok) { setError(f.error); return; }
    const a = cleanAcks(d.acks); if (!a.ok) { setError(a.error); return; }
    if (!d.title.trim()) { setError('תנו שם להצהרה.'); return; }
    setBusy(true); setError('');
    const r = await api<{ template: Template }>({ action: 'template-save', id: d.id, familyOf: d.familyOf, title: d.title, treatmentTypeIds: d.typeIds, validDays: d.validDays, fields: f.fields, acks: a.acks });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onSaved(d.familyOf ? `נשמרה גרסה ${r.data.template.version} כטיוטה. הגרסה המאושרת ממשיכה להישלח עד שהחדשה תאושר.` : 'הטיוטה נשמרה.');
  }

  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-display text-xl font-extrabold">{d.id ? 'עריכת טיוטה' : d.familyOf ? 'גרסה חדשה (טיוטה)' : 'הצהרה חדשה'}</h3>
        <CloseButton onClick={onClose} />
      </div>
      <p className="mb-3 text-xs text-muted">הנוסח נשמר מילה במילה, כפי שהקלדתם. המערכת לא משנה, לא מוסיפה ולא מורידה מילים.</p>
      <FieldBox label="שם ההצהרה"><Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="למשל: הצהרת בריאות — לייזר" /></FieldBox>
      <p className="mb-1.5 text-sm font-semibold">לאיזה טיפול? (בלי בחירה — הצהרה כללית לכל טיפול)</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {types.length ? types.map((t) => (
          <Chip key={t.id} on={d.typeIds.includes(t.id)} onClick={() => setD({ ...d, typeIds: d.typeIds.includes(t.id) ? d.typeIds.filter((x) => x !== t.id) : [...d.typeIds, t.id] })}>{t.name}</Chip>
        )) : <span className="text-xs text-muted">אפשר להוסיף סוגי טיפול במסך הקודם.</span>}
      </div>
      <FieldBox label="תוקף ההצהרה בימים (ריק = בלי הגבלה)">
        <Input type="number" inputMode="numeric" min={1} max={3650} value={d.validDays} onChange={(e) => setD({ ...d, validDays: e.target.value })} className="w-40" />
      </FieldBox>

      <p className="mb-2 mt-2 text-sm font-semibold">שאלות ושדות</p>
      <ol className="mb-3 grid gap-3">
        {d.fields.map((f, i) => (
          <li key={f.key} className="rounded-2xl border border-line p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-muted">{i + 1}. {FIELD_TYPES.find((t) => t.id === f.type)?.label}</span>
              <span className="flex-1" />
              <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => move(i, -1)} aria-label="למעלה">▲</button>
              <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => move(i, 1)} aria-label="למטה">▼</button>
              <button type="button" className="text-xs text-(--danger)" onClick={() => setD({ ...d, fields: d.fields.filter((_, k) => k !== i) })}>הסרה</button>
            </div>
            <Textarea value={f.label} onChange={(e) => setField(i, { label: e.target.value })} className="min-h-16" aria-label="נוסח"
              placeholder={f.type === 'info' ? 'פסקה מתוך ההצהרה (בלי תשובה)' : f.type === 'heading' ? 'כותרת של חלק בהצהרה' : 'נוסח השאלה'} />
            {!isTextOnly(f.type) && f.type !== 'marketing' && (
              <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> חובה</label>
            )}
            {f.type === 'yesno' && (
              <label className="mt-1 flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(f.flag)} onChange={(e) => setField(i, { flag: e.target.checked || undefined })} />
                ⚠️ תשובת "כן" מסמנת התווית נגד (התראה לבעלים ולמטפל/ת)</label>
            )}
            {(f.type === 'choice' || f.type === 'multi') && (
              <Textarea value={(f.options ?? []).join('\n')} onChange={(e) => setField(i, { options: e.target.value.split('\n') })} onBlur={(e) => setField(i, { options: options(e.target.value) })}
                className="mt-2 min-h-16" placeholder="אפשרות בכל שורה" aria-label="אפשרויות" />
            )}
            {f.type === 'yesno' && (
              <div className="mt-2 rounded-xl bg-surface-2 p-2">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <span>שדות המשך נפתחים כשעונים</span>
                  <Select value={f.showFollowUpsWhen ?? 'yes'} onChange={(e) => setField(i, { showFollowUpsWhen: e.target.value as 'yes' | 'no' })} className="h-8 w-auto py-0" aria-label="מתי נפתחים">
                    <option value="yes">כן</option><option value="no">לא</option>
                  </Select>
                </div>
                {(f.followUps ?? []).map((u, j) => {
                  const setUp = (p: Partial<FollowUp>) => setField(i, { followUps: f.followUps!.map((x, k) => (k === j ? { ...x, ...p } : x)) });
                  return (
                    <div key={u.key} className="mb-2 grid gap-1.5 border-s-4 border-primary/40 ps-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Select value={u.type} onChange={(e) => setUp({ type: e.target.value as FollowUp['type'], options: e.target.value === 'choice' ? (u.options ?? []) : undefined })} className="h-8 w-auto py-0" aria-label="סוג שדה ההמשך">
                          {FOLLOW_UP_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </Select>
                        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={u.required} onChange={(e) => setUp({ required: e.target.checked })} /> חובה</label>
                        <button type="button" className="text-xs text-(--danger)" onClick={() => setField(i, { followUps: f.followUps!.filter((_, k) => k !== j) })}>הסרה</button>
                      </div>
                      <Input value={u.label} onChange={(e) => setUp({ label: e.target.value })} placeholder='למשל: "איזו מחלה?"' aria-label="נוסח שדה ההמשך" className="h-9 py-1" />
                      {u.type === 'choice' && <Textarea value={(u.options ?? []).join('\n')} onChange={(e) => setUp({ options: e.target.value.split('\n') })} onBlur={(e) => setUp({ options: options(e.target.value) })} className="min-h-14" placeholder="אפשרות בכל שורה" aria-label="אפשרויות" />}
                    </div>
                  );
                })}
                <button type="button" className="text-xs font-semibold text-primary" onClick={() => setField(i, { followUps: [...(f.followUps ?? []), { key: newKey(d.fields, 'f'), type: 'text', label: '', required: true }] })}>
                  + שדה המשך ("אם כן, פרט/י")
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FIELD_TYPES.map((t) => <Chip key={t.id} on={false} onClick={() => add(t.id)}>+ {t.label}</Chip>)}
      </div>

      <p className="mb-2 text-sm font-semibold">אישורים לסימון (כל אחד חובה)</p>
      {d.acks.map((a, i) => (
        <div key={i} className="mb-2 flex gap-2">
          <Textarea value={a} onChange={(e) => setD({ ...d, acks: d.acks.map((x, k) => (k === i ? e.target.value : x)) })} className="min-h-14" aria-label={`אישור ${i + 1}`} />
          <button type="button" className="text-xs text-(--danger)" onClick={() => setD({ ...d, acks: d.acks.filter((_, k) => k !== i) })}>הסרה</button>
        </div>
      ))}
      <Chip on={false} onClick={() => setD({ ...d, acks: [...d.acks, ''] })}>+ אישור</Chip>
      <p className="mt-3 text-xs text-muted">בסוף כל הצהרה הלקוח/ה ממלא/ת שם מלא, חותם/ת באצבע ומסמן/ת: "{CONFIRM_LINE}"</p>

      {error && <p className="mt-3 text-sm text-warn" role="alert">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? <><Spinner />שומר…</> : 'שמירה כטיוטה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

/** the declaration as the customer will see it (interactive, nothing sent); approving asks to confirm the wording */
function Preview({ t, approve, typesLine, onClose, onApprove }: { t: Template; approve: boolean; typesLine: string; onClose: () => void; onApprove: () => void }) {
  const [answers, setAnswers] = useState<Answers>({});
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-display text-xl font-extrabold">{approve ? 'אישור ההצהרה' : 'תצוגה'} — {t.title}</h3>
        <CloseButton onClick={onClose} />
      </div>
      <p className="mb-3 text-xs text-muted">{typesLine} · גרסה {t.version} · {t.valid_days ? `תוקף ${t.valid_days} ימים` : 'בלי הגבלת תוקף'}. כך הלקוח/ה יראו את ההצהרה בטלפון:</p>
      <div dir="rtl" className="max-h-[55vh] overflow-y-auto rounded-2xl bg-zinc-50 p-4 text-black">
        <h4 className="mb-3 text-xl font-bold">{t.title}</h4>
        {t.fields.map((f) => (
          <Question key={f.key} id={`pv-${f.key}`} prefix="pv" field={f} answers={answers} problem={null}
            onAnswer={(k, v) => setAnswers((a) => { const n = { ...a }; if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete n[k]; else n[k] = v; return n; })} />
        ))}
        {t.acks.map((a, i) => <label key={i} className="mb-2 flex items-start gap-3 rounded-xl border border-zinc-200 p-3"><input type="checkbox" className="mt-1 h-5 w-5" /> <span className="whitespace-pre-wrap">{a}</span></label>)}
        <p className="mt-3 border-t border-zinc-200 pt-3 text-sm">שם מלא · חתימה באצבע · "{CONFIRM_LINE}"</p>
      </div>
      {approve && (
        <div className="mt-4">
          <label className="mb-3 flex items-start gap-2 text-sm font-semibold">
            <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            הנוסח נבדק ומאושר לשימוש (הנוסח של העסק ובאחריותו).
          </label>
          <Button variant="primary" disabled={!checked || busy} onClick={async () => { setBusy(true); await onApprove(); setBusy(false); }}>
            {busy ? <><Spinner />מאשר…</> : 'אישור — זמינה לשליחה מכל כרטיס לקוח'}
          </Button>
        </div>
      )}
    </Modal>
  );
}
