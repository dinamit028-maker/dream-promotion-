import type { MetaAccount } from './meta';

/**
 * Recommended posting times. Two sources, always labelled so nobody mistakes one for the other:
 *
 * 1. RESEARCH — published 2026 studies (Sprout Social, Buffer, Later and others), which disagree
 *    with each other in detail; what they share is moved to Israel time and the Israeli week
 *    (Sunday–Thursday working days, Friday mornings, Saturday evening after Shabbat).
 *    They are averages over millions of accounts — a starting point, not a rule.
 *
 * 2. PERSONAL — this account's own published posts and reels: their likes and comments by hour
 *    and day (Israel time). Only buckets with enough posts count, and each post is scored against
 *    the account's own median, so one viral post does not decide everything.
 *    Stories and TikTok have no per-post numbers available to the app, so they use research only.
 */
export type Format = 'reel' | 'feed' | 'story' | 'tiktok' | 'facebook';
export interface Slot { days: number[]; time: string; why: string }   // days: 0 = Sunday … 6 = Saturday

const WEEK = [0, 1, 2, 3, 4];
export const RESEARCH: Record<Format, Slot[]> = {
  reel: [
    { days: WEEK, time: '20:00', why: 'ערבי חול — שיא צפייה בווידאו קצר' },
    { days: [1, 2, 3], time: '13:00', why: 'אמצע שבוע בצהריים (חלון חזק במחקרי 2026)' },
    { days: [6], time: '20:30', why: 'מוצאי שבת — גלילה גבוהה בישראל' },
  ],
  feed: [
    { days: WEEK, time: '11:30', why: 'בוקר-צהריים של יום עבודה' },
    { days: WEEK, time: '20:30', why: 'ערב — אחרי העבודה' },
    { days: [5], time: '10:00', why: 'שישי בבוקר, לפני שבת' },
  ],
  story: [
    { days: [0, 1, 2, 3, 4, 5], time: '08:30', why: 'בדרך לעבודה — סטוריז נצפים ברצף' },
    { days: WEEK, time: '13:00', why: 'הפסקת צהריים' },
    { days: [0, 1, 2, 3, 4, 6], time: '21:00', why: 'ערב — כדאי כמה סטוריז לאורך היום, לא בבת אחת' },
  ],
  tiktok: [
    { days: [1, 2, 3], time: '10:00', why: 'שני–רביעי בבוקר: העקבי ביותר בין המחקרים' },
    { days: WEEK, time: '19:00', why: 'ערבי חול' },
    { days: [6], time: '21:00', why: 'מוצאי שבת' },
  ],
  facebook: [
    { days: WEEK, time: '18:30', why: 'רילס בפייסבוק מגיעים לשיא בערב' },
    { days: WEEK, time: '12:00', why: 'צהרי יום עבודה' },
  ],
};

/** hour: start of a 2-hour window (Israel time); score: average engagement vs the account's median (1 = typical) */
export interface PersonalSlot { hour: number; score: number; posts: number; bestDays: number[] }
export interface PersonalResult { reel: PersonalSlot[]; feed: PersonalSlot[]; analyzed: number; from: string | null }

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}`;
const ilParts = (iso: string) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date(iso));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.find((x) => x.type === 'weekday')?.value ?? 'Sun');
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0) % 24;
  return { day: wd, hour: h };
};

/** The account's own best hours, from up to ~200 recent posts of the last 12 months. */
export async function personalBestTimes(acc: MetaAccount): Promise<PersonalResult> {
  type M = { timestamp?: string; like_count?: number; comments_count?: number; media_product_type?: string };
  const items: M[] = [];
  const since = Date.now() - 365 * 864e5;
  let url: string | null = `${GRAPH}/${acc.externalId}/media?fields=timestamp,like_count,comments_count,media_product_type&limit=50&access_token=${encodeURIComponent(acc.token)}`;
  for (let page = 0; url && page < 4; page++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const j: any = await res.json().catch(() => ({}));
    if (j.error) throw new Error(`meta_${j.error.code}: ${j.error.message}`);
    const batch: M[] = j.data ?? [];
    items.push(...batch);
    if (batch.some((m) => m.timestamp && new Date(m.timestamp).getTime() < since)) break;
    url = j.paging?.next ?? null;
  }
  const recent = items.filter((m) => m.timestamp && new Date(m.timestamp).getTime() >= since);
  const score = (m: M) => (m.like_count ?? 0) + 3 * (m.comments_count ?? 0);

  const rank = (list: M[]): PersonalSlot[] => {
    if (list.length < 8) return [];
    const sorted = list.map(score).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1;
    // 2-hour windows across all days (single day×hour cells are too sparse for most accounts)
    const buckets = new Map<number, { hour: number; total: number; n: number; days: Map<number, { t: number; n: number }> }>();
    for (const m of list) {
      const { day, hour } = ilParts(m.timestamp!);
      const h2 = hour - (hour % 2);
      const rel = Math.min(5, score(m) / median); // relative to this account, capped: one viral post cannot decide
      const b = buckets.get(h2) ?? { hour: h2, total: 0, n: 0, days: new Map() };
      b.total += rel; b.n++;
      const d = b.days.get(day) ?? { t: 0, n: 0 }; d.t += rel; d.n++; b.days.set(day, d);
      buckets.set(h2, b);
    }
    return [...buckets.values()].filter((b) => b.n >= 3)
      .map((b) => ({
        hour: b.hour, score: Math.round((b.total / b.n) * 100) / 100, posts: b.n,
        bestDays: [...b.days.entries()].filter(([, d]) => d.n >= 1).sort((x, y) => y[1].t / y[1].n - x[1].t / x[1].n).slice(0, 3).map(([day]) => day),
      }))
      .sort((a, b) => b.score - a.score || b.posts - a.posts).slice(0, 3);
  };

  const reels = recent.filter((m) => m.media_product_type === 'REELS');
  const feed = recent.filter((m) => m.media_product_type !== 'REELS' && m.media_product_type !== 'STORY');
  const oldest = recent.map((m) => m.timestamp!).sort()[0] ?? null;
  return { reel: rank(reels.length >= 8 ? reels : recent), feed: rank(feed.length >= 8 ? feed : recent), analyzed: recent.length, from: oldest };
}
