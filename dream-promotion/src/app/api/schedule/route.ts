import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { LOCKED, businessOf, userLocked } from '@/lib/server/business';
import type { Destination } from '@/lib/server/scheduler';

export const runtime = 'nodejs';

/**
 * Scheduled publishing for one content item.
 *  GET    ?contentId=  → its schedule (latest) with each destination's name and result
 *  POST   { contentId, mediaId, caption, runAt, destinations[] } → schedules (replaces a not-yet-run one)
 *  DELETE ?id=         → cancels it, if it has not started
 */
export async function GET(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const contentId = new URL(req.url).searchParams.get('contentId');
  const db = adminDb();
  const { data } = await db.from('scheduled_posts').select('id, run_at, status, destinations, results, caption, media_id, last_run_at')
    .eq('user_id', userId).eq('content_id', contentId).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return NextResponse.json({ schedule: null });
  const ids = (data.destinations as Destination[]).map((d) => d.accountId);
  const { data: accs } = await db.from('social_accounts').select('id, provider, display_name').in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  const name = new Map((accs ?? []).map((a) => [a.id, `${a.provider === 'instagram' ? 'Instagram' : a.provider === 'facebook' ? 'Facebook' : 'TikTok'} · ${a.display_name ?? ''}`]));
  return NextResponse.json({
    schedule: {
      id: data.id, runAt: data.run_at, status: data.status, lastRunAt: data.last_run_at,
      destinations: (data.destinations as Destination[]).map((d) => ({ ...d, name: name.get(d.accountId) ?? d.provider, result: (data.results as any)?.[d.accountId] ?? { state: 'waiting' } })),
    },
  });
}

export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  if (await userLocked(userId)) return NextResponse.json(LOCKED, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const db = adminDb();

  const runAt = new Date(String(body.runAt ?? ''));
  if (Number.isNaN(+runAt)) return NextResponse.json({ code: 'bad_request', message: 'bad time' }, { status: 400 });
  if (+runAt < Date.now() - 2 * 60_000) return NextResponse.json({ code: 'in_the_past', message: 'השעה שנבחרה כבר עברה' }, { status: 400 });

  const { data: media } = await db.from('media').select('id, kind').eq('id', body.mediaId).eq('user_id', userId).maybeSingle();
  if (!media || media.kind === 'audio') return NextResponse.json({ code: 'bad_media', message: 'אין קובץ לפרסום' }, { status: 400 });

  const wanted: Destination[] = (Array.isArray(body.destinations) ? body.destinations : []).slice(0, 10);
  const biz = await businessOf(userId);
  const { data: accs } = await db.from('social_accounts').select('id, provider, scope').eq('business_id', biz ?? '00000000-0000-0000-0000-000000000000').eq('status', 'active')
    .in('id', wanted.map((d) => String(d.accountId)).filter(Boolean).length ? wanted.map((d) => String(d.accountId)) : ['00000000-0000-0000-0000-000000000000']);
  const own = new Map((accs ?? []).map((a) => [a.id, a]));
  const destinations: Destination[] = wanted.filter((d) => {
    const a = own.get(String(d.accountId));
    return a && !(a.provider !== 'tiktok' && a.scope === 'read');
  }).map((d) => {
    const a = own.get(String(d.accountId))!;
    return {
      accountId: a.id, provider: a.provider as Destination['provider'],
      ...(a.provider === 'instagram' ? { target: d.target === 'story' ? 'story' as const : 'feed' as const } : {}),
      ...(Number.isFinite(+(d.coverMs as any)) ? { coverMs: Math.max(0, Math.round(+(d.coverMs as any))) } : {}),
    };
  });
  if (!destinations.length) return NextResponse.json({ code: 'no_destinations', message: 'לא נבחר יעד לפרסום' }, { status: 400 });
  if (media.kind !== 'video' && destinations.some((d) => d.provider === 'tiktok')) {
    return NextResponse.json({ code: 'bad_media', message: 'TikTok מקבל סרטונים בלבד' }, { status: 400 });
  }

  const contentId = typeof body.contentId === 'string' ? body.contentId : null;
  const row = { user_id: userId, content_id: contentId, media_id: media.id, caption: String(body.caption ?? '').slice(0, 2200), destinations, run_at: runAt.toISOString(), status: 'scheduled', results: {}, attempts: 0 };
  // one plan per item: a schedule that has not started yet is replaced
  if (contentId) await db.from('scheduled_posts').update({ status: 'cancelled' }).eq('user_id', userId).eq('content_id', contentId).eq('status', 'scheduled');
  const { data, error } = await db.from('scheduled_posts').insert(row).select('id').single();
  if (error) return NextResponse.json({ code: 'db_error', message: `${error.message} — run migration 20261001000600` }, { status: 500 });
  return NextResponse.json({ id: data.id });
}

export async function DELETE(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const id = new URL(req.url).searchParams.get('id');
  const { data } = await adminDb().from('scheduled_posts').update({ status: 'cancelled' })
    .eq('id', id).eq('user_id', userId).eq('status', 'scheduled').select('id').maybeSingle();
  return data ? NextResponse.json({ ok: true }) : NextResponse.json({ code: 'not_cancellable', message: 'הפרסום כבר התחיל או הסתיים' }, { status: 409 });
}
