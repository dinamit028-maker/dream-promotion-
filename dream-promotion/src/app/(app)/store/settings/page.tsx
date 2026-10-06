import { StoreSettings } from '@/features/store/StoreSettings';
import { cleanPlatformUrl, cleanRoot } from '@/features/store/store';

/** the root of the stores' own addresses comes from the server's environment (STORE_ROOT_DOMAIN), never from the browser */
export const dynamic = 'force-dynamic';
export default function Page() {
  return <StoreSettings root={cleanRoot(process.env.STORE_ROOT_DOMAIN)} storefrontUrl={cleanPlatformUrl(process.env.STOREFRONT_URL)} />;
}
