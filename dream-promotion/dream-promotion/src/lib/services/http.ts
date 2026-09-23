import { useApp } from '@/lib/store';

/** Headers for every paid call. Carries the access code when the server requires one. */
export function authHeaders(): Record<string, string> {
  const code = useApp.getState().accessCode;
  return code ? { 'Content-Type': 'application/json', 'x-access-code': code } : { 'Content-Type': 'application/json' };
}
