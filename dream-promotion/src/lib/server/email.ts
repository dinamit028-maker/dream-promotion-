/**
 * Emails to customers through Resend (the owner's decision, 6.10.2026). Env: RESEND_API_KEY (Vercel only, never in git).
 * The outbox's id is Resend's idempotency key: an email that is tried again after a lost answer is never sent twice.
 * "Sent" is recorded only with the id Resend returned (email_outbox_done).
 */
const API = 'https://api.resend.com';
export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY);

async function call(path: string, init: { method: string; body?: unknown; idempotencyKey?: string }) {
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
      ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as Record<string, any> };
}

/** {id} when Resend took it; otherwise the error, and whether trying again can help (a refusal of the email itself cannot) */
export async function sendEmail(m: { from: string; to: string; subject: string; html: string; text: string; replyTo?: string; key: string })
  : Promise<{ id: string } | { error: string; final: boolean }> {
  if (!emailConfigured()) return { error: 'שירות המיילים לא מוגדר', final: false };
  try {
    const r = await call('/emails', {
      method: 'POST', idempotencyKey: m.key,
      body: { from: m.from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}) },
    });
    if (r.status >= 200 && r.status < 300 && typeof r.json.id === 'string' && r.json.id) return { id: r.json.id };
    const final = r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 409;
    return { error: `resend ${r.status}: ${String(r.json.message ?? r.json.name ?? '').slice(0, 200)}`, final };
  } catch (e: any) {
    return { error: `resend: ${String(e?.message ?? e).slice(0, 200)}`, final: false };
  }
}

export interface DomainAnswer { id: string; status: string; records: { type: string; name: string; value: string; priority?: number; status?: string }[] }
const toDomain = (j: Record<string, any>): DomainAnswer => ({
  id: String(j.id ?? ''), status: String(j.status ?? ''),
  records: (Array.isArray(j.records) ? j.records : []).map((x: any) => ({
    type: String(x.type ?? ''), name: String(x.name ?? ''), value: String(x.value ?? ''), ...(x.priority != null ? { priority: Number(x.priority) } : {}),
    ...(x.status ? { status: String(x.status) } : {}),
  })),
});
/** the store's sending domain: added once (Resend answers with the DNS records to add), then checked */
export async function addDomain(name: string): Promise<{ ok: true; domain: DomainAnswer } | { ok: false; error: string }> {
  if (!emailConfigured()) return { ok: false, error: 'not_configured' };
  const r = await call('/domains', { method: 'POST', body: { name } });
  if (r.status >= 200 && r.status < 300 && r.json.id) return { ok: true, domain: toDomain(r.json) };
  return { ok: false, error: String(r.json.message ?? r.status).slice(0, 200) };
}
export async function checkDomain(id: string): Promise<{ ok: true; domain: DomainAnswer } | { ok: false; error: string }> {
  if (!emailConfigured()) return { ok: false, error: 'not_configured' };
  await call(`/domains/${encodeURIComponent(id)}/verify`, { method: 'POST' }).catch(() => null);
  const r = await call(`/domains/${encodeURIComponent(id)}`, { method: 'GET' });
  if (r.status >= 200 && r.status < 300 && r.json.id) return { ok: true, domain: toDomain(r.json) };
  return { ok: false, error: String(r.json.message ?? r.status).slice(0, 200) };
}
