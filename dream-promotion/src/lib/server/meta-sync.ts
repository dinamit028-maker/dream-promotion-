/**
 * What a Meta (re)connection does to the stored pages and Instagram accounts — pure, so it is tested.
 * Rules (multi-business, stage 3):
 *  - every page / Instagram account the approval returned is upserted by (provider, external_id);
 *    an existing one keeps its business and its creator, and gets the fresh token + this connection
 *  - a new one is stored WITHOUT a business ("לא משויך") until the super admin assigns it
 *  - nothing is ever deleted: an asset this connection used to cover that did not come back is
 *    marked 'missing' (the approval no longer includes it), and comes back to 'active' on reconnect
 */
export type Provider = 'facebook' | 'instagram';
export interface ReturnedAsset { provider: Provider; externalId: string; name: string; avatar: string | null; token: string }
export interface StoredAsset {
  id: string; provider: string; externalId: string; userId: string; businessId: string | null;
  connectionId: string | null; status: 'active' | 'missing'; name: string | null;
}

export interface SyncPlan {
  insert: { provider: Provider; external_id: string; display_name: string; avatar_url: string | null; access_token: string; user_id: string; business_id: null; connection_id: string; status: 'active'; scope: 'full' }[];
  update: { id: string; display_name: string; avatar_url: string | null; access_token: string; connection_id: string; status: 'active'; missing_since: null; scope: 'full' }[];
  missing: { id: string; name: string | null }[];
}

/** a Page's answer from /me/accounts → the page itself and its linked Instagram account (same token) */
export function assetsFromPages(pages: { id: string; name: string; access_token: string; picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string } }[]): ReturnedAsset[] {
  return pages.flatMap((p) => {
    const out: ReturnedAsset[] = [{ provider: 'facebook', externalId: p.id, name: p.name, avatar: p.picture?.data?.url ?? null, token: p.access_token }];
    const ig = p.instagram_business_account;
    if (ig?.id) out.push({ provider: 'instagram', externalId: ig.id, name: ig.username ? `@${ig.username}` : p.name, avatar: ig.profile_picture_url ?? null, token: p.access_token });
    return out;
  });
}

/**
 * @param stored every stored facebook/instagram asset (any business)
 * @param connectingUser the app user who just approved (the super admin)
 * Assets this connection is responsible for: the ones already linked to it, plus — the first time,
 * before any link existed — the ones this same app user connected the old way (connection_id null).
 */
export function planMetaSync(stored: StoredAsset[], returned: ReturnedAsset[], connectionId: string, connectingUser: string, seal: (t: string) => string = (t) => t): SyncPlan {
  const key = (p: string, id: string) => `${p}:${id}`;
  const byKey = new Map(stored.map((s) => [key(s.provider, s.externalId), s]));
  const seen = new Set<string>();
  const plan: SyncPlan = { insert: [], update: [], missing: [] };
  for (const r of returned) {
    const k = key(r.provider, r.externalId);
    if (seen.has(k)) continue;
    seen.add(k);
    const s = byKey.get(k);
    if (s) plan.update.push({ id: s.id, display_name: r.name, avatar_url: r.avatar, access_token: seal(r.token), connection_id: connectionId, status: 'active', missing_since: null, scope: 'full' });
    else plan.insert.push({ provider: r.provider, external_id: r.externalId, display_name: r.name, avatar_url: r.avatar, access_token: seal(r.token), user_id: connectingUser, business_id: null, connection_id: connectionId, status: 'active', scope: 'full' });
  }
  for (const s of stored) {
    if (s.provider !== 'facebook' && s.provider !== 'instagram') continue;
    if (seen.has(key(s.provider, s.externalId)) || s.status === 'missing') continue;
    const mine = s.connectionId === connectionId || (s.connectionId === null && s.userId === connectingUser);
    if (mine) plan.missing.push({ id: s.id, name: s.name });
  }
  return plan;
}

/** the banner for assets that fell out of the approval */
export const missingBanner = (name: string | null) =>
  `העמוד ${name ?? ''} נותק. בחיבור מחדש בחרו 'כל הדפים הנוכחיים והעתידיים'`.replace(/\s+/g, ' ');
