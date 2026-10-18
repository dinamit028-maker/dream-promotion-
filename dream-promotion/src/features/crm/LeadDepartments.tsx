'use client';
import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { Button, Card, Field, Input, PageHead, Select, SmallSelect } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { cx } from '@/lib/utils';
import {
  FRESH_HOURS, NEW_LEAD_TEMPLATE, NO_DEPARTMENT, WA_NOT_CONNECTED, noticeLine, templateCategoryWarning,
  type DeptView, type NoticeView, type RuleKind, type RuleView, type StaffView,
} from './lead-routing';
import { keepView, loadForms, loadSetup, postDepartments, useLeadRouting } from './lead-routing-data';
import { isCloudConfigured } from '@/lib/supabase/client';

/**
 * לקוחות → "מחלקות" (2.99): the team that gets leads (a name, a WhatsApp number, who they are in Dream), the departments (each
 * with the person responsible and how its leads are recognised — a Meta form, a campaign, or a question of the form and its
 * answer), who gets a lead with no department, and the last messages. A test message per person shows Meta's own answer, or
 * its error code. Only the owner changes anything; a member sees the departments and who is responsible.
 */
type Member = { userId: string; name: string; role: string };
type Health = {
  connected: boolean;
  number?: { display: string; name: string; quality: string } | { error: { code: string; message: string } };
  template?: { status: string; language: string; category: string } | { missing: true } | { error: { code: string; message: string } };
};
type Setup = { members: Member[]; health: Health; recent: NoticeView[] };
type FormItem = { id: string; name: string; status: string; page: string; questions: { key: string; label: string; options: string[] }[] };
type TestResult = { busy?: boolean; ok?: boolean; body?: any; message?: string };
type StaffDraft = { id?: string; name: string; phone: string; memberUserId: string };
/** a rule being edited: a key of its own (rules come and go), and whether the form is typed by its id */
type RuleDraft = RuleView & { key: string; manual?: boolean };
type DeptDraft = { id?: string; name: string; staffId: string; rules: RuleDraft[] };

const KIND_LABEL: Record<RuleKind, string> = { form: 'טופס של Meta', campaign: 'קמפיין', answer: 'שאלה ותשובה בטופס' };
const TEMPLATE_STATE: Record<string, string> = {
  APPROVED: 'מאושרת ✓', PENDING: 'ממתינה לאישור של Meta', REJECTED: 'נדחתה', PAUSED: 'מושהית', DISABLED: 'מושבתת', IN_APPEAL: 'בערעור',
};
const TEMPLATE_CATEGORY: Record<string, string> = { UTILITY: 'שירות ציבורי', MARKETING: 'שיווק', AUTHENTICATION: 'אימות' };
let ruleSeq = 0;
const emptyRule = (kind: RuleKind = 'form'): RuleDraft => ({ key: `r${++ruleSeq}`, kind, formId: '', formName: '', campaign: '', question: '', answer: '' });
const ruleText = (r: RuleView) =>
  r.kind === 'form' ? `טופס: ${r.formName || r.formId}` : r.kind === 'campaign' ? `קמפיין: ${r.campaign}` : `שאלה: ${r.question} ← ${r.answer}`;

export function LeadDepartments() {
  const { view, notReady, error } = useLeadRouting();
  const ids = useId();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [forms, setForms] = useState<{ busy: boolean; list: FormItem[]; errors: { page: string; message: string }[]; pages: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [staffEdit, setStaffEdit] = useState<StaffDraft | null>(null);
  const [deptEdit, setDeptEdit] = useState<DeptDraft | null>(null);

  const owner = Boolean(view?.owner);
  const refreshSetup = () => { void loadSetup().then((r) => { if (r.ok && r.body?.ready) setSetup({ members: r.body.members ?? [], health: r.body.health, recent: r.body.recent ?? [] }); }); };
  useEffect(() => { if (owner) refreshSetup(); }, [owner]);

  if (!isCloudConfigured) return <Wrap><p className="text-ink-2">מחלקות לידים זמינות בחשבון שמחובר לענן.</p></Wrap>;
  if (error) return <Wrap><p role="alert" className="text-warn">{error}</p></Wrap>;
  if (notReady) return <Wrap><p role="status" className="text-ink-2">{notReady.message}</p></Wrap>;
  if (!view) return <Wrap><p className="text-muted"><Spinner /> טוען…</p></Wrap>;

  const active = view.staff.filter((s) => s.active);
  const depts = view.departments.filter((d) => d.active);
  const nameOf = (id: string | null | undefined) => view.staff.find((s) => s.id === id)?.name ?? '—';
  const memberName = (id: string | null) => setup?.members.find((m) => m.userId === id)?.name ?? '';

  async function post(key: string, body: Record<string, unknown>, done?: () => void) {
    setBusy(key); setMsg(null);
    const r = await postDepartments(body);
    setBusy(null);
    if (!r.ok || !r.body?.ready) { setMsg({ ok: false, text: r.body?.message ?? 'השמירה לא הצליחה.' }); return; }
    keepView(r.body);
    setMsg({ ok: true, text: 'נשמר ✓' });
    done?.();
  }
  async function test(s: StaffView) {
    setTests((t) => ({ ...t, [s.id]: { busy: true } }));
    const r = await postDepartments({ action: 'test', staffId: s.id });
    setTests((t) => ({ ...t, [s.id]: r.status === 200 ? { ok: Boolean(r.body?.ok), body: r.body } : { ok: false, message: r.body?.message ?? 'הבדיקה לא הצליחה.' } }));
    refreshSetup();
  }
  function openForms() {
    if (forms) return;
    setForms({ busy: true, list: [], errors: [], pages: 0 });
    void loadForms().then((r) => setForms({ busy: false, list: r.body?.forms ?? [], errors: r.body?.errors ?? [], pages: r.body?.pages ?? 0 }));
  }
  const editDept = (d?: DeptView) => {
    setStaffEdit(null); setMsg(null);
    setDeptEdit(d ? { id: d.id, name: d.name, staffId: d.staffId, rules: (d.rules ?? []).map((r) => ({ ...r, key: `r${++ruleSeq}` })) } : { name: '', staffId: active[0]?.id ?? '', rules: [emptyRule()] });
    openForms();
  };
  const editStaff = (s?: StaffView) => {
    setDeptEdit(null); setMsg(null);
    setStaffEdit(s ? { id: s.id, name: s.name, phone: s.phoneShown ?? '', memberUserId: s.memberUserId ?? '' } : { name: '', phone: '', memberUserId: '' });
  };
  const setRule = (key: string, patch: Partial<RuleDraft>) => deptEdit && setDeptEdit({ ...deptEdit, rules: deptEdit.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const questions = [...new Set((forms?.list ?? []).flatMap((f) => f.questions.map((q) => q.label || q.key)))];
  const optionsFor = (question: string) => [...new Set((forms?.list ?? []).flatMap((f) => f.questions.filter((q) => (q.label || q.key) === question).flatMap((q) => q.options)))];

  return (
    <Wrap>
      {/* WhatsApp: connected or not, the sending number and the template */}
      <Card className="mb-4 p-4">
        {view.connected ? (
          <>
            <p className="font-bold">💬 וואטסאפ מחובר</p>
            {owner && setup?.health && <HealthLines h={setup.health} />}
          </>
        ) : (
          <>
            <p className="font-bold">⏸️ {WA_NOT_CONNECTED}</p>
            <p className="mt-1 text-sm text-ink-2">לידים חדשים עדיין מקבלים מחלקה ואחראי ב-Dream, אבל הודעות בוואטסאפ לא נשלחות עד שהחיבור מוגדר בשרת.</p>
          </>
        )}
        <p className="mt-2 text-xs text-muted">ההודעות נשלחות רק לצוות שברשימה כאן — אף פעם לא ללקוחות. ליד שנוצר לפני יותר מ-{FRESH_HOURS} שעות מקבל מחלקה ואחראי, אבל לא נשלח.</p>
      </Card>

      {msg && <p role="status" className={cx('mb-3 text-sm font-semibold', msg.ok ? 'text-(--ok,#16a34a)' : 'text-warn')}>{msg.text}</p>}
      {!owner && <p className="mb-3 text-sm text-ink-2">רק בעלי העסק משנים את ההגדרות כאן.</p>}

      {/* the team */}
      <section aria-labelledby={`${ids}-team`} className="mb-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id={`${ids}-team`} className="font-display text-lg font-extrabold">הצוות שמקבל לידים</h2>
          {owner && !staffEdit && <Button size="sm" variant="ghost" onClick={() => editStaff()}>+ אדם לצוות</Button>}
        </div>
        {active.length === 0 && !staffEdit && <p className="text-sm text-muted">עוד אין אף אחד ברשימה. כל מי שמקבל לידים בוואטסאפ צריך להופיע כאן, עם המספר שלו.</p>}
        <ul className="grid gap-2">
          {active.map((s) => {
            const t = tests[s.id];
            return (
              <li key={s.id} className="rounded-2xl border border-line bg-surface p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <strong>{s.name}</strong>
                  {s.phoneShown && <bdi dir="ltr" className="text-sm tabular-nums text-ink-2">{s.phoneShown}</bdi>}
                  {owner && s.phone === '' && <span className="text-xs text-muted">בלי וואטסאפ — לא מקבל/ת הודעות</span>}
                  {s.practitioner && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-bold text-ink-2">מטפל/ת ביומן</span>}
                  {s.memberUserId && <span className="text-xs text-muted">ב-Dream: {memberName(s.memberUserId) || 'חשבון בעסק'}</span>}
                  {view.defaultStaffId === s.id && <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-bold">ברירת מחדל</span>}
                </div>
                {owner && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {s.phone !== '' && (
                      <Button size="sm" variant="primary" onClick={() => test(s)} disabled={!view.connected || Boolean(t?.busy)}>
                        {t?.busy ? <><Spinner />בשליחה…</> : 'שליחת הודעת בדיקה'}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => editStaff(s)}>עריכה</Button>
                    <Button size="sm" variant="ghost" disabled={busy === `rm-${s.id}`}
                      onClick={() => { if (window.confirm(`להסיר את ${s.name} מהצוות?`)) void post(`rm-${s.id}`, { action: 'staff.remove', id: s.id }); }}>הסרה</Button>
                  </div>
                )}
                {t && !t.busy && <TestBox t={t} />}
              </li>
            );
          })}
        </ul>
        {owner && staffEdit && (
          <Card className="mt-3 p-4">
            <h3 className="mb-3 font-bold">{staffEdit.id ? `עריכה: ${staffEdit.name}` : 'אדם חדש בצוות'}</h3>
            <Field label="שם"><Input value={staffEdit.name} onChange={(e) => setStaffEdit({ ...staffEdit, name: e.target.value })} maxLength={60} /></Field>
            <Field label="מספר וואטסאפ (רק למי שמקבל/ת לידים בהודעה)">
              <Input value={staffEdit.phone} onChange={(e) => setStaffEdit({ ...staffEdit, phone: e.target.value })} inputMode="tel" dir="ltr" placeholder="050-1234567" />
            </Field>
            <Field label="החשבון ב-Dream (לא חובה — בשביל &quot;הלידים שלי&quot;)">
              <Select value={staffEdit.memberUserId} onChange={(e) => setStaffEdit({ ...staffEdit, memberUserId: e.target.value })}>
                <option value="">בלי חשבון</option>
                {(setup?.members ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
              </Select>
            </Field>
            <p className="mb-3 text-xs text-muted">מספר בישראל: 050-1234567. מספר בחו״ל: עם הקידומת, למשל ‎+1 555 010 0123.</p>
            <div className="flex gap-2">
              <Button variant="primary" disabled={busy === 'staff' || !staffEdit.name.trim()}
                onClick={() => post('staff', { action: 'staff.save', id: staffEdit.id, name: staffEdit.name, phone: staffEdit.phone, memberUserId: staffEdit.memberUserId || null }, () => setStaffEdit(null))}>
                {busy === 'staff' ? <><Spinner />בשמירה…</> : 'שמירה'}
              </Button>
              <Button variant="ghost" onClick={() => setStaffEdit(null)}>ביטול</Button>
            </div>
          </Card>
        )}
      </section>

      {/* the departments */}
      <section aria-labelledby={`${ids}-depts`} className="mb-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id={`${ids}-depts`} className="font-display text-lg font-extrabold">מחלקות</h2>
          {owner && !deptEdit && active.length > 0 && <Button size="sm" variant="ghost" onClick={() => editDept()}>+ מחלקה</Button>}
        </div>
        {owner && active.length === 0 && <p className="text-sm text-muted">קודם להוסיף לצוות את מי שאחראי על המחלקה.</p>}
        {depts.length === 0 && active.length > 0 && !deptEdit && <p className="text-sm text-muted">עוד אין מחלקות.</p>}
        <ul className="grid gap-2">
          {depts.map((d) => (
            <li key={d.id} className="rounded-2xl border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <strong>{d.name}</strong>
                <span className="text-sm text-ink-2">אחראי: {nameOf(d.staffId)}</span>
              </div>
              {d.rules && (
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {d.rules.length === 0 && <li className="text-xs text-warn">בלי כלל זיהוי — לידים לא יגיעו למחלקה הזו לבד.</li>}
                  {d.rules.map((r, i) => <li key={i} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs" dir="auto">{ruleText(r)}</li>)}
                </ul>
              )}
              {owner && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => editDept(d)}>עריכה</Button>
                  <Button size="sm" variant="ghost" disabled={busy === `rmd-${d.id}`}
                    onClick={() => { if (window.confirm(`להסיר את המחלקה ${d.name}? לידים שכבר שויכו אליה נשארים עם השם שלה.`)) void post(`rmd-${d.id}`, { action: 'department.remove', id: d.id }); }}>הסרה</Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {owner && deptEdit && (
          <Card className="mt-3 p-4">
            <h3 className="mb-3 font-bold">{deptEdit.id ? `עריכה: ${deptEdit.name}` : 'מחלקה חדשה'}</h3>
            <Field label="שם המחלקה"><Input value={deptEdit.name} onChange={(e) => setDeptEdit({ ...deptEdit, name: e.target.value })} placeholder="מיקרובליידינג, לייזר…" maxLength={60} /></Field>
            <Field label="אחראי על המחלקה">
              <Select value={deptEdit.staffId} onChange={(e) => setDeptEdit({ ...deptEdit, staffId: e.target.value })}>
                {active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <p className="mb-1 text-sm font-semibold text-ink-2">איך מזהים ליד של המחלקה</p>
            <p className="mb-2 text-xs text-muted">כשכמה כללים מתאימים: קודם שאלה ותשובה, אחר כך טופס, ואחר כך קמפיין. בין מחלקות — לפי הסדר ברשימה.</p>
            {forms?.busy && <p className="mb-2 text-xs text-muted"><Spinner /> טוען את הטפסים מ-Meta…</p>}
            {forms && !forms.busy && forms.pages === 0 && <p className="mb-2 text-xs text-muted">אין עמוד פייסבוק מחובר לעסק — אפשר להקליד את המזהה של הטופס.</p>}
            {forms?.errors.map((e) => <p key={e.page} className="mb-2 text-xs text-warn">{e.page}: {e.message}</p>)}
            <ol className="mb-3 grid gap-2">
              {deptEdit.rules.map((r, i) => {
                const list = forms?.list ?? [];
                const inList = list.some((f) => f.id === r.formId);
                const typed = !list.length || r.manual || (Boolean(r.formId) && !inList);
                return (
                  <li key={r.key} className="grid gap-2 rounded-xl border border-line p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <label htmlFor={`${ids}-k${r.key}`} className="text-xs font-semibold text-ink-2">כלל {i + 1}</label>
                      <SmallSelect id={`${ids}-k${r.key}`} value={r.kind} onChange={(e) => setRule(r.key, { ...emptyRule(e.target.value as RuleKind), key: r.key })} className="w-48">
                        {(Object.keys(KIND_LABEL) as RuleKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                      </SmallSelect>
                      <button type="button" className="ms-auto min-h-9 text-xs text-muted underline"
                        onClick={() => setDeptEdit({ ...deptEdit, rules: deptEdit.rules.filter((x) => x.key !== r.key) })}>הסרת הכלל</button>
                    </div>
                    {r.kind === 'form' && list.length > 0 && (
                      <div className="grid gap-1">
                        <label htmlFor={`${ids}-f${r.key}`} className="text-xs font-semibold text-ink-2">הטופס</label>
                        <SmallSelect id={`${ids}-f${r.key}`} value={typed ? '__id' : r.formId} className="w-full"
                          onChange={(e) => { const f = list.find((x) => x.id === e.target.value); setRule(r.key, f ? { formId: f.id, formName: f.name, manual: false } : { formId: '', formName: '', manual: e.target.value === '__id' }); }}>
                          <option value="">בחירת טופס…</option>
                          {list.map((f) => <option key={f.id} value={f.id}>{f.name}{f.status && f.status !== 'ACTIVE' ? ` (${f.status})` : ''} — {f.page}</option>)}
                          <option value="__id">טופס אחר — לפי המזהה שלו</option>
                        </SmallSelect>
                      </div>
                    )}
                    {r.kind === 'form' && typed && (
                      <div className="grid gap-1">
                        <label htmlFor={`${ids}-fi${r.key}`} className="text-xs font-semibold text-ink-2">המזהה של הטופס ב-Meta</label>
                        <Input id={`${ids}-fi${r.key}`} value={r.formId} onChange={(e) => setRule(r.key, { formId: e.target.value.replace(/\D/g, ''), manual: true })}
                          inputMode="numeric" dir="ltr" className="h-10 py-1" placeholder="1234567890" />
                      </div>
                    )}
                    {r.kind === 'campaign' && (
                      <div className="grid gap-1">
                        <label htmlFor={`${ids}-c${r.key}`} className="text-xs font-semibold text-ink-2">שם הקמפיין מכיל (או המזהה שלו)</label>
                        <Input id={`${ids}-c${r.key}`} value={r.campaign} onChange={(e) => setRule(r.key, { campaign: e.target.value })} className="h-10 py-1" placeholder="לייזר" />
                      </div>
                    )}
                    {r.kind === 'answer' && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="grid gap-1">
                          <label htmlFor={`${ids}-q${r.key}`} className="text-xs font-semibold text-ink-2">השאלה בטופס</label>
                          <Input id={`${ids}-q${r.key}`} value={r.question} onChange={(e) => setRule(r.key, { question: e.target.value })} list={`${ids}-ql`} className="h-10 py-1" placeholder="איזה טיפול מעניין אותך?" />
                        </div>
                        <div className="grid gap-1">
                          <label htmlFor={`${ids}-a${r.key}`} className="text-xs font-semibold text-ink-2">התשובה</label>
                          <Input id={`${ids}-a${r.key}`} value={r.answer} onChange={(e) => setRule(r.key, { answer: e.target.value })} list={`${ids}-al${r.key}`} className="h-10 py-1" placeholder="מיקרובליידינג" />
                          <datalist id={`${ids}-al${r.key}`}>{optionsFor(r.question).map((o) => <option key={o} value={o} />)}</datalist>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            <datalist id={`${ids}-ql`}>{questions.map((q) => <option key={q} value={q} />)}</datalist>
            <Button size="sm" variant="ghost" onClick={() => setDeptEdit({ ...deptEdit, rules: [...deptEdit.rules, emptyRule()] })}>+ כלל זיהוי</Button>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" disabled={busy === 'dept' || !deptEdit.name.trim() || !deptEdit.staffId}
                onClick={() => post('dept', { action: 'department.save', id: deptEdit.id, name: deptEdit.name, staffId: deptEdit.staffId,
                  rules: deptEdit.rules.map(({ key: _k, manual: _m, ...r }) => r) }, () => setDeptEdit(null))}>
                {busy === 'dept' ? <><Spinner />בשמירה…</> : 'שמירה'}
              </Button>
              <Button variant="ghost" onClick={() => setDeptEdit(null)}>ביטול</Button>
            </div>
          </Card>
        )}
      </section>

      {/* a lead with no department */}
      <section aria-labelledby={`${ids}-none`} className="mb-6">
        <h2 id={`${ids}-none`} className="mb-1 font-display text-lg font-extrabold">ליד בלי מחלקה</h2>
        <p className="mb-2 text-sm text-ink-2">ליד שלא מתאים לאף מחלקה נשאר ב-Dream ומסומן &quot;{NO_DEPARTMENT}&quot;. אפשר לבחור מי יקבל אותו בוואטסאפ.</p>
        {owner ? (
          <div className="grid max-w-sm gap-1">
            <label htmlFor={`${ids}-def`} className="text-sm font-semibold text-ink-2">מי מקבל ליד בלי מחלקה</label>
            <Select id={`${ids}-def`} value={view.defaultStaffId ?? ''} disabled={busy === 'default'}
              onChange={(e) => post('default', { action: 'default.set', staffId: e.target.value || null })}>
              <option value="">אף אחד — רק הסימון ב-Dream</option>
              {active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
        ) : <p className="text-sm">{view.defaultStaffId ? `נשלח אל ${nameOf(view.defaultStaffId)}` : 'לא נשלח לאף אחד.'}</p>}
      </section>

      {/* 2.102: the site's requests — "בקשת הצעת מחיר" and the contact form (after migration 20261017005400) */}
      {view.siteDepartmentId !== undefined && (
        <section aria-labelledby={`${ids}-site`} className="mb-6">
          <h2 id={`${ids}-site`} className="mb-1 font-display text-lg font-extrabold">פניות מהאתר</h2>
          <p className="mb-2 text-sm text-ink-2">בקשת הצעת מחיר על מוצר, וטופס הפנייה באתר, נכנסות ללידים ונשלחות בוואטסאפ לאחראי של המחלקה שתבחרו. כלל &quot;שאלה ותשובה&quot; (למשל מקור ← אתר, נושא ← סורסינג) קודם לבחירה הזו.</p>
          {owner ? (
            <div className="grid max-w-sm gap-1">
              <label htmlFor={`${ids}-site-d`} className="text-sm font-semibold text-ink-2">איזו מחלקה מקבלת פניות מהאתר</label>
              <Select id={`${ids}-site-d`} value={depts.some((d) => d.id === view.siteDepartmentId) ? view.siteDepartmentId ?? '' : ''} disabled={busy === 'site'}
                onChange={(e) => post('site', { action: 'site.set', departmentId: e.target.value || null })}>
                <option value="">כמו ליד בלי מחלקה</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </div>
          ) : <p className="text-sm">{depts.find((d) => d.id === view.siteDepartmentId)?.name ?? 'כמו ליד בלי מחלקה'}</p>}
        </section>
      )}

      {/* the last messages */}
      {owner && setup && setup.recent.length > 0 && (
        <section aria-labelledby={`${ids}-recent`} className="mb-6">
          <h2 id={`${ids}-recent`} className="mb-2 font-display text-lg font-extrabold">הודעות אחרונות</h2>
          <ul className="grid gap-1.5">
            {setup.recent.map((n) => {
              const line = noticeLine(n);
              return (
                <li key={n.id} className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
                  <span className="font-semibold">{n.leadName || 'ליד'}</span> · <span>{line.text}</span>
                  <span className="block text-xs text-muted">{formatIL(n.createdAt)}{line.hint ? ` · ${line.hint}` : ''}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHead title="מחלקות לידים" sub="כל ליד חדש מטופס של Meta מגיע למחלקה שלו, משויך לאחראי עליה ונשלח בוואטסאפ לאחראי בלבד."
        action={<Link href="/leads" className="inline-flex min-h-10 items-center text-sm font-semibold text-primary underline">חזרה ללקוחות</Link>} />
      {children}
    </>
  );
}

function HealthLines({ h }: { h: Health }) {
  const n = h.number, t = h.template;
  return (
    <div className="mt-1 grid gap-0.5 text-sm text-ink-2">
      {n && ('error' in n
        ? <p className="text-warn">המספר השולח: לא נבדק — קוד {n.error.code}{n.error.message ? ` (${n.error.message})` : ''}</p>
        : <p>שולח מ: <bdi dir="ltr">{n.display}</bdi>{n.name ? ` · ${n.name}` : ''}</p>)}
      {t && ('error' in t
        ? <p className="text-warn">התבנית {NEW_LEAD_TEMPLATE.name}: לא נבדקה — קוד {t.error.code}</p>
        : 'missing' in t
          ? <p className="text-warn">התבנית {NEW_LEAD_TEMPLATE.name} בעברית לא נמצאה בחשבון.</p>
          : <>
            <p>התבנית {NEW_LEAD_TEMPLATE.name} (עברית{TEMPLATE_CATEGORY[t.category] ? `, ${TEMPLATE_CATEGORY[t.category]}` : ''}): {TEMPLATE_STATE[t.status] ?? t.status}{t.status !== 'APPROVED' ? ' — עד שהיא מאושרת, השליחה נכשלת (קוד 132001).' : ''}</p>
            {templateCategoryWarning(t.category) && <p role="alert" className="font-semibold text-warn">⚠️ {templateCategoryWarning(t.category)}</p>}
          </>)}
    </div>
  );
}

/** Meta's answer to the test, or its error with the code — as it came */
function TestBox({ t }: { t: TestResult }) {
  const b = t.body;
  if (t.message) return <p role="status" className="mt-2 text-sm font-semibold text-warn">{t.message}</p>;
  return (
    <div role="status" className={cx('mt-2 rounded-xl p-2.5 text-sm', t.ok ? 'bg-emerald-500/10' : 'bg-(--danger)/10')}>
      {t.ok ? (
        <>
          <p className="font-semibold text-(--ok,#16a34a)">✓ Meta קיבלה את ההודעה (HTTP {b.http})</p>
          <p className="text-xs" dir="ltr">message id: {b.messageId} · status: {b.status}{b.waId ? ` · wa_id: ${b.waId}` : ''}</p>
          <p className="text-xs text-muted">אם ההודעה לא הגיעה לטלפון: במספר בדיקה, המספר צריך להיות ברשימת הנמענים המאושרים ב-Meta.</p>
        </>
      ) : (
        <>
          <p className="font-semibold text-(--danger)">✗ Meta החזירה שגיאה · קוד {b.code}{b.http ? ` · HTTP ${b.http}` : ''}</p>
          {b.hint && <p className="text-xs">{b.hint}</p>}
          {b.error?.message && <p className="text-xs" dir="ltr">{b.error.message}</p>}
          {b.error?.details && <p className="text-xs" dir="ltr">{b.error.details}</p>}
          {b.error?.fbtrace && <p className="text-xs text-muted" dir="ltr">fbtrace_id: {b.error.fbtrace}</p>}
        </>
      )}
      {b?.response && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted">התשובה המלאה של Meta</summary>
          <pre dir="ltr" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(b.response, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
