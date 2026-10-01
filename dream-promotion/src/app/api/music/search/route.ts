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
  const qs = new URLSearchParams({
    q, page: String(page), page_size: '20', license_type: 'commercial', category: 'music', extension: 'mp3', mature: 'false',
  });
  try {
    const res = await fetch(`${API}?${qs}`, {
      headers: { 'User-Agent': 'DreamPromotion/1.0 (background music search)' },
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) return NextResponse.json({ code: 'music_search_failed', message: j?.detail || `openverse ${res.status}` }, { status: 502 });
    const tracks = (j.results ?? [])
      .filter((t: any) => t.url && (!t.duration || t.duration >= 15_000)) // under 15 s is a sound effect, not a track
      .map((t: any) => ({
        id: String(t.id), title: String(t.title || 'ללא שם'), creator: String(t.creator || ''),
        url: String(t.url), durationSec: t.duration ? Math.round(t.duration / 1000) : null,
        license: String(t.license || '').toLowerCase(), licenseVersion: t.license_version ? String(t.license_version) : '',
        attribution: String(t.attribution || `"${t.title}" by ${t.creator} (CC ${String(t.license || '').toUpperCase()})`),
        source: String(t.source || t.provider || ''), page: t.foreign_landing_url ? String(t.foreign_landing_url) : null,
      }));
    return NextResponse.json({ tracks, more: Boolean(j.page_count && page < j.page_count) });
  } catch (e: any) {
    return NextResponse.json({ code: 'music_search_failed', message: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
