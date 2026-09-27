import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;
/** Service-role client — server only. */
export function adminDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured');
  if (!client) client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
/** The signed-in user behind a request's Bearer token, or null. */
export async function userFromRequest(req: Request): Promise<string | null> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const { data } = await adminDb().auth.getUser(token);
    return data.user?.id ?? null;
  } catch { return null; }
}
