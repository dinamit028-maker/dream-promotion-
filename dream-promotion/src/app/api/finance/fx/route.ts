import { FX_UNAVAILABLE } from '@/features/finance/fx';
import { financeCaller } from '@/lib/server/finance';
import { boiRates } from '@/lib/server/fx';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';

/**
 * The Bank of Israel's representative rates for the money lobby's currency converter (2.98). The same gates as every money route
 * (financeCaller: signed in, the business worked in now, never a cashier) — the rates are public, but the server is nobody's
 * open proxy. Read only; nothing is stored but the bank's last answer, in memory (src/lib/server/fx.ts).
 */
export async function GET(req: Request) {
  const limited = rateLimited(req, 'finance-fx', 30, MINUTE);
  if (limited) return limited;
  const c = await financeCaller(req);
  if (!c.ok) return Response.json(c.body, { status: c.status });
  const rates = await boiRates();
  if (!rates) return Response.json({ code: 'fx_unavailable', message: FX_UNAVAILABLE }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return Response.json({ source: 'boi', rates }, { headers: { 'Cache-Control': 'private, max-age=300' } });
}
