'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AdDraft, BrandAnalysis, BrandProfile, ContentItem, Lead, MediaAsset } from '@/types';
import { uid } from './utils';

/**
 * Client store. Persisted to localStorage so the app is usable before a backend exists.
 * When Supabase lands, replace the persist middleware with a repository that reads/writes
 * the same shapes — no component changes required.
 */
interface AppState {
  onboarded: boolean;
  brand: BrandProfile;
  analysis: BrandAnalysis | null;
  content: ContentItem[];
  media: MediaAsset[];
  leads: Lead[];
  ads: AdDraft[];
  editingId: string | null;
  accessCode: string;
  setAccessCode: (c: string) => void;
  openEditor: (id: string) => void;
  closeEditor: () => void;
  setBrand: (b: Partial<BrandProfile>) => void;
  setAnalysis: (a: BrandAnalysis | null) => void;
  finishOnboarding: () => void;
  addContent: (c: Omit<ContentItem, 'id' | 'createdAt'>) => ContentItem;
  updateContent: (id: string, patch: Partial<ContentItem>) => void;
  removeContent: (id: string) => void;
  duplicateContent: (id: string) => void;
  addMedia: (m: MediaAsset) => void;
  removeMedia: (id: string) => void;
  addLead: (l: Omit<Lead, 'id'>) => void;
  updateLead: (id: string, patch: Partial<Lead>) => void;
  addAd: (a: Omit<AdDraft, 'id'>) => void;
  reset: () => void;
}

export const emptyBrand: BrandProfile = {
  name: '', industry: '', description: '', website: '', city: '',
  audience: '', goals: [], tone: '', cta: 'קבעו תור',
  colors: ['#6B3BF5', '#FF7FA8'], logoId: null,
};

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      onboarded: false,
      brand: emptyBrand,
      analysis: null,
      content: [],
      media: [],
      leads: [],
      ads: [],
      editingId: null,
      accessCode: '',
      setAccessCode: (accessCode) => set({ accessCode }),
      openEditor: (id) => set({ editingId: id }),
      closeEditor: () => set({ editingId: null }),
      setBrand: (b) => set((s) => ({ brand: { ...s.brand, ...b } })),
      setAnalysis: (analysis) => set({ analysis }),
      finishOnboarding: () => set({ onboarded: true }),
      addContent: (c) => {
        const item: ContentItem = { ...c, id: uid(), createdAt: Date.now() };
        set((s) => ({ content: [item, ...s.content] }));
        return item;
      },
      updateContent: (id, patch) =>
        set((s) => ({ content: s.content.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
      removeContent: (id) => set((s) => ({ content: s.content.filter((c) => c.id !== id) })),
      duplicateContent: (id) => {
        const c = get().content.find((x) => x.id === id);
        if (!c) return;
        set((s) => ({ content: [{ ...c, id: uid(), status: 'draft', date: null, createdAt: Date.now() }, ...s.content] }));
      },
      addMedia: (m) => set((s) => ({ media: [m, ...s.media] })),
      removeMedia: (id) => set((s) => ({ media: s.media.filter((m) => m.id !== id) })),
      addLead: (l) => set((s) => ({ leads: [{ ...l, id: uid() }, ...s.leads] })),
      updateLead: (id, patch) =>
        set((s) => ({ leads: s.leads.map((l) => (l.id === id ? { ...l, ...patch } : l)) })),
      addAd: (a) => set((s) => ({ ads: [{ ...a, id: uid() }, ...s.ads] })),
      reset: () => set({ onboarded: false, brand: emptyBrand, analysis: null, content: [], media: [], leads: [], ads: [] }),
    }),
    {
      name: 'dream-promotion',
      // the open editor is UI state, not data — never restore it on reload
      partialize: ({ editingId, ...rest }) => rest,
    },
  ),
);
