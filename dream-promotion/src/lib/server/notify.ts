import { pushToUser } from './push';
import { businessManagers } from './business';

/**
 * A phone notification to the business's managers (full-access members) — with no signed-in user: a sale of the register
 * (/api/notify/sale) and the store's alerts (an order on the site, a document that was not issued, a customer's request).
 */
export async function notifyManagers(businessId: string, payload: { title: string; body: string; url?: string; tag?: string }, fallbackUser?: string) {
  const managers = await businessManagers(businessId);
  const to = managers.length ? managers : fallbackUser ? [fallbackUser] : [];
  let sent = 0;
  for (const u of to) sent += (await pushToUser(u, payload)).sent ?? 0;
  return { sent, to };
}
