'use client';
import { supabase, isCloudConfigured } from './supabase/client';
import type { AdDraft, BrandProfile, ContentItem, Lead, MediaAsset } from '@/types';
import type { Pronunciation } from './pronunciation';

/**
 * Every read and write against the user's own rows. Row-level security in Postgres
 * is what actually enforces ownership; this file just speaks the app's shapes.
 * Writes are fire-and-forget from the UI's point of view — the local store stays
 * responsive and the row lands a moment later.
 */

const rowToContent = (r: any): ContentItem => ({
  id: r.id, kind: r.kind, platform: r.platform, goal: r.goal ?? '',
  headline: r.headline ?? '', caption: r.caption ?? '', hashtags: r.hashtags ?? [],
  cta: r.cta ?? '', emoji: '', palette: (r.palette ?? ['#6B3BF5', '#A96BF8']) as [string, string],
  visualDirection: r.visual_direction ?? undefined, mediaId: r.media_id ?? null,
  scenes: r.scenes ?? undefined, reel: r.reel ?? undefined, status: r.status, date: r.date, time: r.time,
  createdAt: new Date(r.created_at).getTime(),
});

const contentToRow = (userId: string, c: ContentItem) => ({
  id: c.id, user_id: userId, kind: c.kind, platform: c.platform, goal: c.goal,
  headline: c.headline, caption: c.caption, hashtags: c.hashtags, cta: c.cta,
  palette: c.palette, visual_direction: c.visualDirection ?? null,
  media_id: c.mediaId, scenes: c.scenes ?? null, status: c.status,
  ...(c.reel ? { reel: c.reel } : {}),
  date: c.date, time: c.time,
});

export interface CloudSnapshot {
  brand: Partial<BrandProfile> & { onboarded?: boolean; analysis?: any };
  content: ContentItem[];
  media: MediaAsset[];
  leads: Lead[];
  ads: AdDraft[];
  pronunciations: Pronunciation[];
}

export const Repo = {
  enabled: isCloudConfigured,

  async userId(): Promise<string | null> {
    if (!isCloudConfigured) return null;
    const { data } = await supabase().auth.getUser();
    return data.user?.id ?? null;
  },

  /** Loads everything that belongs to the signed-in user. */
  async load(userId: string): Promise<CloudSnapshot> {
    const sb = supabase();
    const [brand, content, media, leads, ads, pron] = await Promise.all([
      sb.from('brands').select('*').eq('user_id', userId).maybeSingle(),
      sb.from('content').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      sb.from('media').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      sb.from('leads').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      sb.from('ad_drafts').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      sb.from('pronunciations').select('*').eq('user_id', userId),
    ]);

    const b = brand.data;
    return {
      brand: b ? {
        name: b.name ?? '', industry: b.industry ?? '', description: b.description ?? '',
        website: b.website ?? '', city: b.city ?? '', audience: b.audience ?? '',
        goals: b.goals ?? [], tone: b.tone ?? '', cta: b.cta ?? 'קבעו תור',
        colors: (b.colors ?? ['#6B3BF5', '#FF7FA8']) as [string, string], logoId: null,
        onboarded: b.onboarded, analysis: b.analysis,
      } : {},
      content: (content.data ?? []).map(rowToContent),
      media: (media.data ?? []).filter((r: any) => !String(r.url ?? '').startsWith('blob:')).map((r: any): MediaAsset => ({
        id: r.id, url: r.url, name: r.name ?? '', kind: r.kind, persistent: Boolean(r.storage_path),
      })),
      leads: (leads.data ?? []).map((r: any): Lead => ({
        id: r.id, name: r.name, phone: r.phone ?? '', source: r.source ?? '',
        date: r.date, status: r.status, notes: r.notes ?? '',
      })),
      ads: (ads.data ?? []).map((r: any): AdDraft => ({
        id: r.id, goal: r.goal ?? '', audience: r.audience ?? '',
        budgetPerDay: Number(r.budget_per_day ?? 0), days: r.days ?? 7,
        headline: r.headline ?? '', primary: r.primary_text ?? '',
        description: r.description ?? '', cta: r.cta ?? '', status: r.status,
      })),
      pronunciations: (pron.data ?? []).map((r: any): Pronunciation => ({ term: r.term, say: r.say })),
    };
  },

  async saveBrand(userId: string, brand: BrandProfile, onboarded: boolean, analysis: unknown) {
    await supabase().from('brands').upsert({
      user_id: userId, name: brand.name, industry: brand.industry, description: brand.description,
      website: brand.website, city: brand.city, audience: brand.audience, goals: brand.goals,
      tone: brand.tone, cta: brand.cta, colors: brand.colors, onboarded, analysis,
    });
  },

  /** Returns an error code when a reel project could not be stored (missing migration). */
  async saveContent(userId: string, item: ContentItem): Promise<string | null> {
    const { error } = await supabase().from('content').upsert(contentToRow(userId, item));
    if (error && item.reel && /reel/.test(error.message)) {
      // database not migrated yet: keep the post itself, report that the reel project was not stored
      const { reel: _skip, ...rest } = item;
      await supabase().from('content').upsert(contentToRow(userId, rest as ContentItem));
      return 'reel_column_missing';
    }
    return error ? error.message : null;
  },
  async deleteContent(id: string) {
    await supabase().from('content').delete().eq('id', id);
  },

  async saveMedia(userId: string, m: MediaAsset, storagePath?: string) {
    // persistent assets were already written by the uploader / archive route —
    // upserting here would wipe their storage_path. Blob URLs die on refresh, so never store them.
    if (m.persistent || m.url.startsWith('blob:')) return;
    await supabase().from('media').upsert({
      id: m.id, user_id: userId, url: m.url, name: m.name, kind: m.kind,
      storage_path: storagePath ?? null, source: storagePath ? 'generated' : 'upload',
    });
  },
  async deleteMedia(id: string) {
    await supabase().from('media').delete().eq('id', id);
  },

  async saveLead(userId: string, l: Lead) {
    await supabase().from('leads').upsert({
      id: l.id, user_id: userId, name: l.name, phone: l.phone, source: l.source,
      status: l.status, notes: l.notes ?? '', date: l.date,
    });
  },

  async saveAd(userId: string, a: AdDraft) {
    await supabase().from('ad_drafts').upsert({
      id: a.id, user_id: userId, goal: a.goal, audience: a.audience,
      budget_per_day: a.budgetPerDay, days: a.days, headline: a.headline,
      primary_text: a.primary, description: a.description, cta: a.cta, status: a.status,
    });
  },

  async savePronunciations(userId: string, list: Pronunciation[]) {
    const sb = supabase();
    await sb.from('pronunciations').delete().eq('user_id', userId);
    const rows = list.filter((p) => p.term.trim()).map((p) => ({ user_id: userId, term: p.term.trim(), say: p.say.trim() }));
    if (rows.length) await sb.from('pronunciations').insert(rows);
  },

  async logUsage(userId: string, kind: 'clip' | 'image' | 'voice' | 'text', costUsd: number, meta?: unknown) {
    await supabase().from('usage_events').insert({ user_id: userId, kind, cost_usd: costUsd, meta: meta ?? null });
  },
};
