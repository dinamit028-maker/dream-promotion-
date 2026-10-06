import { adminDb } from '@/lib/server/admin';
import { registerOnly, workBusiness } from '@/lib/server/business';
import { isUuid } from '@/features/catalog/images';
import type { PageFacts } from '@/features/store/page-ai';
import type { PolicyKind } from '@/features/store/store';

const POLICIES: PolicyKind[] = ['returns', 'privacy', 'accessibility', 'shipping', 'terms'];

/**
 * What the AI may know when it drafts a page of the store (2.59): the store's own details, read here on the server for the
 * business the user works in — never from the browser, and never orders, customers or money. Null: no store (or a cashier).
 */
export async function pageFacts(userId: string, p: Record<string, unknown>): Promise<PageFacts | null> {
  if (await registerOnly(userId)) return null;
  const business = await workBusiness(userId);
  if (!isUuid(business)) return null;
  const db = adminDb();
  const { data: s } = await db.from('stores').select('*').eq('business_id', business).maybeSingle();
  if (!s) return null;
  const { data: r } = await db.from('register_settings').select('legal_name, dealer_number, company_number, entity_type').eq('business_id', business).maybeSingle();
  const st = s as any, rs = (r ?? {}) as any;
  const company = rs.entity_type === 'company' || (!rs.dealer_number && rs.company_number);
  const kind = p.kind === 'policy' ? 'policy' : 'page';
  const policy = kind === 'policy' && POLICIES.includes(p.policy as PolicyKind) ? (p.policy as PolicyKind) : null;
  return {
    kind: policy ? 'policy' : 'page', policy, title: String(p.title ?? '').slice(0, 120), current: String(p.current ?? '').slice(0, 6000),
    store: {
      name: st.name ?? '', legalName: rs.legal_name ?? '', number: (company ? rs.company_number : rs.dealer_number) || rs.company_number || '',
      numberKind: company ? 'company' : 'dealer', address: st.address ?? '', phone: st.phone ?? '', email: st.email ?? '', whatsapp: st.whatsapp ?? '',
      country: st.country || 'IL', description: String(st.description ?? '').slice(0, 500),
    },
    selling: {
      checkout: Boolean(st.checkout_enabled), delivery: Boolean(st.delivery_enabled), deliveryPrice: Number(st.delivery_price ?? 0),
      freeDeliveryOver: st.free_delivery_over == null ? null : Number(st.free_delivery_over), deliveryNote: String(st.delivery_note ?? '').slice(0, 300),
      pickup: Boolean(st.pickup_enabled), pickupNote: String(st.pickup_note ?? '').slice(0, 300),
    },
    analytics: Boolean(st.ga4_id),
  };
}
