/**
 * A store's domain in the storefront's Vercel project (2.55, server only) — through Vercel's REST API, when the dashboard
 * has VERCEL_API_TOKEN and VERCEL_STOREFRONT_PROJECT (and VERCEL_TEAM_ID for a team). Without them nothing is called and
 * the screen shows the steps to do by hand in Vercel. The DNS records shown are the ones Vercel answers — never values
 * written here (except as the fallback that Vercel documents, marked as such).
 * NOT verified against Vercel from this environment (no token, no network to Vercel): the shapes follow Vercel's
 * documentation (DREAM_COMMERCE_ARCHITECTURE §16); every answer is read defensively and kept as it came (store_domains.vercel).
 */
export interface VercelEnv { token: string; project: string; team?: string }
export function vercelEnv(env: Record<string, string | undefined> = process.env): VercelEnv | null {
  const token = env.VERCEL_API_TOKEN, project = env.VERCEL_STOREFRONT_PROJECT;
  return token && project ? { token, project, team: env.VERCEL_TEAM_ID || undefined } : null;
}

export interface DnsRecord { type: 'A' | 'CNAME' | 'TXT'; name: string; value: string; fromVercel: boolean }
export interface VercelAnswer { ok: boolean; status: number; code?: string; message?: string; body: Record<string, unknown> }
type Fetch = typeof fetch;

async function call(env: VercelEnv, method: string, path: string, body?: unknown, f: Fetch = fetch): Promise<VercelAnswer> {
  const u = new URL(`https://api.vercel.com${path}`);
  if (env.team) u.searchParams.set('teamId', env.team);
  try {
    const res = await f(u.toString(), {
      method, headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { ok: res.ok, status: res.status, code: j?.error?.code, message: j?.error?.message, body: j };
  } catch (e) {
    return { ok: false, status: 0, code: 'network', message: (e as Error).message, body: {} };
  }
}

/** add a domain to the storefront's project; a "www." beside a bare name sends to it (308) */
export function addDomain(env: VercelEnv, name: string, redirectTo?: string, f?: Fetch) {
  return call(env, 'POST', `/v10/projects/${encodeURIComponent(env.project)}/domains`,
    redirectTo ? { name, redirect: redirectTo, redirectStatusCode: 308 } : { name }, f);
}
export const verifyDomain = (env: VercelEnv, name: string, f?: Fetch) =>
  call(env, 'POST', `/v9/projects/${encodeURIComponent(env.project)}/domains/${encodeURIComponent(name)}/verify`, {}, f);
export const domainConfig = (env: VercelEnv, name: string, f?: Fetch) => call(env, 'GET', `/v6/domains/${encodeURIComponent(name)}/config`, undefined, f);
export const removeDomain = (env: VercelEnv, name: string, f?: Fetch) =>
  call(env, 'DELETE', `/v9/projects/${encodeURIComponent(env.project)}/domains/${encodeURIComponent(name)}`, undefined, f);

/** the DNS records to show for a domain, from Vercel's answers (the documented defaults only when Vercel gave none) */
export function recordsFor(domain: string, bare: boolean, added: Record<string, any> = {}, config: Record<string, any> = {}): DnsRecord[] {
  const out: DnsRecord[] = [];
  const ip = config?.recommendedIPv4?.[0]?.value?.[0];
  const cname = config?.recommendedCNAME?.[0]?.value;
  if (bare) out.push({ type: 'A', name: '@', value: typeof ip === 'string' ? ip : '76.76.21.21', fromVercel: typeof ip === 'string' });
  else {
    const label = domain.split('.')[0];
    out.push({ type: 'CNAME', name: label, value: typeof cname === 'string' ? cname.replace(/\.$/, '') : 'cname.vercel-dns.com', fromVercel: typeof cname === 'string' });
  }
  for (const v of Array.isArray(added?.verification) ? added.verification : []) {
    if (v?.type === 'TXT' && typeof v.domain === 'string' && typeof v.value === 'string') {
      out.push({ type: 'TXT', name: v.domain.replace(new RegExp(`\\.?${domain.replace(/\./g, '\\.')}$`), '') || '@', value: v.value, fromVercel: true });
    }
  }
  return out;
}
/** the www row's record: a CNAME to Vercel */
export function wwwRecord(config: Record<string, any> = {}): DnsRecord {
  const cname = config?.recommendedCNAME?.[0]?.value;
  return { type: 'CNAME', name: 'www', value: typeof cname === 'string' ? cname.replace(/\.$/, '') : 'cname.vercel-dns.com', fromVercel: typeof cname === 'string' };
}
