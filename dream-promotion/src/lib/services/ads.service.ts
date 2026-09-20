import type { AdDraft } from '@/types';
import { IntegrationRequiredError } from './social.service';

/**
 * AdsService — Meta Marketing API adapter.
 * launch() stays unimplemented on purpose: an ad that silently fails to run
 * is worse than a button that tells the truth.
 * Requires META_APP_ID/SECRET + ads_management + an ad account id.
 */
export const AdsService = {
  async launch(_draft: AdDraft): Promise<never> {
    throw new IntegrationRequiredError('Meta', 'campaign launch');
  },
  /** Planned spend is arithmetic we control. Results are not — they come from Meta or nowhere. */
  plannedSpend: (budgetPerDay: number, days: number) => budgetPerDay * days,
};
