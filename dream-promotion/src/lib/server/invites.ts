import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { INVITE_HOURS } from '@/features/admin/invite';

/**
 * Invitations by link (2.114, migration 6500 — features/admin/invite.ts). member_invites is the server's only: the super admin's
 * route writes it (`createInvite`), the public /api/join/<token> reads and takes it (`readInvite`, `takeInvite`). The token is
 * in the link only; the table keeps its sha-256.
 */
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export type InviteRow = {
  id: string; business_id: string; user_id: string; access: string; phone: string | null;
  expires_at: string; used_at: string | null; revoked_at: string | null;
};
export type InviteState = 'ok' | 'not_found' | 'used' | 'expired' | 'revoked';

export const NO_INVITES = 'צריך להריץ את מיגרציה 20261105006500 (הזמנה בלינק).';
export const invitesMissing = (e: { code?: string; message?: string } | null | undefined) =>
  Boolean(e && (e.code === '42P01' || /member_invites/.test(e.message ?? '')));

/** a new link for this person in this business — the open ones before it stop working */
export async function createInvite(db: SupabaseClient, v: { business: string; user: string; access: string; phone: string | null; by: string }, now = Date.now()) {
  const at = new Date(now).toISOString();
  const revoke = await db.from('member_invites').update({ revoked_at: at })
    .eq('business_id', v.business).eq('user_id', v.user).is('used_at', null).is('revoked_at', null);
  if (revoke.error) return { error: revoke.error } as const;
  const token = randomBytes(32).toString('hex'), hash = hashToken(token);
  const expiresAt = new Date(now + INVITE_HOURS * 3600_000).toISOString();
  const { error } = await db.from('member_invites').insert({
    business_id: v.business, user_id: v.user, token_hash: hash, access: v.access, phone: v.phone, created_by: v.by, expires_at: expiresAt,
  });
  return error ? { error } as const : { token, expiresAt } as const;
}

export const inviteState = (r: Pick<InviteRow, 'expires_at' | 'used_at' | 'revoked_at'> | null, now = Date.now()): InviteState =>
  !r ? 'not_found' : r.used_at ? 'used' : r.revoked_at ? 'revoked' : Date.parse(r.expires_at) <= now ? 'expired' : 'ok';

export async function readInvite(db: SupabaseClient, token: string): Promise<{ row: InviteRow | null; state: InviteState }> {
  const { data } = await db.from('member_invites').select('id, business_id, user_id, access, phone, expires_at, used_at, revoked_at')
    .eq('token_hash', hashToken(token)).maybeSingle();
  const row = (data as InviteRow | null) ?? null;
  return { row, state: inviteState(row) };
}

/** the link is used now — once: a conditional update, so two taps at once take it once */
export async function takeInvite(db: SupabaseClient, id: string, now = Date.now()): Promise<boolean> {
  const at = new Date(now).toISOString();
  const { data } = await db.from('member_invites').update({ used_at: at })
    .eq('id', id).is('used_at', null).is('revoked_at', null).gt('expires_at', at).select('id');
  return Array.isArray(data) && data.length === 1;
}
