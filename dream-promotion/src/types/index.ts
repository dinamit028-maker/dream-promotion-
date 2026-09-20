export type ContentKind = 'post' | 'reel' | 'story' | 'ad';
export type ContentStatus = 'draft' | 'scheduled' | 'published';
export type Platform = 'Instagram' | 'Facebook' | 'TikTok' | 'Meta';

export interface BrandProfile {
  name: string; industry: string; description: string; website: string; city: string;
  audience: string; goals: string[]; tone: string; cta: string;
  colors: [string, string]; logoId: string | null;
}

export interface BrandAnalysis {
  voice: string;
  pillars: { name: string; why: string }[];
  audienceInsight: string;
  bestTimes: string[];
  firstMoves: string[];
}

export interface ReelScene {
  role: string; seconds: number; onScreen: string; voiceover: string; visual: string; emoji?: string;
}

export interface Storyboard {
  title: string; scenes: ReelScene[]; caption: string; hashtags: string[];
}

export interface ContentItem {
  id: string; kind: ContentKind; platform: Platform; goal: string;
  headline: string; caption: string; hashtags: string[]; cta: string;
  emoji: string; palette: [string, string]; visualDirection?: string;
  mediaId: string | null; scenes?: ReelScene[];
  status: ContentStatus; date: string | null; time: string | null; createdAt: number;
}

export interface MediaAsset {
  id: string; url: string; name: string; kind: 'image' | 'video'; tags?: string[]; persistent: boolean;
}

export type LeadStatus = 'חדש' | 'נוצר קשר' | 'מעוניין' | 'נקבע תור' | 'נסגר' | 'לא רלוונטי';

export interface Lead {
  id: string; name: string; phone: string; source: string;
  campaignId?: string; date: string; status: LeadStatus; notes?: string;
}

export interface AdDraft {
  id: string; goal: string; audience: string; budgetPerDay: number; days: number;
  headline: string; primary: string; description: string; cta: string;
  contentId?: string; status: 'draft' | 'live';
}

export type ConnectionState = 'connected' | 'disconnected' | 'needs_reauth';

export interface Integration {
  provider: 'Instagram' | 'Facebook' | 'TikTok' | 'WhatsApp';
  state: ConnectionState;
  accountName?: string;
}

export interface ContentBrief {
  kind: ContentKind; platform: Platform; goal: string; brief: string; count?: number;
}

export interface GeneratedVariant {
  angle: string; headline: string; caption: string; hashtags: string[];
  cta: string; emoji: string; palette: [string, string]; visual_direction?: string;
}
