'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Card, Field, Input, Pill } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { useAtt } from './AttendanceLayout';
import { ATTACH_LABEL, REQUEST_LABEL } from './form101';
import { cancelLink, isNotReady, loadEmployeeForms, openFile, reviewForm, sendForm, uploadPaper, type EmployeeForms, type FormRow } from './form101-api';
import { isAdmin, type Employee } from './people';
import { attendanceHref } from './routes';
import { Notice } from './ui';

/**
 * טופס 101 in the employee's file (docs/FORM101_REQUIREMENTS_HE.md §5): every year's form and every update during the year
 * (version 2, 3 … — the earlier ones kept), the PDF and the attachments, what the form asked for and was not attached, the form's
 * own explanations; send a new form for the year or an update (WhatsApp, the personal link), cancel an open link; the scan of
 * the paper signed by hand, once; "reviewed" — the accountant's mark, once. The admin and payroll only.
 */
const at = (iso: string | null) => (iso ? formatIL(iso, { dateStyle: 'short', timeStyle: 'short' }) : '');

export function EmployeeForm101({ employee }: { employee: Employee }) {
  const att = useAtt();
  const admin = isAdmin(att.role);
  const [data, setData] = useState<EmployeeForms | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<FormRow | null>(null);

  const load = useCallback(async () => {
    try { setData(await loadEmployeeForms(employee.id)); setErr(null); }
    catch (e) { if (isNotReady(e)) setNotReady(true); else setErr((e as Error).message); }
  }, [employee.id]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, msg: string) {
    setBusy(true); setErr(null);
    try { await fn(); att.say(msg); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const send = (kind: 'year' | 'update') => run(async () => {
    const how = await sendForm(employee, att.businessName, kind, data?.thisYear);
    if (how === 'copied') att.say('אין טלפון לעובד/ת — ההודעה עם הקישור הועתקה');
  }, kind === 'update' ? 'קישור לעדכון פרטים נשלח' : 'טופס 101 נשלח');

  if (notReady) return <Notice>טופס 101 יופיע כאן אחרי שמריצים את מיגרציה 20261025005900 ב-Supabase.</Notice>;
  if (!data) return err ? <Notice tone="warn">{err}</Notice> : <div className="flex justify-center py-10"><Spinner /></div>;
  const years = [...new Set([data.thisYear, ...data.forms.map((f) => f.taxYear)])].sort((a, b) => b - a);
  const open = data.links.filter((l) => l.status === 'sent' || l.status === 'opened');
  const hasThisYear = data.forms.some((f) => f.taxYear === data.thisYear);

  return (
    <div className="stack-y-4">
      {err && <Notice tone="warn">{err}</Notice>}
      {!data.employerReady && admin && (
        <Notice tone="warn">חסר מספר תיק ניכויים של המעסיק (חלק א בטופס). <Link href={attendanceHref('settings')} className="font-semibold underline">להגדרות</Link></Notice>
      )}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-bold">טופס 101 — {employee.name}</h3>
            <p className="text-sm text-ink-2">כל שנה טופס חדש, וכל שינוי בפרטים במהלך השנה — עדכון. הטפסים הקודמים נשמרים. רואה החשבון בודק ומזין לשכר.</p>
          </div>
          {admin && employee.active && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void send('year')}>{hasThisYear ? `טופס חדש לשנת ${data.thisYear}` : `שליחת טופס 101 לשנת ${data.thisYear}`}</Button>
              {hasThisYear && <Button variant="soft" disabled={busy} onClick={() => void send('update')}>עדכון פרטים (שינוי במהלך השנה)</Button>}
            </div>
          )}
        </div>
        {open.map((l) => (
          <div key={l.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 p-3 text-sm">
            <span><Pill tone="warn">{REQUEST_LABEL[l.status]}</Pill> {l.kind === 'update' ? 'עדכון פרטים' : `טופס לשנת ${l.taxYear}`} · נשלח {at(l.createdAt)}{l.sentBy ? ` ע״י ${l.sentBy}` : ''}{l.openedAt ? ` · נפתח ${at(l.openedAt)}` : ''} · בתוקף עד {formatIL(l.expiresAt, { dateStyle: 'short' })}</span>
            {admin && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm('לבטל את הקישור? העובד/ת לא יוכל/תוכל למלא בו.')) void run(() => cancelLink(l.id), 'הקישור בוטל'); }}>ביטול הקישור</Button>}
          </div>
        ))}
      </Card>

      {years.map((y) => {
        const forms = data.forms.filter((f) => f.taxYear === y);
        return (
          <Card key={y} className="p-4">
            <h4 className="mb-2 font-display text-lg font-bold">שנת המס {y}</h4>
            {!forms.length && <p className="text-sm text-warn">עוד אין טופס 101 לשנה הזו.</p>}
            <ul className="divide-y divide-line">
              {forms.map((f) => (
                <li key={f.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0">
                      <strong>{f.version === 1 ? 'הטופס של השנה' : `עדכון מס׳ ${f.version}`}</strong>
                      <span className="ms-2 text-sm text-ink-2">נחתם במסך ע״י {f.signerName} · {at(f.submittedAt)}</span>
                      <span className="ms-2">{f.reviewedAt ? <Pill tone="ok">נבדק{f.reviewedBy ? ` ע״י ${f.reviewedBy}` : ''} · {formatIL(f.reviewedAt, { dateStyle: 'short' })}</Pill> : <Pill tone="warn">ממתין לבדיקת רואה החשבון</Pill>}</span>
                    </span>
                    <span className="flex flex-wrap gap-2">
                      <Button size="sm" variant="soft" onClick={() => void openFile(f.id, 'pdf').catch((e) => setErr(e.message))}>הטופס (PDF)</Button>
                      {f.hasPaper && <Button size="sm" variant="ghost" onClick={() => void openFile(f.id, 'paper').catch((e) => setErr(e.message))}>החתום ביד</Button>}
                      {!f.reviewedAt && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReview(f)}>סימון: נבדק</Button>}
                      {admin && !f.hasPaper && (
                        <label className="inline-flex min-h-9 cursor-pointer items-center rounded-xl border border-line px-3 text-sm font-semibold">
                          צירוף הטופס החתום ביד
                          <input type="file" accept="image/*,application/pdf" className="sr-only" disabled={busy}
                            onChange={(ev) => { const file = ev.target.files?.[0]; ev.target.value = ''; if (file) void run(() => uploadPaper(f.id, file), 'הטופס החתום ביד צורף'); }} />
                        </label>
                      )}
                    </span>
                  </div>
                  {f.changeNote && <p className="mt-1 text-sm">מה השתנה: {f.changeNote}</p>}
                  {f.reviewNote && <p className="mt-1 text-sm text-ink-2">הערת הבדיקה: {f.reviewNote}</p>}
                  <div className="mt-2 flex flex-wrap gap-2 text-sm">
                    {f.attachments.map((a, n) => (
                      <button key={n} type="button" className="text-module underline" onClick={() => void openFile(f.id, 'attachment', n).catch((e) => setErr(e.message))}>{ATTACH_LABEL[a.kind] ?? 'נספח'}</button>
                    ))}
                    {!f.attachments.length && <span className="text-ink-2">בלי נספחים</span>}
                  </div>
                  {f.missing.length > 0 && <p className="mt-1 text-sm text-warn">הטופס מבקש ולא צורף: {f.missing.map((k) => ATTACH_LABEL[k]).join(' · ')}</p>}
                  {f.warnings.length > 0 && (
                    <details className="mt-1 text-sm text-ink-2"><summary className="cursor-pointer">מדברי ההסבר של הטופס ({f.warnings.length})</summary>
                      <ul className="list-disc ps-5">{f.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
      {review && <ReviewDialog form={review} onClose={() => setReview(null)} onDone={async (note) => { await run(() => reviewForm(review.id, note), 'סומן כנבדק'); setReview(null); }} />}
    </div>
  );
}

function ReviewDialog({ form, onClose, onDone }: { form: FormRow; onClose: () => void; onDone: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-2 font-display text-xl font-bold">סימון: נבדק</h3>
      <p className="mb-3 text-sm text-ink-2">שנת המס {form.taxYear}{form.version > 1 ? ` · עדכון מס׳ ${form.version}` : ''}. הסימון נשמר עם השם והשעה, ולא משתנה אחר כך.</p>
      <Field label="הערה (לא חובה)"><Input value={note} maxLength={500} placeholder="למשל: הוזן לשכר" onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="mt-3 flex gap-2"><Button variant="primary" onClick={() => void onDone(note)}>שמירה</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}
