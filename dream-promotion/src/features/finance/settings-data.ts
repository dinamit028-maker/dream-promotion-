'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';

/**
 * 2.118 (migration 20261125006800 — the accountant's answer 17): register_settings.deductions_file, the business's deductions file
 * number (field 1016 of the unified file). Until the migration is in the database the column is not there: the settings screen does
 * not show the field and never sends it (a save with it would be refused), and the export writes 0, as before. Asked once a page
 * (the column answers), like cashReady / reportsReady.
 */
let ready: Promise<boolean> | null = null;
export function deductionsReady(): Promise<boolean> {
  // only "the column is there" is kept: a failure (no network, a timeout) is asked again on the next call — "not there" only for
  // the database's own answer that the column does not exist (42703, or PostgREST's schema cache)
  ready ??= Promise.resolve(supabase().from('register_settings').select('deductions_file').limit(1)).then(({ error }) => {
    if (!error) return true;
    const missing = error.code === '42703' || /does not exist|schema cache|PGRST204/i.test(String(error.message ?? ''));
    if (!missing) ready = null;
    return false;
  }, () => { ready = null; return false; });
  return ready;
}
export function useDeductionsReady(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => { let alive = true; void deductionsReady().then((v) => { if (alive) setOk(v); }); return () => { alive = false; }; }, []);
  return ok;
}
