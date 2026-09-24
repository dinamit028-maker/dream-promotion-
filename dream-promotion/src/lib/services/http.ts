import { useApp } from '@/lib/store';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';

/** Headers for every paid call: the signed-in session, plus the access code if one was typed. */
export async function authHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const code = useApp.getState().accessCode;
  if (code) h['x-access-code'] = code;
  if (isCloudConfigured) {
    try {
      const { data } = await supabase().auth.getSession();
      if (data.session?.access_token) h.Authorization = `Bearer ${data.session.access_token}`;
    } catch { /* no session */ }
  }
  return h;
}
