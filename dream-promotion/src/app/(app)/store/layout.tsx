import { StoreLayout } from '@/features/store/StoreLayout';

/** every screen of "חנות" (2.54): signed-in members who may manage products; a cashier is sent back to the register */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <StoreLayout>{children}</StoreLayout>;
}
