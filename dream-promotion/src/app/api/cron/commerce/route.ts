import { NextResponse } from 'next/server';
import { finalizePending, pushStoreAlerts, sendQueuedEmails } from '@/lib/server/commerce';
import { paylinksCron } from '@/lib/server/paylinks';
import { recurringCron } from '@/lib/server/recurring';
import { remindersCron } from '@/lib/server/reminders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Timer: every 2 minutes (Supabase pg_cron → supabase/cron-commerce.sql). Paid orders of the site whose sale or document
 * was not finished (the storefront's call was lost, the dashboard was down, a temporary error), the owners' alerts, and
 * the customers' emails. A blocked document is not retried here — only after the owner's "נסו שוב".
 * Payment links (migration 4300): links past their time expire, and the receipts of real payments that wait for the
 * server are issued (a link's email goes out with the other emails).
 * Debt reminders (migration 4400): what is due is queued — for a business whose owner turned them on, on the hours customers
 * expect a message; an email goes out with the other emails (asked again just before), a WhatsApp one waits for the owner.
 * Recurring charges (migration 4500): each plan's period is charged once on its day (08:00–20:00, not on Saturday) — an invoice
 * (with its payment link, when the terminal is ready) or a draft for the owner; a link's email goes out with the other emails.
 */
function allowed(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret;
}
export async function POST(req: Request) { return GET(req); }
export async function GET(req: Request) {
  if (!allowed(req)) return NextResponse.json({ code: 'forbidden' }, { status: 403 });
  try {
    const orders = await finalizePending(Date.now() + 35_000);
    const links = await paylinksCron(Date.now() + 10_000).catch((e) => { console.error('[cron/commerce] paylinks', e?.message ?? e); return null; });
    const reminders = await remindersCron().catch((e) => { console.error('[cron/commerce] reminders', e?.message ?? e); return null; });
    const recurring = await recurringCron(new Date(), Date.now() + 10_000).catch((e) => { console.error('[cron/commerce] recurring', e?.message ?? e); return null; });
    const pushed = await pushStoreAlerts();
    const emails = await sendQueuedEmails();
    return NextResponse.json({ orders: orders.length, errors: orders.filter((o) => o.error).map((o) => ({ order: o.order, error: o.error })), pushed, emails,
      paylinks: links ? { expired: links.expired, receipts: links.receipts.length, errors: links.receipts.filter((r) => r.error).map((r) => r.error) } : null,
      reminders, recurring });
  } catch (e: any) {
    console.error('[cron/commerce]', e?.message ?? e);
    return NextResponse.json({ code: 'error', message: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
