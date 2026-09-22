import { authHeaders } from './http';
import type { BrandAnalysis, BrandProfile, ContentBrief, GeneratedVariant, Storyboard } from '@/types';

/**
 * AIService — the only place the app talks to a language model.
 * The browser never sees an API key: every call goes through /api/ai.
 * Swapping providers = editing src/app/api/ai/route.ts only.
 */
export class AIServiceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function call<T>(task: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ task, payload }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AIServiceError(body.code || 'ai_error', body.message || 'AI request failed');
  }
  return res.json() as Promise<T>;
}

export const AIService = {
  /** False when ANTHROPIC_API_KEY is missing — the UI says so and never fakes output. */
  async available(): Promise<boolean> {
    try {
      const r = await fetch('/api/ai');
      const j = await r.json();
      return !!j.available;
    } catch { return false; }
  },
  generateContent: (brand: BrandProfile, brief: ContentBrief) =>
    call<{ variants: GeneratedVariant[] }>('content', { brand, brief }),
  weeklyPlan: (brand: BrandProfile) =>
    call<{ items: Record<string, any>[] }>('weekly', { brand }),
  storyboard: (brand: BrandProfile, brief: string, duration: number) =>
    call<Storyboard>('storyboard', { brand, brief, duration }),
  brandAnalysis: (brand: BrandProfile) => call<BrandAnalysis>('analysis', { brand }),
  adCopy: (brand: BrandProfile, p: { goal: string; audience: string; budget: number; contentCaption?: string }) =>
    call<{ headline: string; primary: string; description: string; cta: string; audienceSuggestion: string }>('ad', { brand, ...p }),
  assistant: (brand: BrandProfile, recentContent: string, question: string) =>
    call<{ text: string }>('assistant', { brand, recentContent, question }),
};
