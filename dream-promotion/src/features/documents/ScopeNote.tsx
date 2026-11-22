'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/primitives';
import { showSwitch } from '@/features/locations/locations';
import { useLocations } from '@/features/locations/store';
import { SCOPE_SHOW_ALL, offerShowAll, type ExportScope } from './export-scope';

/**
 * Why the Tax Authority's file was not made (export-scope.ts). "בחרו 'כל הסניפים' במתג" when there is no switch at the top (one active
 * location left, a closed one still picked) comes with a button that does what the switch does: "all locations" (the app reloads).
 * Nothing at all when the file may be made — a business with one location sees the screen as before.
 */
export function ScopeNote({ scope }: { scope: ExportScope | null }) {
  const state = useLocations((x) => x.state);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!scope || scope.ok) return null;
  async function showAll() {
    setBusy(true);
    const e = await useLocations.getState().select(null);
    if (e) { setBusy(false); setErr(`לא הצלחנו להציג את כל הסניפים: ${e}`); }
  }
  return (
    <div role="alert" className="mt-2 text-sm text-warn">
      <p>{scope.message}</p>
      {offerShowAll(scope, showSwitch(state)) && <Button size="sm" variant="ghost" className="mt-1" disabled={busy} onClick={() => void showAll()}>{SCOPE_SHOW_ALL}</Button>}
      {err && <p>{err}</p>}
    </div>
  );
}
