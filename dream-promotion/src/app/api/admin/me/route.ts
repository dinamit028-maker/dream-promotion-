import { NextResponse } from 'next/server';
import { adminFromRequest } from '@/lib/server/admin-auth';

export const runtime = 'nodejs';

/** Is the signed-in user an admin? (shows or hides the admin screens; every admin API checks again) */
export async function GET(req: Request) {
  return NextResponse.json({ admin: Boolean(await adminFromRequest(req)) });
}
