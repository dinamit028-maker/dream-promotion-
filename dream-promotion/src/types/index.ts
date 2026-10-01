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

/**
 * What a scene is made of — the main lever on the cost of a reel:
 *  ai_video  AI-generated motion (the expensive one — only where motion really matters)
 *  ai_image  an AI still with a camera move made by ffmpeg (cents instead of dollars)
 *  graphic   a branded text card drawn in the browser (free) — usually the call to action
 *  user      the user's own photo or video from the library (free)
 */
export type SceneSource = 'ai_video' | 'ai_image' | 'graphic' | 'user';
/** camera move over a still, made by ffmpeg (Ken Burns) */
export type SceneMotion = 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'none';

export interface ReelScene {
  role: string; seconds: number; onScreen: string; voiceover: string; visual: string; emoji?: string;
  source?: SceneSource;
  motion?: SceneMotion;
  /** English motion/camera prompt sent to the video model — no on-screen text */
  videoPrompt?: string;
  /** generated clip, once rendered */
  clipUrl?: string;
  /** narration audio + captions, generated separately from the video */
  voiceUrl?: string;
  srt?: string;
}

/** Narration for one scene, stored permanently: captions show originalText, the voice said spokenText. */
export interface SceneNarration {
  mediaId: string; url: string; originalText: string; spokenText: string;
  cues: { start: number; end: number; text: string }[]; durationSec?: number;
  voiceId: string; style: string; language: string;
}

/** One word of a caption line, timed from the start of its scene. hl: a key word, drawn in the highlight colour. */
export interface CaptionWord { text: string; start: number; end: number; hl?: boolean }
/** One caption line, timed from the start of its scene. */
export interface CaptionCue { start: number; end: number; text: string; words?: CaptionWord[]; emoji?: string }

/** How captions look — drawn by the browser, burned into the reel as images. */
export interface CaptionStyle {
  preset: 'classic' | 'pop' | 'karaoke' | 'box' | 'neon' | 'minimal';
  font: string;
  /** text size at 720px frame width */
  size: number;
  color: string;
  highlightColor: string;
  strokeColor: string;
  strokeWidth: number;
  shadow: boolean;
  background: 'none' | 'box';
  backgroundColor: string;
  /** vertical position of the line's centre, 0 (top) … 1 (bottom) */
  y: number;
  /** none: whole line at once · word: the spoken word lights up · karaoke: words fill in as they are spoken */
  highlight: 'none' | 'word' | 'karaoke';
  maxWords: number;
}

/** Everything needed to reopen a reel exactly where it was left — lives in content.reel. */
export interface ReelProject {
  v: 1;
  brief: string; total: number; res: '480p' | '720p' | '1080p'; seamless: boolean;
  board: Storyboard;
  /** per scene, same order as board.scenes */
  /** draft: a still standing in for an AI-video scene until the final version */
  clips: ({ url: string; kind: 'video' | 'image'; draft?: boolean; still?: string } | null)[];
  photos: (string | null)[];
  imageMode: boolean[];
  /** draft first: AI-video scenes are made as stills until "final version" turns them into video */
  draftMode?: boolean;
  narration: (SceneNarration | null)[];
  voice: { voiceId: string; style: string; language: string };
  music: { mediaId: string; url: string; name: string; volume: number } | null;
  captions: { enabled: boolean; position: 'bottom' | 'middle'; size: 'md' | 'lg'; style?: CaptionStyle };
  /** per scene: caption lines edited in the caption editor or transcribed from the clip's own sound */
  sceneCaptions?: (CaptionCue[] | null)[];
  /** keep the clips' own sound (default on); under narration it plays quietly */
  originalAudio?: boolean;
  final: { mediaId: string; url: string; durationSec: number; renderedAt: number } | null;
  updatedAt: number;
}

export interface Storyboard {
  title: string; scenes: ReelScene[]; caption: string; hashtags: string[];
  /** the one main character, in English, repeated in every image / video prompt (consistency) */
  cast?: string;
}

export interface ContentItem {
  id: string; kind: ContentKind; platform: Platform; goal: string;
  headline: string; caption: string; hashtags: string[]; cta: string;
  emoji: string; palette: [string, string]; visualDirection?: string;
  mediaId: string | null; scenes?: ReelScene[]; reel?: ReelProject;
  status: ContentStatus; date: string | null; time: string | null; createdAt: number;
}

export interface MediaAsset {
  id: string; url: string; name: string; kind: 'image' | 'video' | 'audio'; tags?: string[]; persistent: boolean;
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
  mediaId?: string;
}
