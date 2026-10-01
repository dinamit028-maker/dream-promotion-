import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';

export const runtime = 'nodejs';

/**
 * Free background music: Openverse (openverse.org), the open index of Creative Commons audio
 * (Jamendo, Freesound, Wikimedia). Only tracks whose license ALLOWS COMMERCIAL USE are returned
 * (license_type=commercial). Each result carries its license and the attribution line —
 * CC BY tracks need the credit, which the app adds to the post text automatically.
 * GET ?q=upbeat&page=1
 */
const API = 'https://api.openverse.org/v1/audio/';

export async function GET(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || 'background music').slice(0, 80);
  const page = Math.max(1, Math.min(10, Number(url.searchParams.get('page')) || 1));
  // default: only CC0 / public domain — no copyright claims and no credit line needed.
  // ?credit=1 widens to every license that allows commercial use (CC BY needs a credit).
  const withCredit = url.searchParams.get('credit') === '1';
  // no category / extension filters: search results usually leave those fields empty, so filtering
  // on them dropped almost everything. Tracks are kept or dropped below by length and file instead.
  const qs = new URLSearchParams({
    // anonymous requests may ask for at most 20 per page (Openverse rule)
    q, page: String(page), page_size: '20', mature: 'false',
    ...(withCredit ? { license_type: 'commercial' } : { license: 'cc0,pdm' }),
  });
  try {
    const res = await fetch(`${API}?${qs}`, {
      headers: { 'User-Agent': 'DreamPromotion/1.0 (background music search)' },
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) return NextResponse.json({ code: 'music_search_failed', message: j?.detail || `openverse ${res.status}` }, { status: 502 });
    const playable = (u: string) => !/\.(flac|aiff?|mid|midi)(\?|$)/i.test(u);
    const tracks = (j.results ?? [])
      .filter((t: any) => t.url && playable(String(t.url)) && (!t.duration || t.duration >= 15_000)) // under 15 s is a sound effect
      .filter((t: any) => !t.category || ['music', 'audiobook'].includes(t.category) || t.category === 'music')
      .sort((a: any, b: any) => Number(b.category === 'music') - Number(a.category === 'music'))
      .map((t: any) => ({
        id: String(t.id), title: String(t.title || 'ללא שם'), creator: String(t.creator || ''),
        url: String(t.url), durationSec: t.duration ? Math.round(t.duration / 1000) : null,
        license: String(t.license || '').toLowerCase(), licenseVersion: t.license_version ? String(t.license_version) : '',
        attribution: String(t.attribution || `"${t.title}" by ${t.creator} (CC ${String(t.license || '').toUpperCase()})`),
        source: String(t.source || t.provider || ''), page: t.foreign_landing_url ? String(t.foreign_landing_url) : null,
      }));
    console.log('[music]', q, withCredit ? 'commercial' : 'cc0', 'openverse:', j.result_count ?? (j.results ?? []).length, 'kept:', tracks.length);
    return NextResponse.json({ tracks, more: Boolean(j.page_count && page < j.page_count), found: j.result_count ?? null });
  } catch (e: any) {
    return NextResponse.json({ code: 'music_search_failed', message: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
