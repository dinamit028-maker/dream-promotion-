'use client';
import { useEffect, useState } from 'react';
import { Button, Card, Chip, Field, Input, PageHead, Textarea } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { Note, Pill } from '@/features/finance/ui';
import { cx } from '@/lib/utils';
import {
  KIND_HE, KINDS, LOCATIONS_MIGRATION, MAX_LOCATIONS, MAX_REGISTERS, activeLocations, locationError, nextRegisterName, registerError,
  type Location, type LocationInput, type Register, type RegisterInput,
} from './locations';
import { saveLocation, saveRegister } from './locations-data';
import { useLocations } from './store';

/**
 * "סניפים וקופות" (T12א): the business's locations — a store, a branch, a warehouse, a clinic — and the registers of each.
 * The owner's screen (the database lets only the owner change them). With one location and one register nothing else in the app
 * changes; a second location brings the switch at the top, a second register the register picker in the register.
 */
export function LocationsScreen() {
  const { state, loaded, load } = useLocations();
  const [editLoc, setEditLoc] = useState<LocationInput | null>(null);
  const [editReg, setEditReg] = useState<RegisterInput | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 3500); };

  if (!loaded) return <div className="py-10 text-center"><Spinner /></div>;
  if (!state.ready) return <><PageHead title="סניפים וקופות" /><Note tone="warn">{LOCATIONS_MIGRATION}</Note></>;
  const owner = state.owner;
  const several = activeLocations(state).length > 1 || state.registers.filter((r) => r.active).length > 1;
  const newLocation = (): LocationInput => ({ id: null, name: '', kind: 'store', address: '', phone: '', hours: '', active: true, sort: state.locations.length });
  const newRegister = (l: Location): RegisterInput => ({ id: null, locationId: l.id, name: nextRegisterName(state.registers, l.id), device: '', active: true,
    sort: state.registers.filter((r) => r.locationId === l.id).length });

  async function toggleLocation(l: Location) {
    if (l.active && !window.confirm(`לסגור את "${l.name}"? הנתונים שלו נשמרים, והוא לא יוצע יותר לעבודה.`)) return;
    const r = await saveLocation({ ...l, active: !l.active });
    if (!r.ok) return window.alert(r.error);
    await load(); say(l.active ? `"${l.name}" נסגר.` : `"${l.name}" נפתח שוב.`);
  }
  async function toggleRegister(r: Register) {
    if (r.active && !window.confirm(`לסגור את "${r.name}"? המכירות שלה נשמרות, והיא לא תוצע יותר במכשירים.`)) return;
    const x = await saveRegister({ ...r, active: !r.active });
    if (!x.ok) return window.alert(x.error);
    await load(); say(r.active ? `"${r.name}" נסגרה.` : `"${r.name}" נפתחה שוב.`);
  }

  return (
    <>
      <PageHead title="סניפים וקופות" sub={several ? `${activeLocations(state).length} סניפים פעילים · עד ${MAX_LOCATIONS} סניפים, עד ${MAX_REGISTERS} קופות בכל סניף`
        : 'לעסק יש סניף אחד וקופה אחת'}
        action={owner && state.locations.length < MAX_LOCATIONS ? <Button variant="primary" onClick={() => setEditLoc(newLocation())}>+ סניף חדש</Button> : undefined} />
      {flash && <p role="status" className="mb-4 rounded-2xl bg-emerald-500/15 p-3 text-sm font-semibold">✓ {flash}</p>}
      {!owner && <div className="mb-4"><Note>רק בעלי העסק מוסיפים ומשנים סניפים וקופות.</Note></div>}
      {!several && (
        <div className="mb-4"><Note>
          כשמוסיפים סניף, מופיעה בראש המסך בחירה בין "כל הסניפים" לסניף אחד, וכל רשימה ודוח מוצגים לפיה. כשמוסיפים קופה, הקופה שואלת באיזו קופה המכשיר
          עומד, וסגירת היום נעשית לכל קופה בנפרד. המספור של המסמכים נשאר אחד לכל העסק.
        </Note></div>
      )}
      <div className="grid gap-4">
        {state.locations.map((l) => {
          const regs = state.registers.filter((r) => r.locationId === l.id);
          return (
            <Card key={l.id} className={cx('p-4', !l.active && 'opacity-70')}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-display text-lg font-extrabold">{l.name} <span className="text-sm font-semibold text-muted">· {KIND_HE[l.kind]}</span></p>
                  <p className="text-sm text-muted">{[l.address, l.phone].filter(Boolean).join(' · ') || 'בלי כתובת'}{l.main ? ' · הסניף הראשי' : ''}</p>
                  {l.hours && <p className="text-sm text-muted">שעות: {l.hours}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!l.active && <Pill tone="warn">סגור</Pill>}
                  {owner && <Button size="sm" variant="ghost" onClick={() => setEditLoc({ ...l })}>עריכה</Button>}
                  {owner && (l.active ? state.locations.filter((x) => x.active).length > 1 : true) &&
                    <Button size="sm" variant="ghost" onClick={() => void toggleLocation(l)}>{l.active ? 'סגירת הסניף' : 'פתיחה מחדש'}</Button>}
                </div>
              </div>
              <ul className="mt-3 grid gap-1.5">
                {regs.map((r) => (
                  <li key={r.id} className={cx('flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-surface-2 px-3 py-2 text-sm', !r.active && 'opacity-70')}>
                    <span className="min-w-0"><strong>{r.name}</strong>{r.device ? ` · ${r.device}` : ''}{!r.active ? ' · סגורה' : ''}</span>
                    {owner && <span className="flex gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setEditReg({ ...r })}>עריכה</Button>
                      <Button size="sm" variant="ghost" onClick={() => void toggleRegister(r)}>{r.active ? 'סגירה' : 'פתיחה'}</Button>
                    </span>}
                  </li>
                ))}
                {!regs.length && <li className="text-sm text-muted">{l.kind === 'warehouse' ? 'מחסן — בלי קופה.' : 'אין קופה בסניף הזה.'}</li>}
              </ul>
              {owner && l.active && regs.length < MAX_REGISTERS && (
                <Button size="sm" className="mt-3" onClick={() => setEditReg(newRegister(l))}>+ קופה</Button>
              )}
            </Card>
          );
        })}
      </div>

      {editLoc && <LocationEditor value={editLoc} others={state.locations} onClose={() => setEditLoc(null)}
        onSaved={async (name, created) => { setEditLoc(null); await load(); say(created ? `"${name}" נוסף. בראש המסך אפשר לבחור בו.` : `"${name}" נשמר.`); }} />}
      {editReg && <RegisterEditor value={editReg} others={state.registers} onClose={() => setEditReg(null)}
        onSaved={async (name, created) => { setEditReg(null); await load(); say(created ? `"${name}" נוספה.` : `"${name}" נשמרה.`); }} />}
    </>
  );
}

function LocationEditor({ value, others, onClose, onSaved }: { value: LocationInput; others: Location[]; onClose: () => void; onSaved: (name: string, created: boolean) => void }) {
  const [f, setF] = useState(value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof LocationInput>(k: K, v: LocationInput[K]) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    const e = locationError(f, others);
    if (e) return setErr(e);
    setBusy(true);
    const r = await saveLocation(f);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onSaved(f.name.trim(), r.created);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-4 font-display text-xl font-extrabold">{value.id ? `עריכת "${value.name}"` : 'סניף חדש'}</h3>
      <Field label="שם"><Input value={f.name} maxLength={60} onChange={(e) => set('name', e.target.value)} placeholder="למשל: סניף דיזנגוף" /></Field>
      <div className="mb-4">
        <p className="mb-2 text-sm font-semibold text-ink-2">סוג</p>
        <div role="radiogroup" aria-label="סוג" className="flex flex-wrap gap-1.5">
          {KINDS.map((k) => <Chip key={k} role="radio" aria-checked={f.kind === k} on={f.kind === k} onClick={() => set('kind', k)}>{KIND_HE[k]}</Chip>)}
        </div>
        {!value.id && f.kind === 'warehouse' && <p className="mt-2 text-xs text-muted">למחסן אין קופה. אפשר להוסיף לו קופה אחר כך.</p>}
      </div>
      <Field label="כתובת"><Input value={f.address} maxLength={200} onChange={(e) => set('address', e.target.value)} /></Field>
      <Field label="טלפון"><Input value={f.phone} maxLength={20} inputMode="tel" dir="ltr" onChange={(e) => set('phone', e.target.value)} /></Field>
      <Field label="שעות פתיחה (לא חובה)"><Textarea value={f.hours} maxLength={300} className="min-h-[70px]" onChange={(e) => set('hours', e.target.value)} placeholder="א׳–ה׳ 9:00–20:00, ו׳ 9:00–14:00" /></Field>
      {err && <p role="alert" className="mb-3 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'שומר…' : value.id ? 'שמירה' : 'הוספת הסניף'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

function RegisterEditor({ value, others, onClose, onSaved }: { value: RegisterInput; others: Register[]; onClose: () => void; onSaved: (name: string, created: boolean) => void }) {
  const [f, setF] = useState(value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const e = registerError(f, others);
    if (e) return setErr(e);
    setBusy(true);
    const r = await saveRegister(f);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onSaved(f.name.trim(), r.created);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-4 font-display text-xl font-extrabold">{value.id ? `עריכת "${value.name}"` : 'קופה חדשה'}</h3>
      <Field label="שם הקופה"><Input value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="המכשיר (לא חובה)"><Input value={f.device} maxLength={80} onChange={(e) => setF({ ...f, device: e.target.value })} placeholder="למשל: טאבלט בדלפק" /></Field>
      <p className="mb-4 text-xs text-muted">כל מכשיר זוכר את הקופה שנבחרה בו. סגירת יום נעשית לכל קופה בנפרד.</p>
      {err && <p role="alert" className="mb-3 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'שומר…' : value.id ? 'שמירה' : 'הוספת הקופה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
