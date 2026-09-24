import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** The build currently deployed. Open tabs compare it with the build they loaded. */
export function GET() {
  return NextResponse.json(
    { build: process.env.NEXT_PUBLIC_BUILD_ID ?? null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
