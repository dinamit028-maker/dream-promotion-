import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';
import { igContainerStep, metaAccount } from '@/lib/server/meta';

export const runtime = 'nodejs';

/** Instagram: checks the container and publishes it once Instagram has finished processing. */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const acc = await metaAccount(userId, String(body.accountId));
    return NextResponse.json(await igContainerStep(acc, String(body.containerId)));
  } catch (e: any) {
    return NextResponse.json({ code: 'status_failed', message: String(e?.message ?? e).slice(0, 300) }, { status: 502 });
  }
}
