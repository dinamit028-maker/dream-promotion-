import type { SupabaseClient } from '@supabase/supabase-js';

/** a LIKE pattern that matches only this exact text — an address may hold "_" or "%", which LIKE reads as wildcards */
export const likeExact = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The person who signed up with this email, for the super admin's "add owner / member". profiles.email is the user's own
 * row (a user could write someone else's address into it), so it only points the way: the sign-in record decides — the
 * same address, confirmed. Before 2.52.1 the profile alone decided (and "_" in an address matched any character).
 */
export async function signedUpUser(db: SupabaseClient, email: string): Promise<string | null> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) return null;
  const { data } = await db.from('profiles').select('id').ilike('email', likeExact(e)).limit(10);
  for (const row of (data ?? []) as { id: string }[]) {
    const { data: found } = await db.auth.admin.getUserById(row.id);
    const u = found?.user;
    if (u && (u.email ?? '').toLowerCase() === e && (u.email_confirmed_at || u.confirmed_at)) return u.id;
  }
  return null;
}
