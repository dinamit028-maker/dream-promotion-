/**
 * The contract every TTS engine must satisfy. Nothing above this file knows
 * which provider is in use — swapping ElevenLabs for another engine means
 * writing one new file and changing VOICE_PROVIDER.
 */
export interface VoiceOption {
  id: string;
  name: string;
  gender: 'female' | 'male' | 'unknown';
  /** provider's own description, shown as a hint */
  description?: string;
  languages?: string[];
}

export type VoiceStyle = 'natural' | 'energetic' | 'premium' | 'commercial';

export interface SpeakRequest {
  text: string;            // what is actually spoken (after pronunciation overrides)
  voiceId: string;
  style: VoiceStyle;
  language: string;        // ISO 639-1, 'he' | 'en'
  speed?: number;
}

/** Character-level timing, which is what makes subtitles line up with the voice. */
export interface Alignment {
  characters: string[];
  startsSec: number[];
  endsSec: number[];
}

export interface SpeakResult {
  audioBase64: string;
  mimeType: string;
  alignment?: Alignment;
  durationSec?: number;
}

export interface VoiceProvider {
  readonly id: string;
  readonly label: string;
  available(): boolean;
  listVoices(language: string): Promise<VoiceOption[]>;
  speak(req: SpeakRequest): Promise<SpeakResult>;
}
