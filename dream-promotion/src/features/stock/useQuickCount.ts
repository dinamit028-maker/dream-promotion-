'use client';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { useLocations } from '@/features/locations/store';
import { isBusinessOwner } from '@/features/finance/plans-data';
import { quickCountAllowed } from './stock-locations';

/**
 * "ספירה" next to a product (in the register's price list and in the product editor) and "סיום ספירה": offered to the owner only
 * (the owner's decision, 11.10.2026) — anyone else counts in a stock count, which the owner approves. The database refuses anyone
 * else too (migration 4700). null while it is not known yet: nothing is offered until then.
 */
export function useQuickCount(): boolean | null {
  const loc = useLocations((s) => s.state);
  const loaded = useLocations((s) => s.loaded);
  const load = useLocations((s) => s.load);
  const userId = useApp((s) => s.userId);
  const businessId = useApp((s) => s.businessId);
  const [member, setMember] = useState<boolean | null>(null);
  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  // before migration 4600 there is no answer of the database: the member's role (the owner, with full access)
  useEffect(() => {
    if (!loaded || loc.ready || !userId) return;
    let alive = true;
    isBusinessOwner(userId, businessId).then((v) => { if (alive) setMember(v); }, () => { if (alive) setMember(false); });
    return () => { alive = false; };
  }, [loaded, loc.ready, userId, businessId]);
  return quickCountAllowed(loaded ? loc : null, member);
}
