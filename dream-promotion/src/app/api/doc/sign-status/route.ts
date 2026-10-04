import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';
import { certificateInfo } from '@/lib/server/sign-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Is the document-signing certificate set (Vercel env), whose is it and until when — never the key itself. */
export async function GET(req: Request) {
  if (!(await userFromRequest(req))) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  return NextResponse.json(certificateInfo());
}
