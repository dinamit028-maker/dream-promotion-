import { notFound } from 'next/navigation';
import { decodeSlug, getSite, hostOf, movedOr404 } from '@/lib/site';

/** any other address: a 301 if it moved (store_redirects), else 404 */
type Props = { params: Promise<{ host: string; rest: string[] }> };

export default async function Elsewhere({ params }: Props) {
  const { host, rest } = await params;
  const site = await getSite(hostOf(host));
  if (!site?.live) notFound();
  return movedOr404(site, `/${rest.map(decodeSlug).join('/')}`);
}
