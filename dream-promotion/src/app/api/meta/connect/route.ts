import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';
import { signState } from '@/lib/server/secrets';
import { metaAuthorizeUrl, metaConfigured } from '@/lib/server/meta';

export const runtime = 'nodejs';

/** Starts "connect Instagram & Facebook". mode "full" = publish + read, "read" = read only. */
export async function POST(req: Request) {
  if (!metaConfigured()) return NextResponse.json({ code: 'not_configured', message: 'META_APP_ID / META_APP_SECRET / META_CONFIG_FULL missing' }, { status: 503 });
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session', message: 'sign in required' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const mode = body.mode === 'read' ? 'read' : 'full';
  try {
    return NextResponse.json({ url: metaAuthorizeUrl(req, mode, signState({ u: userId, p: 'meta', m: mode })) });
  } catch {
    return NextResponse.json({ code: 'not_configured', message: 'META_CONFIG_READ missing' }, { status: 503 });
  }
}
