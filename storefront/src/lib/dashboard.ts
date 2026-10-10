/**
 * The storefront tells the dashboard's server that an order was paid, so the sale, the document, the owner's alert and the
 * customer's email happen now (Dream Commerce stage 4). Env: DASHBOARD_URL and COMMERCE_SECRET (the same value in both
 * Vercel projects). Never waited on by the shopper, never fatal: the dashboard's cron finishes whatever this missed.
 */
export async function notifyPaid(orderId: string): Promise<boolean> {
  const base = (process.env.DASHBOARD_URL ?? '').replace(/\/+$/, '');
  const secret = process.env.COMMERCE_SECRET ?? '';
  if (!/^https?:\/\//.test(base) || secret.length < 16) return false;
  try {
    const r = await fetch(`${base}/api/commerce/finalize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-commerce-secret': secret },
      body: JSON.stringify({ orderId }), cache: 'no-store', signal: AbortSignal.timeout(25_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * A payment link was paid for real (migration 4300): the dashboard's server issues its receipt now (or keeps it for the owner's
 * approval). Never waited on by the customer, never fatal: the dashboard's cron issues whatever this missed.
 */
export async function notifyPaylinkPaid(requestId: string): Promise<boolean> {
  const base = (process.env.DASHBOARD_URL ?? '').replace(/\/+$/, '');
  const secret = process.env.COMMERCE_SECRET ?? '';
  if (!/^https?:\/\//.test(base) || secret.length < 16) return false;
  try {
    const r = await fetch(`${base}/api/finance/paylinks/finalize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-commerce-secret': secret },
      body: JSON.stringify({ requestId }), cache: 'no-store', signal: AbortSignal.timeout(25_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** the document's PDF, from the dashboard, by its share token — served on the business's own domain */
export async function documentPdf(docToken: string): Promise<Response | null> {
  const base = (process.env.DASHBOARD_URL ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base) || !/^[0-9a-f]{32,128}$/.test(docToken)) return null;
  try {
    const r = await fetch(`${base}/api/doc/${docToken}/pdf`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    return r.ok ? r : null;
  } catch {
    return null;
  }
}
