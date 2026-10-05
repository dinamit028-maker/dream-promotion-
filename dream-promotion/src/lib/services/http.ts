import { useApp } from '@/lib/store';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';

/**
 * The reel / post the user is working on. Every paid call carries it (x-dp-content), so the
 * server can add each generation's cost to that project. Set by the reel studio.
 */
let workingOn: string | null = null;
export function setGenerationContext(contentId: string | null) { workingOn = contentId; }

/** Headers for every paid call: the signed-in session, plus the access code if one was typed. */
export async function authHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (workingOn) h['x-dp-content'] = workingOn;
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

/** The same headers for a FormData body: the browser writes the multipart Content-Type (with its boundary) itself —
 *  a JSON Content-Type there makes the server see no file at all (2.52.1: every receipt scan failed that way). */
export async function authHeadersForForm(): Promise<Record<string, string>> {
  const { 'Content-Type': _json, ...h } = await authHeaders();
  return h;
}
