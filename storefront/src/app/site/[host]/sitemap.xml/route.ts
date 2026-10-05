import { data } from '@/lib/data';
import { getSite, hostOf } from '@/lib/site';

/** every address of a store on the air, with its last change — the address Search Console gets once */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '');

export async function GET(_req: Request, { params }: { params: Promise<{ host: string }> }) {
  const site = await getSite(hostOf((await params).host));
  const map = site && !site.preview && !site.platform && site.isPrimary ? await data.sitemap(site.storeId) : null;
  if (!site || !map) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const o = site.origin;
  const urls: [string, string][] = [
    [`${o}/`, day(map.store)],
    [`${o}/collections/all`, ''],
    ...map.collections.map((c) => [`${o}/collections/${encodeURIComponent(c.slug)}`, day(c.updated_at)] as [string, string]),
    ...map.products.map((p) => [`${o}/products/${encodeURIComponent(p.slug)}`, day(p.updated_at)] as [string, string]),
    ...map.pages.map((g) => [g.kind === 'policy' ? `${o}/policies/${g.policy}` : `${o}/pages/${encodeURIComponent(g.slug)}`, day(g.updated_at)] as [string, string]),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map(([loc, mod]) => `  <url><loc>${esc(loc)}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
