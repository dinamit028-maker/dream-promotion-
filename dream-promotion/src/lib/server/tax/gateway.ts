import { createHash } from 'node:crypto';
import type { AllocationRequest } from '@/features/finance/allocation';
import { accessTokenFor, oauthConfig } from './oauth';

/**
 * TaxAuthorityGateway — the one place the app would talk to the Israel Tax Authority (SHAAM) about allocation numbers.
 * Server only. Three modes, chosen by the environment:
 *   unconfigured  (default)  nothing is sent; the screens say the connection is not set up
 *   mock          TAX_GATEWAY_MODE=mock, never on Vercel production: answers "TEST-…" numbers, stored with is_test = true,
 *                 printed as "מספר בדיקה — לא מספר הקצאה" — a test number can never pass as a real one (the database
 *                 refuses a TEST-number marked real, and a digits-only number marked test)
 *   live          TAX_GATEWAY_MODE=live + the OAuth / API settings below. The transport is here (per-business OAuth token,
 *                 timeouts, minimized request); the mapping of our request to the Tax Authority's API fields is NOT
 *                 written, because the official API description could not be read from the development environment.
 *                 Until a developer implements mapRequest / mapResponse from the official document ("מודל חשבוניות ישראל —
 *                 תיאור ה-API's") and sets ITA_SPEC_VERIFIED=1, live requests stop with "spec_not_verified".
 * No URL, field name, credential or response field of the Tax Authority is written in this code: they come from the
 * environment (ITA_*), and nothing is filed or claimed without a real answer from the real API.
 */
export type GatewayMode = 'unconfigured' | 'mock' | 'live';
export interface AllocationResult { status: 'approved' | 'rejected' | 'error'; number?: string; isTest: boolean; errorCode?: string; errorMessage?: string }
export interface TaxGateway { mode: GatewayMode; requestAllocation(req: AllocationRequest, ctx: { businessId: string }): Promise<AllocationResult> }
type Env = Record<string, string | undefined>;

export function gatewayMode(env: Env = process.env): GatewayMode {
  const m = (env.TAX_GATEWAY_MODE ?? '').trim().toLowerCase();
  if (m === 'mock') return env.VERCEL_ENV === 'production' ? 'unconfigured' : 'mock';
  if (m === 'live') return liveSettings(env) ? 'live' : 'unconfigured';
  return 'unconfigured';
}
/** everything a live request needs, from the environment only */
export function liveSettings(env: Env = process.env) {
  const baseUrl = env.ITA_API_BASE_URL?.trim(), path = env.ITA_ALLOCATION_PATH?.trim();
  if (!baseUrl || !path || !/^https:\/\//.test(baseUrl) || !oauthConfig(env)) return null;
  return { url: new URL(path, baseUrl).toString(), specVerified: env.ITA_SPEC_VERIFIED === '1', timeoutMs: Number(env.ITA_TIMEOUT_MS) || 20_000 };
}

/** sha256 of the minimized request — stored instead of the request itself (no personal data in the log) */
export const requestDigest = (req: AllocationRequest) => createHash('sha256').update(JSON.stringify(req)).digest('hex');

const unconfigured: TaxGateway = {
  mode: 'unconfigured',
  async requestAllocation() { return { status: 'error', isTest: false, errorCode: 'not_configured', errorMessage: 'החיבור לרשות המסים עוד לא הוגדר' }; },
};

/** a test number from the request (stable for the same request) — "TEST-" and nine digits, never a real number */
export const mockGateway: TaxGateway = {
  mode: 'mock',
  async requestAllocation(req) {
    const digits = (parseInt(requestDigest(req).slice(0, 12), 16) % 1e9).toString().padStart(9, '0');
    return { status: 'approved', number: `TEST-${digits}`, isTest: true };
  },
};

export class SpecNotVerified extends Error { code = 'spec_not_verified'; }
/**
 * Our request → the Tax Authority's request body. Deliberately not implemented: the field names must come from the
 * official API description, verified by a developer with access to it (see COMPLIANCE_CHECKLIST.md).
 */
export function mapRequest(_req: AllocationRequest): unknown {
  throw new SpecNotVerified('the Tax Authority API fields were not verified against the official specification');
}
/** the Tax Authority's answer → our result. Deliberately not implemented (same reason as mapRequest). */
export function mapResponse(_body: unknown): AllocationResult {
  throw new SpecNotVerified('the Tax Authority API response fields were not verified against the official specification');
}

function liveGateway(env: Env): TaxGateway {
  return {
    mode: 'live',
    async requestAllocation(req, ctx) {
      const s = liveSettings(env);
      if (!s) return unconfigured.requestAllocation(req, ctx);
      if (!s.specVerified) return { status: 'error', isTest: false, errorCode: 'spec_not_verified', errorMessage: 'החיבור החי עוד לא הושלם: מבנה הבקשה לרשות המסים לא אומת מול המפרט הרשמי' };
      // the token of THIS business only (a token of business A is never used for business B)
      const token = await accessTokenFor(ctx.businessId, env);
      if (!token.ok) return { status: 'error', isTest: false, errorCode: token.code, errorMessage: token.message };
      let body: unknown;
      try { body = mapRequest(req); } catch (e) { return { status: 'error', isTest: false, errorCode: 'spec_not_verified', errorMessage: String((e as Error).message).slice(0, 300) }; }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), s.timeoutMs);
      try {
        const res = await fetch(s.url, { method: 'POST', signal: ac.signal, headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json().catch(() => null);
        if (!res.ok) return { status: 'error', isTest: false, errorCode: `http_${res.status}`, errorMessage: 'רשות המסים לא אישרה את הבקשה' };
        return mapResponse(json);
      } catch (e) {
        return { status: 'error', isTest: false, errorCode: (e as Error).name === 'AbortError' ? 'timeout' : 'network', errorMessage: 'אין תשובה מרשות המסים כרגע' };
      } finally { clearTimeout(timer); }
    },
  };
}

export function taxGateway(env: Env = process.env): TaxGateway {
  const m = gatewayMode(env);
  return m === 'mock' ? mockGateway : m === 'live' ? liveGateway(env) : unconfigured;
}
/** what the settings screen says, in Hebrew */
export function gatewayMessage(mode: GatewayMode, env: Env = process.env): string {
  if (mode === 'mock') return 'מצב בדיקות פעיל (TAX_GATEWAY_MODE=mock): מתקבלים מספרי TEST בלבד — לא מספרי הקצאה של רשות המסים. לא פעיל בסביבת production.';
  if (mode === 'live') return liveSettings(env)?.specVerified ? 'חיבור חי לרשות המסים מוגדר. מספר הקצאה מתבקש לכל עסק עם החיבור שלו.' : 'הגדרות החיבור החי קיימות, אבל מבנה הבקשה עוד לא אומת מול המפרט הרשמי — בקשות לא יישלחו עד שזה יושלם.';
  return 'החיבור לרשות המסים לא הוגדר. אפשר להזין מספר הקצאה שהתקבל מרשות המסים ידנית, והוא יסומן "הוזן ידנית".';
}
