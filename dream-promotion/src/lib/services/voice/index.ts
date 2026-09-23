import { ElevenLabsProvider } from './elevenlabs';
import type { VoiceProvider } from './types';

/** Add a provider here and set VOICE_PROVIDER to switch engines. */
const PROVIDERS: Record<string, () => VoiceProvider> = {
  elevenlabs: () => new ElevenLabsProvider(),
};

export function getVoiceProvider(): VoiceProvider {
  const name = (process.env.VOICE_PROVIDER || 'elevenlabs').toLowerCase();
  const make = PROVIDERS[name] ?? PROVIDERS.elevenlabs;
  return make();
}

export * from './types';
