import { after } from 'next/server';
import { data } from '@/lib/data';
import { notifyLead } from '@/lib/dashboard';
import { LEAD_ERRORS, LEAD_SENT, readLead } from '@/lib/leads';
import { readJson, sameOrigin } from '@/lib/request';
import { allowed } from '@/lib/shop';
import { getSite, hostOf } from '@/lib/site';
import { isFullStore } from '@/lib/types';

/**
 * A request of the site (2.102): "בקשת הצעת מחיר" of a product sold by a quote, or the contact form → the business's leads
 * (sf_lead_request — a new contact, or a note on the card of the one with the same phone). Then the dashboard's server is told,
 * after the answer, so it routes the request to its department and person on WhatsApp (its cron does it if this call is lost).
 * The store comes from the host only; a form of another site is refused; a few requests per shopper in ten minutes.
 */
type Ctx = { params: Promise<{ host: string }> };
const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request, { params }: Ctx) {
  const fail = (error: string, status = 200, extra: Record<string, unknown> = {}) =>
    answer({ ok: false, error, message: LEAD_ERRORS[error] ?? LEAD_ERRORS.bad_request, ...extra }, status);
  if (!sameOrigin(req)) return fail('bad_request', 403);
  const site = await getSite(hostOf((await params).host));
  if (!site?.live || !isFullStore(site.store)) return fail('store', 404);
  if (!(await allowed(req, site, 'lead', 5, 600))) return fail('rate', 429);
  const body = await readJson(req);
  if (!body) return fail('bad_request', 400);
  if (typeof body.website === 'string' && body.website.trim() !== '') return fail('bot');
  const read = readLead(body);
  if (!read.ok) return read.error === 'details' ? fail('details', 200, { fields: read.fields }) : fail('bad_request', 400);
  const i = read.input;
  let r;
  try {
    r = await data.leadRequest(site.storeId, i.request, i.kind, i.item, { name: i.name, phone: i.phone, email: i.email },
      { qty: i.qty, topic: i.topic, notes: i.notes, model: i.model, page: i.page }, site.preview);
  } catch {
    return fail('error', 503);
  }
  if (!r) return fail('error', 503);
  if (!r.ok) return fail(r.error, 200, r.fields ? { fields: r.fields } : {});
  if (!r.already) {
    const job = () => notifyLead(i.request).then(() => undefined);
    try { after(job); } catch { void job().catch(() => undefined); }
  }
  return answer({ ok: true, message: LEAD_SENT[i.kind] });
}
