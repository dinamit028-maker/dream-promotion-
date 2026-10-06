import { getSite, hostOf } from '@/lib/site';

/** robots.txt of each domain: a store on the air invites crawlers (and names its sitemap); anything else closes the door */
export async function GET(_req: Request, { params }: { params: Promise<{ host: string }> }) {
  const site = await getSite(hostOf((await params).host));
  const open = site && !site.preview && !site.platform && site.isPrimary && site.store.status === 'published';
  const body = open
    ? ['User-agent: *', 'Allow: /', 'Disallow: /search', 'Disallow: /cart', 'Disallow: /checkout', 'Disallow: /account', 'Disallow: /api/', '', `Sitemap: ${site.origin}/sitemap.xml`, ''].join('\n')
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
