import { financeCaller } from '@/lib/server/finance';
import { gatewayMessage, gatewayMode } from '@/lib/server/tax/gateway';
import { connectionStatus, oauthConfig } from '@/lib/server/tax/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** The Tax Authority connection of the business worked in now — its status only; tokens never leave the server. */
export async function GET(req: Request) {
  const c = await financeCaller(req);
  if (!c.ok) return Response.json(c.body, { status: c.status });
  const mode = gatewayMode();
  return Response.json({ mode, configured: Boolean(oauthConfig()) && mode === 'live', connection: await connectionStatus(c.businessId), message: gatewayMessage(mode) },
    { headers: { 'Cache-Control': 'no-store' } });
}
