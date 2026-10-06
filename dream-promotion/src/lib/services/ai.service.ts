import { authHeaders } from './http';
import type { RewriteMode } from './prompts';
import type { BrandAnalysis, BrandProfile, ContentBrief, GeneratedVariant, Storyboard } from '@/types';
import type { CopyBrief, ProductCopy } from '@/features/catalog/catalog';
import type { PageCopy, ShortAsk, ShortCopy } from '@/features/store/page-ai';

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
    headers: await authHeaders(),
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
  storyboard: (brand: BrandProfile, brief: string, duration: number, avoid?: string[]) =>
    call<Storyboard>('storyboard', { brand, brief, duration, avoid }),
  brandAnalysis: (brand: BrandProfile) => call<BrandAnalysis>('analysis', { brand }),
  adCopy: (brand: BrandProfile, p: { goal: string; audience: string; budget: number; contentCaption?: string }) =>
    call<{ headline: string; primary: string; description: string; cta: string; audienceSuggestion: string }>('ad', { brand, ...p }),
  rewrite: (brand: BrandProfile, mode: RewriteMode, caption: string, cta: string) =>
    call<{ caption: string; cta: string }>('rewrite', { brand, mode, caption, cta }),
  sceneIdea: (brand: BrandProfile, role: string, onScreen: string, previous: string, extra: { voiceover?: string; cast?: string; angle?: string } = {}) =>
    call<{ videoPrompt: string; visual: string }>('scene', { brand, role, onScreen, previous, ...extra }),
  /** CRM: a follow-up message to one contact, in the brand's voice. */
  followup: (brand: BrandProfile, p: { name: string; stage: string; source?: string; notes?: string; history: string[]; goal?: string }) =>
    call<{ message: string }>('followup', { brand, ...p }),
  /** Video ideas fitted to the brand; recent = what was already made, avoid = ideas already shown. */
  ideas: (brand: BrandProfile, p: { recent?: string[]; avoid?: string[] }) =>
    call<{ ideas: { title: string; format: string; hook: string; brief: string; why: string }[] }>('ideas', { brand, ...p }),
  /** Post text + hashtags for a finished video. */
  social: (brand: BrandProfile, p: { title?: string; brief?: string; spoken?: string; platform?: string }) =>
    call<{ caption: string; hashtags: string[] }>('social', { brand, ...p }),
  /** Caption lines: fixed transcription, key words (hl = word indexes), optional emoji. Same number of lines. */
  polishCaptions: (brand: BrandProfile, p: { lines: string[]; brief?: string; emoji?: boolean; fix?: boolean }) =>
    call<{ lines: { text: string; hl?: number[]; emoji?: string }[] }>('captions', { brand, ...p }),
  /** Dream Commerce: a product page's description + its text for Google — a suggestion, approved before saving */
  productCopy: (brand: BrandProfile, brief: CopyBrief) => call<ProductCopy>('product', { brand, ...brief }),
  /** Dream Commerce: a page or a policy of the site (the store's details are read on the server) — a suggestion, approved before saving */
  storePage: (brand: BrandProfile, p: { kind: 'page' | 'policy'; policy: string | null; title: string; current: string }) =>
    call<PageCopy>('storePage', { brand, ...p }),
  /** a category's description or the store's one sentence */
  storeText: (brand: BrandProfile, a: ShortAsk) => call<ShortCopy>('storeText', { brand, ...a }),
  assistant: (brand: BrandProfile, recentContent: string, question: string) =>
    call<{ text: string }>('assistant', { brand, recentContent, question }),
};
