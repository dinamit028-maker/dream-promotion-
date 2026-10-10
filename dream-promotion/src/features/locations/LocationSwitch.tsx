'use client';
import { useState } from 'react';
import { Field, Select } from '@/components/ui/primitives';
import { cx } from '@/lib/utils';
import { defaultLocation, locationChoices, showSwitch, switchOptions, type LocationState } from './locations';
import { useLocations } from './store';

/**
 * The switch at the top of the screen (T12א): "כל הסניפים" or one location — shown only when there is a choice (more than one
 * active location the user may use). Picking reloads the app: the database then shows that location's rows only.
 */
export function LocationSwitch({ className = 'h-9 max-w-[42vw]' }: { className?: string }) {   // the caller's size replaces this one
  const state = useLocations((x) => x.state);
  const [busy, setBusy] = useState(false);
  if (!showSwitch(state)) return null;
  async function pick(id: string) {
    setBusy(true);
    const err = await useLocations.getState().select(id || null);
    if (err) { setBusy(false); window.alert(`לא הצלחנו לעבור סניף: ${err}`); }
  }
  return (
    <select aria-label="הסניף שעובדים בו" value={state.current ?? ''} disabled={busy} onChange={(e) => void pick(e.target.value)}
      className={cx('rounded-full border border-line bg-surface px-3 text-sm font-semibold', className)}>
      {switchOptions(state).map((o) => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/**
 * A form's location: a field only when there is a choice to make (several locations and "כל הסניפים" picked); otherwise nothing —
 * the row goes to the location picked, or the main one (the database decides when nothing is sent).
 */
export function LocationField({ value, onChange, label = 'סניף' }: { value: string | null; onChange: (id: string) => void; label?: string }) {
  const state = useLocations((x) => x.state);
  const choices = locationChoices(state);
  if (!choices.length) return null;
  return (
    <Field label={label}>
      <Select value={value ?? defaultLocation(state) ?? ''} onChange={(e) => onChange(e.target.value)}>
        {choices.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </Select>
    </Field>
  );
}
/** the column a new row carries: the location chosen in the form when there was a choice — else none (the database fills it) */
export function locationColumn(state: LocationState, chosen: string | null): { location_id?: string } {
  const id = locationChoices(state).length ? chosen ?? defaultLocation(state) : null;
  return id ? { location_id: id } : {};
}
