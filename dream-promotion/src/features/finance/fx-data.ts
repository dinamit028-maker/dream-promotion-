import { authHeaders } from '@/lib/services/http';
import { FX_UNAVAILABLE, cleanRates, type FxRate } from './fx';

/** the representative rates from the server (/api/finance/fx — the bank's feed; the browser never calls the bank), checked again
 *  here the way the server checks the bank's (cleanRates): nothing that is not whole reaches the converter */
export async function loadFxRates(): Promise<{ ok: true; rates: FxRate[] } | { ok: false; message: string }> {
  try {
    const r = await fetch('/api/finance/fx', { headers: await authHeaders() });
    const j = await r.json().catch(() => null);
    if (r.ok) {
      const rates = cleanRates(j?.rates);
      if (rates.length) return { ok: true, rates };
    }
    return { ok: false, message: r.status === 429 && typeof j?.message === 'string' ? j.message : FX_UNAVAILABLE };
  } catch {
    return { ok: false, message: FX_UNAVAILABLE };
  }
}
