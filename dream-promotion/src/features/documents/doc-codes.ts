import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';
import { docCodesMap } from './openformat';

/**
 * The people's codes for field 1233 of the unified file (operatorOf): member_doc_codes of the business the user works in (its
 * RLS — finance members only). Until migration 20261122006700 is in the database — or on any other failure — none: the export
 * goes on, with 1233 as before (empty), never an error.
 */
export async function loadDocCodes(db: () => Pick<SupabaseClient, 'from'> = supabase): Promise<Map<string, string>> {
  try {
    const { data, error } = await db().from('member_doc_codes').select('user_id, code').range(0, 9999);
    return error ? new Map() : docCodesMap(data);
  } catch {
    return new Map();
  }
}
