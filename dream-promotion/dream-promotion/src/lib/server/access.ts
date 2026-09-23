import { NextResponse } from 'next/server';

/**
 * Minimal gate until real auth exists. If APP_ACCESS_CODE is set in the server
 * environment, every paid call must carry it in the x-access-code header —
 * otherwise anyone who finds the URL can spend your AI and video credits.
 */
export function accessDenied(req: Request) {
  const code = process.env.APP_ACCESS_CODE;
  if (!code) return null;
  if (req.headers.get('x-access-code') === code) return null;
  return NextResponse.json(
    { code: 'access_denied', message: 'Missing or wrong access code' },
    { status: 401 },
  );
}
