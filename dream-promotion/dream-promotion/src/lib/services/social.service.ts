import type { ContentItem, Integration } from '@/types';

export class IntegrationRequiredError extends Error {
  constructor(public provider: string, public what: string) {
    super(`${provider} integration required for ${what}`);
  }
}

/**
 * SocialPublishingService — OAuth + publishing adapter.
 * Nothing here pretends to be connected. Every method throws until the real
 * Meta / TikTok flow is wired, and the UI renders that state honestly.
 *   connect() → redirect to /api/auth/{provider}, store tokens server-side
 *   publish() → Instagram Graph /media + /media_publish, or FB /feed
 */
export const SocialPublishingService = {
  providers: ['Instagram', 'Facebook', 'TikTok', 'WhatsApp'] as const,
  async status(): Promise<Integration[]> {
    const res = await fetch('/api/integrations').catch(() => null);
    if (!res || !res.ok) {
      return this.providers.map((p) => ({ provider: p, state: 'disconnected' as const }));
    }
    return res.json();
  },
  async connect(provider: string): Promise<never> {
    throw new IntegrationRequiredError(provider, 'OAuth');
  },
  async publish(item: ContentItem): Promise<never> {
    throw new IntegrationRequiredError(item.platform, 'publishing');
  },
};
