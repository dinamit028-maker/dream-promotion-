'use client';
import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { isCloudConfigured } from '@/lib/supabase/client';
import { PageHead } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/feedback';
import { Storefront } from '@/components/ui/Icon';

/**
 * "חנות" (Dream Commerce 2.54). The data and the permissions are the catalog's: row-level security shows the business
 * worked in now; a cashier reads the catalog in the register only (sent back there), a viewer reads and changes nothing.
 */
export function StoreLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const userId = useApp((s) => s.userId);
  const cashier = useApp((s) => s.access === 'register');
  useEffect(() => { if (cashier) router.replace('/register'); }, [cashier, router]);
  if (cashier) return null;
  if (!isCloudConfigured || !userId) {
    return (<><PageHead title="חנות" /><EmptyState icon={<Storefront />} title="החנות דורשת חשבון מחובר" body="התחברו לחשבון כדי לנהל את המוצרים." /></>);
  }
  return <>{children}</>;
}
