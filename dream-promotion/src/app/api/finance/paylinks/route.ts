import { financeCaller } from '@/lib/server/finance';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { appOrigin, approvePaylinkReceipt, cancelPaylink, isUuid, linkText, resendPaylink, sendPaylink } from '@/lib/server/paylinks';
import type { PaylinkKind, PaylinkVia } from '@/features/finance/paylinks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "שלח לינק לתשלום" (docs/FINANCE_ADDITIONS_HE.md T2; migration 4300). Money: financeCaller with write — a member who may
 * write (never a cashier, a viewer or a locked business); the business is the server's. The database checks the rest.
 *   {action: 'send', kind, target, amount, days, via, packageId?} → {link, url, text, emailed}
 *       kind document (an open invoice — packageId: it is a package's), quote (accepted), deposit (an appointment: the
 *       service's amount, whatever was typed)
 *   {action: 'resend', id, via}   → {url, text, emailed}   the same link again, counted
 *   {action: 'cancel', id, reason?}                         a link not paid yet
 *   {action: 'receipt', id}       → {receipt}              "הפקת הקבלה": approve a receipt that waits, or try a blocked one again
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string) => json(400, { code: 'bad_request', message });
const KINDS: PaylinkKind[] = ['document', 'quote', 'deposit'];
const VIAS: PaylinkVia[] = ['whatsapp', 'email', 'link'];

export async function POST(req: Request) {
  const limited = rateLimited(req, 'paylinks', 30, MINUTE);
  if (limited) return limited;
  const c = await financeCaller(req, { write: true });
  if (!c.ok) return json(c.status, c.body);
  const body = await req.json().catch(() => null) as Record<string, any> | null;
  if (!body) return bad('בקשה לא תקינה.');
  const via = VIAS.includes(body.via) ? (body.via as PaylinkVia) : 'link';
  try {
    if (body.action === 'send') {
      if (!KINDS.includes(body.kind) || !isUuid(body.target)) return bad('לא ברור על מה הלינק.');
      if (body.packageId != null && !isUuid(body.packageId)) return bad('לא ברור על מה הלינק.');
      const amount = Number(body.amount ?? 0), days = Number(body.days ?? 7);
      if (body.kind !== 'deposit' && !(amount > 0)) return bad('הסכום חייב להיות גדול מאפס.');
      if (!Number.isInteger(days) || days < 1 || days > 30) return bad('לינק בתוקף בין יום אחד ל-30 ימים.');
      const r = await sendPaylink({ businessId: c.businessId, userId: c.userId },
        { kind: body.kind, target: body.target, amount: Math.round(amount * 100) / 100, days, via, packageId: body.packageId ?? null }, appOrigin(req));
      if (!r.ok) return json(r.status, { code: 'refused', message: r.message });
      return json(200, { link: r.link, url: r.url, emailed: r.emailed, text: await linkText(c.businessId, r.link as any, r.url) });
    }
    if (!isUuid(body.id)) return bad('הלינק לא נמצא.');
    if (body.action === 'resend') {
      const r = await resendPaylink({ businessId: c.businessId }, body.id, via, appOrigin(req));
      if (!r.ok) return json(r.status, { code: 'refused', message: r.message });
      return json(200, { url: r.url, emailed: r.emailed, text: await linkText(c.businessId, r.link as any, r.url) });
    }
    if (body.action === 'cancel') {
      const r = await cancelPaylink({ businessId: c.businessId, userId: c.userId }, body.id, String(body.reason ?? ''));
      return r.ok ? json(200, { result: r.result }) : json(r.status, { code: 'refused', message: r.message });
    }
    if (body.action === 'receipt') {
      const r = await approvePaylinkReceipt({ businessId: c.businessId, userId: c.userId }, body.id);
      return r.ok ? json(200, r.receipt) : json(r.status, { code: 'refused', message: r.message });
    }
  } catch (e: any) {
    console.error('[finance/paylinks]', e?.message ?? e);
    return json(500, { code: 'error', message: 'משהו השתבש. נסו שוב.' });
  }
  return bad('פעולה לא מוכרת.');
}
