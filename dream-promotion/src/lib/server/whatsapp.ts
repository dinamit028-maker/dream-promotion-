import { NEW_LEAD_TEMPLATE, parseWaError, type WaError } from '@/features/crm/lead-routing';

/**
 * WhatsApp Cloud API — Dream's number writes to the team of a business (2.99: a new lead to the person responsible for its
 * department). The number, its account and the permanent token live in the server's environment only (Vercel):
 *   WHATSAPP_PHONE_NUMBER_ID   the sending number's id         WHATSAPP_WABA_ID   its WhatsApp Business Account (template state)
 *   WHATSAPP_TOKEN             a System User's permanent token — never in the code, never in a log, never in a URL (a header)
 * Without the token (or the number's id) nothing is sent: every caller gets "not_connected", and the screens say
 * "וואטסאפ לא מחובר". Only the team's template (NEW_LEAD_TEMPLATE — lead_assigned) is sent, and only to a number of lead_staff (the callers in lead-routing.ts
 * pass a person of the team; nothing here takes a customer's phone).
 */
const graph = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}`;
const token = () => (process.env.WHATSAPP_TOKEN ?? '').trim();
const numberId = () => (process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
const wabaId = () => (process.env.WHATSAPP_WABA_ID ?? '').trim();

export const whatsappConfigured = () => Boolean(token() && numberId());

export type WaSend =
  | { ok: true; http: number; messageId: string; waId: string; status: string; body: unknown }
  /** definite: Meta refused it, or it never left — safe to try again; false: no answer in time, it may have arrived */
  | { ok: false; http: number; error: WaError; definite: boolean; body: unknown };

const ours = (code: string, message: string, http = 0): WaError => ({ code, subcode: '', message, type: '', details: '', fbtrace: '', http });

/** one call to Graph with the token in a header; the answer's JSON (or null), never throws */
async function call(path: string, init: RequestInit, timeoutMs: number): Promise<{ http: number; body: any; failed?: 'timeout' | 'network'; message?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${graph()}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token()}` }, signal: ctrl.signal });
    return { http: res.status, body: await res.json().catch(() => null) };
  } catch (e: any) {
    const aborted = ctrl.signal.aborted || e?.name === 'AbortError';
    return { http: 0, body: null, failed: aborted ? 'timeout' : 'network', message: aborted ? `no answer within ${timeoutMs / 1000} s` : String(e?.cause?.code ?? e?.message ?? e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** the team's template with its 5 values to one number of the team (international digits) */
export async function sendNewLead(to: string, params: string[], timeoutMs = 8_000): Promise<WaSend> {
  if (!whatsappConfigured()) return { ok: false, http: 0, error: ours('not_connected', 'WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not set'), definite: true, body: null };
  if (!/^[1-9]\d{7,14}$/.test(to)) return { ok: false, http: 0, error: ours('invalid_recipient', 'not an international number'), definite: true, body: null };
  if (params.length !== NEW_LEAD_TEMPLATE.params) return { ok: false, http: 0, error: ours('132000', `the template takes ${NEW_LEAD_TEMPLATE.params} values`), definite: true, body: null };
  const r = await call(`/${encodeURIComponent(numberId())}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
      template: { name: NEW_LEAD_TEMPLATE.name, language: { code: NEW_LEAD_TEMPLATE.language }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] },
    }),
  }, timeoutMs);
  if (r.failed) return { ok: false, http: 0, error: ours(r.failed, r.message ?? ''), definite: r.failed === 'network', body: null };
  const id = r.body?.messages?.[0]?.id;
  if (r.http >= 200 && r.http < 300 && id) {
    return { ok: true, http: r.http, messageId: String(id), waId: String(r.body?.contacts?.[0]?.wa_id ?? ''), status: String(r.body?.messages?.[0]?.message_status ?? 'accepted'), body: r.body };
  }
  if (r.body?.error) return { ok: false, http: r.http, error: parseWaError(r.body, r.http), definite: true, body: r.body };
  // a 2xx without an id, or an answer that is not Meta's: it may have gone out
  return { ok: false, http: r.http, error: ours(r.http >= 200 && r.http < 300 ? 'no_message_id' : `http_${r.http}`, 'no message id in the answer', r.http), definite: r.http >= 400, body: r.body };
}

export type WaHealth = {
  connected: boolean;
  number?: { display: string; name: string; quality: string } | { error: WaError };
  template?: { status: string; language: string; category: string } | { missing: true } | { error: WaError };
};

/** for the owner's screen: the sending number, and the state and category of the template in Hebrew (pending / approved / rejected) */
export async function whatsappHealth(): Promise<WaHealth> {
  if (!whatsappConfigured()) return { connected: false };
  const [num, tpl] = await Promise.all([
    call(`/${encodeURIComponent(numberId())}?fields=display_phone_number,verified_name,quality_rating`, { method: 'GET' }, 6_000),
    wabaId() ? call(`/${encodeURIComponent(wabaId())}/message_templates?name=${NEW_LEAD_TEMPLATE.name}&fields=name,status,language,category&limit=50`, { method: 'GET' }, 6_000) : Promise.resolve(null),
  ]);
  const failed = (r: { http: number; body: any; failed?: string; message?: string }) =>
    r.failed ? ours(r.failed, r.message ?? '') : r.body?.error ? parseWaError(r.body, r.http) : r.http >= 400 ? ours(`http_${r.http}`, '', r.http) : null;
  const out: WaHealth = { connected: true };
  const nErr = failed(num);
  out.number = nErr ? { error: nErr } : { display: String(num.body?.display_phone_number ?? ''), name: String(num.body?.verified_name ?? ''), quality: String(num.body?.quality_rating ?? '') };
  if (tpl) {
    const tErr = failed(tpl);
    if (tErr) out.template = { error: tErr };
    else {
      const rows = ((tpl.body?.data ?? []) as any[]).filter((t) => t?.name === NEW_LEAD_TEMPLATE.name);
      const he = rows.find((t) => t?.language === NEW_LEAD_TEMPLATE.language);
      out.template = he ? { status: String(he.status ?? ''), language: String(he.language), category: String(he.category ?? '') } : { missing: true };
    }
  }
  return out;
}
