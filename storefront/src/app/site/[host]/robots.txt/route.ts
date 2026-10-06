import { getSite, hostOf } from '@/lib/site';

/** robots.txt of each address: a store open to everyone invites crawlers (and names its sitemap); anything else — before
 *  publishing, locked with a password, a redirecting address — closes the door */
export async function GET(_req: Request, { params }: { params: Promise<{ host: string }> }) {
  const site = await getSite(hostOf((await params).host));
  const open = site && site.via === 'public' && !site.locked && !site.platform && site.isPrimary && site.store.status === 'published';
  const body = open
    ? ['User-agent: *', 'Allow: /', 'Disallow: /search', 'Disallow: /cart', 'Disallow: /checkout', 'Disallow: /account', 'Disallow: /api/', '', `Sitemap: ${site.origin}/sitemap.xml`, ''].join('\n')
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
