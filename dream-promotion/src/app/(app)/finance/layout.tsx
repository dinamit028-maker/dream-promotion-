import { FinanceLayout } from '@/features/finance/FinanceScreen';

/** every screen of "כספים" (2.52): one layout loads the money settings once, the screens are real addresses */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <FinanceLayout>{children}</FinanceLayout>;
}
