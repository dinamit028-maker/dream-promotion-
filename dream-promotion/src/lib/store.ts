'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AdDraft, BrandAnalysis, BrandProfile, ContentItem, Lead, MediaAsset } from '@/types';
import { uid } from './utils';
import type { VoiceStyle } from './services/voice/types';
import type { Pronunciation } from './pronunciation';
import { Repo } from './repo';

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
  voice: { voiceId: string; style: VoiceStyle; language: 'he' | 'en' };
  setVoice: (v: Partial<{ voiceId: string; style: VoiceStyle; language: 'he' | 'en' }>) => void;
  pronunciations: Pronunciation[];
  setPronunciations: (p: Pronunciation[]) => void;
  /** signed-in user; null means the app is running on this device only */
  userId: string | null;
  syncing: boolean;
  hydrate: (userId: string) => Promise<void>;
  signOutLocal: () => void;
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
  /** Saves and reports back — used where losing a save must be visible (reel projects). */
  saveContentNow: (id: string, patch: Partial<ContentItem>) => Promise<string | null>;
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
      voice: { voiceId: '', style: 'natural', language: 'he' },
      setVoice: (v) => set((st) => ({ voice: { ...st.voice, ...v } })),
      pronunciations: [],
      setPronunciations: (pronunciations) => {
        set({ pronunciations });
        const uid = get().userId;
        if (uid) void Repo.savePronunciations(uid, pronunciations);
      },
      userId: null,
      syncing: false,

      /**
       * Pulls the account's data down. On a first sign-in with an empty account,
       * whatever was created on this device is pushed up instead of being lost.
       */
      hydrate: async (userId) => {
        set({ syncing: true, userId });
        try {
          const cloud = await Repo.load(userId);
          const local = get();
          const cloudEmpty = !cloud.content.length && !cloud.brand?.name;
          const localHasWork = Boolean(local.brand.name) || local.content.length > 0 || local.media.length > 0;

          if (cloudEmpty && localHasWork) {
            await Repo.saveBrand(userId, local.brand, local.onboarded, local.analysis);
            await Promise.all([
              ...local.content.map((c) => Repo.saveContent(userId, c)),
              ...local.media.map((m) => Repo.saveMedia(userId, m)),
              ...local.leads.map((l) => Repo.saveLead(userId, l)),
              ...local.ads.map((a) => Repo.saveAd(userId, a)),
            ]);
            if (local.pronunciations.length) await Repo.savePronunciations(userId, local.pronunciations);
          } else {
            const { onboarded, analysis, ...brandFields } = cloud.brand as any;
            set({
              brand: { ...get().brand, ...brandFields },
              onboarded: onboarded ?? get().onboarded,
              analysis: analysis ?? get().analysis,
              content: cloud.content,
              media: cloud.media,
              leads: cloud.leads,
              ads: cloud.ads,
              pronunciations: cloud.pronunciations.length ? cloud.pronunciations : get().pronunciations,
            });
          }
        } finally {
          set({ syncing: false });
        }
      },

      signOutLocal: () => set({
        userId: null, onboarded: false, brand: emptyBrand, analysis: null,
        content: [], media: [], leads: [], ads: [], pronunciations: [],
      }),
      openEditor: (id) => set({ editingId: id }),
      closeEditor: () => set({ editingId: null }),
      setBrand: (b) => {
        set((s) => ({ brand: { ...s.brand, ...b } }));
        const { userId, brand, onboarded, analysis } = get();
        if (userId) void Repo.saveBrand(userId, brand, onboarded, analysis);
      },
      setAnalysis: (analysis) => {
        set({ analysis });
        const { userId, brand, onboarded } = get();
        if (userId) void Repo.saveBrand(userId, brand, onboarded, analysis);
      },
      finishOnboarding: () => {
        set({ onboarded: true });
        const { userId, brand, analysis } = get();
        if (userId) void Repo.saveBrand(userId, brand, true, analysis);
      },
      addContent: (c) => {
        const item: ContentItem = { ...c, id: crypto.randomUUID(), createdAt: Date.now() };
        set((s) => ({ content: [item, ...s.content] }));
        const u = get().userId;
        if (u) void Repo.saveContent(u, item);
        return item;
      },
      updateContent: (id, patch) => {
        set((s) => ({ content: s.content.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
        const { userId, content } = get();
        const item = content.find((c) => c.id === id);
        if (userId && item) void Repo.saveContent(userId, item);
      },
      saveContentNow: async (id, patch) => {
        set((s) => ({ content: s.content.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
        const { userId, content } = get();
        const item = content.find((c) => c.id === id);
        if (!userId || !item) return null;
        try { return await Repo.saveContent(userId, item); } catch (e: any) { return e?.message ?? 'save_failed'; }
      },
      removeContent: (id) => {
        set((s) => ({ content: s.content.filter((c) => c.id !== id) }));
        if (get().userId) void Repo.deleteContent(id);
      },
      duplicateContent: (id) => {
        const c = get().content.find((x) => x.id === id);
        if (!c) return;
        const copy: ContentItem = { ...c, id: crypto.randomUUID(), status: 'draft', date: null, createdAt: Date.now() };
        set((s) => ({ content: [copy, ...s.content] }));
        const u = get().userId;
        if (u) void Repo.saveContent(u, copy);
      },
      addMedia: (m) => {
        set((s) => ({ media: [m, ...s.media] }));
        const u = get().userId;
        if (u) void Repo.saveMedia(u, m);
      },
      removeMedia: (id) => {
        set((s) => ({ media: s.media.filter((m) => m.id !== id) }));
        if (get().userId) void Repo.deleteMedia(id);
      },
      addLead: (l) => {
        const lead: Lead = { ...l, id: crypto.randomUUID() };
        set((s) => ({ leads: [lead, ...s.leads] }));
        const u = get().userId;
        if (u) void Repo.saveLead(u, lead);
      },
      updateLead: (id, patch) => {
        set((s) => ({ leads: s.leads.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
        const { userId, leads } = get();
        const lead = leads.find((l) => l.id === id);
        if (userId && lead) void Repo.saveLead(userId, lead);
      },
      addAd: (a) => {
        const ad: AdDraft = { ...a, id: crypto.randomUUID() };
        set((s) => ({ ads: [ad, ...s.ads] }));
        const u = get().userId;
        if (u) void Repo.saveAd(u, ad);
      },
      reset: () => set({ onboarded: false, brand: emptyBrand, analysis: null, content: [], media: [], leads: [], ads: [] }),
    }),
    {
      name: 'dream-promotion',
      // bump only when a field genuinely changes shape; old data is kept, never wiped
      version: 2,
      migrate: (persisted: any) => ({
        ...persisted,
        voice: persisted?.voice ?? { voiceId: '', style: 'natural', language: 'he' },
        pronunciations: persisted?.pronunciations ?? [],
        ads: persisted?.ads ?? [],
        userId: null,
      }),
      // the open editor and sync flag are UI state, not data
      partialize: ({ editingId, syncing, ...rest }) => rest,
    },
  ),
);
