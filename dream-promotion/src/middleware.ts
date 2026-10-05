import { NextResponse, type NextRequest } from 'next/server';
import { legacyFinanceRedirect } from '@/features/finance/routes';

/**
 * Old finance links (/finance?tab=…, before 2.52 — push notifications, bookmarks, links saved elsewhere) move to the
 * screen's own address. Only /finance itself passes through here (see the matcher); everything else is untouched.
 */
export function middleware(req: NextRequest) {
  const to = legacyFinanceRedirect(req.nextUrl.pathname, req.nextUrl.search);
  return to ? NextResponse.redirect(new URL(to, req.nextUrl.origin)) : NextResponse.next();
}

export const config = { matcher: ['/finance'] };
