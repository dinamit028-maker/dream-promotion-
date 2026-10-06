import type { PaymentKeys } from '../seal';

/**
 * A payment provider, as the checkout uses it (DREAM_COMMERCE_ARCHITECTURE §6.4): a payment page of the provider (a full
 * redirect: no card detail ever passes through the store), and a direct question about a page — the only thing that can
 * make an order paid. A notice from the provider only starts that question.
 */
export interface PageRequest {
  orderId: string; number: number; amount: number; currency: string;
  customer: { name: string; email: string; phone: string };
  successUrl: string; failureUrl: string; callbackUrl: string;
  storeName: string;
}
export interface Verified {
  status: 'approved' | 'declined' | 'pending';
  txn: string;              // the provider's transaction (empty while there is none)
  amount: number | null;
  currency: string;
  orderId: string;          // what the provider says the page was for (our order id, sent with the page)
  detail: string;           // the provider's own words, for the log
}
export interface Notice {
  signature: boolean | null; // null: the provider sent no signature
  page: string;              // the provider's page id it is about
  orderId: string;
}
export interface Provider {
  id: 'payplus' | 'mock';
  createPage(keys: PaymentKeys, pageUid: string, test: boolean, req: PageRequest): Promise<{ url: string; page: string }>;
  verify(keys: PaymentKeys, test: boolean, page: string): Promise<Verified>;
  readNotice(keys: PaymentKeys, body: string, headers: Headers): Notice;
}
export class ProviderError extends Error {}
