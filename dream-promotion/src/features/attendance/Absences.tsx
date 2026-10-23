'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Chip, Field, Input, PageHead, Pill, Select } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { useAtt } from './AttendanceLayout';
import { absenceAdd, absenceDecide, absenceFileUrl, attError, loadAbsences, uploadAbsenceFile, type Absence } from './api';
import { ABSENCE_LABEL, hm, type AbsenceKind } from './hours-engine';
import { canManage } from './people';
import { MonthSwitch, Notice, ReasonModal, thisMonth, today } from './ui';

/**
 * היעדרויות (2.107): vacation, sickness (with the doctor's note — a private file), reserve duty, other. A manager's record is
 * approved at once; an employee's request (the clock — stage 2) waits for approval. Never deleted: cancelled with a reason.
 */
const STATUS: Record<string, { label: string; tone: 'ok' | 'ai' | 'warn' | 'default' }> = {
  approved: { label: 'מאושרת', tone: 'ok' }, pending: { label: 'ממתינה', tone: 'ai' }, rejected: { label: 'נדחתה', tone: 'warn' }, cancelled: { label: 'בוטלה', tone: 'default' },
};
const dmy = (d: string) => d.split('-').reverse().join('/');

export function Absences() {
  const att = useAtt();
  const { setup, role } = att;
  const params = useSearchParams();
  const router = useRouter();
  const [month, setMonth] = useState(thisMonth());
  const [list, setList] = useState<Absence[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(params.get('new') === '1');
  const [cancel, setCancel] = useState<Absence | null>(null);
  const name = (id: string) => setup.employees.find((e) => e.id === id)?.name ?? '';
  const load = useCallback(async () => {
    try { setList(await loadAbsences({ month })); setErr(null); } catch (e) { setErr(attError(e)); }
  }, [month]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <PageHead title="היעדרויות" action={canManage(role) && <Button variant="primary" onClick={() => setAdding(true)}>רישום היעדרות</Button>} />
      <div className="mb-4"><MonthSwitch month={month} onChange={setMonth} /></div>
      {err && <Notice tone="warn">{err}</Notice>}
      {!list ? <div className="flex justify-center py-16"><Spinner /></div> : !list.length ? <p className="text-sm text-muted">אין היעדרויות בחודש הזה.</p> : (
        <div className="grid gap-2">
          {list.map((a) => (
            <Card key={a.id} className={cx('flex flex-wrap items-center justify-between gap-2 p-3', a.status === 'cancelled' && 'opacity-60')}>
              <div className="text-sm">
                <strong>{name(a.employeeId)}</strong> · {ABSENCE_LABEL[a.kind]} · {dmy(a.from)}{a.to !== a.from ? `–${dmy(a.to)}` : ''}{a.minutes ? ` · ${hm(a.minutes)}` : ''}
                <span className="block text-muted">{a.requestedBy === 'employee' ? 'בקשת העובד/ת' : 'נרשם ע״י מנהל/ת'}{a.note ? ` · ${a.note}` : ''}{a.decisionNote ? ` · ${a.decisionNote}` : ''}</span>
                {a.filePath && <button type="button" className="text-module underline" onClick={async () => { const w = window.open('', '_blank'); const u = await absenceFileUrl(a.filePath); if (w && u) w.location.href = u; else w?.close(); }}>האישור המצורף</button>}
              </div>
              <div className="flex items-center gap-2">
                <Pill tone={STATUS[a.status]?.tone ?? 'default'}>{STATUS[a.status]?.label ?? a.status}</Pill>
                {canManage(role) && a.status === 'approved' && <Button size="sm" variant="ghost" onClick={() => setCancel(a)}>ביטול</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}
      {adding && <AbsenceDialog onClose={() => { setAdding(false); if (params.get('new')) router.replace('/attendance/absences'); }} onSaved={() => { att.say('ההיעדרות נרשמה'); void load(); }} />}
      <ReasonModal open={Boolean(cancel)} title="ביטול היעדרות" action="ביטול ההיעדרות" onClose={() => setCancel(null)} body="ההיעדרות לא נמחקת — היא נשארת, מסומנת כמבוטלת."
        onDone={(why) => absenceDecide(cancel!.id, 'cancelled', why).then(() => { att.say('ההיעדרות בוטלה'); return load(); })} />
    </>
  );
}

function AbsenceDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const att = useAtt();
  const [f, setF] = useState({ emp: '', kind: 'vacation' as AbsenceKind, from: today(), to: today(), part: false, hours: '', note: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const minutes = f.part ? Math.round(Number(f.hours.replace(',', '.')) * 60) : null;
  const bad = !f.emp || f.to < f.from || (f.part && (!minutes || minutes <= 0 || minutes > 1440));
  async function save() {
    setBusy(true); setErr(null);
    try {
      const path = file ? await uploadAbsenceFile(att.businessId, f.emp, file) : '';
      await absenceAdd({ employeeId: f.emp, kind: f.kind, from: f.from, to: f.part ? f.from : f.to, minutes, note: f.note.trim(), file: path });
      onSaved(); onClose();
    } catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-3 font-display text-xl font-bold">רישום היעדרות</h3>
      <Field label="עובד/ת"><Select value={f.emp} onChange={(e) => setF({ ...f, emp: e.target.value })}>
        <option value="">בחרו…</option>{att.setup.employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(['vacation', 'sick', 'reserve', 'other'] as const).map((k) => <Chip key={k} on={f.kind === k} onClick={() => setF({ ...f, kind: k })} className="min-h-10">{ABSENCE_LABEL[k]}</Chip>)}
      </div>
      <div className="mb-4 flex gap-1.5">
        <Chip on={!f.part} onClick={() => setF({ ...f, part: false })} className="min-h-10">ימים שלמים</Chip>
        <Chip on={f.part} onClick={() => setF({ ...f, part: true })} className="min-h-10">שעות ביום אחד</Chip>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={f.part ? 'תאריך' : 'מתאריך'}><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: f.to < e.target.value ? e.target.value : f.to })} /></Field>
        {f.part ? <Field label="כמה שעות"><Input value={f.hours} inputMode="decimal" placeholder="למשל 2.5" onChange={(e) => setF({ ...f, hours: e.target.value })} /></Field>
          : <Field label="עד תאריך"><Input type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>}
      </div>
      <Field label="הערה (לא חובה)"><Input value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      {f.kind === 'sick' && <Field label="אישור מחלה (תמונה או PDF, לא חובה)"><input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" /></Field>}
      {err && <p role="alert" className="mb-3 text-sm text-warn">{err}</p>}
      <div className="flex gap-2"><Button variant="primary" disabled={busy || bad} onClick={() => void save()}>שמירה</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}
