import {
  ArrowsClockwise, Briefcase, ChartBar, ChartPieSlice, ClipboardText, Coins, FileText, GearSix, HandCoins, Hourglass, Package, Receipt, ShoppingCart, TrendUp, Wallet,
} from '@/components/ui/Icon';
import type { ModuleAction, ModuleConfig } from '@/components/shell/module-nav';
import { financeHref } from './routes';
import { chargesVat, type EntityType } from './rules';

/**
 * "כספים" as an app of its own (2.52, ModuleShell): its menu, its bottom bar and its "+".
 * Every screen of routes.ts is in the menu exactly once (tests/module-shell.test.ts keeps it so).
 */

/**
 * "+": the documents this business may issue (an exempt dealer: transaction invoice and receipt), a quote, an expense —
 * each opens the form that already issues it.
 * A receipt of a VAT business is issued on the invoice that was paid ("קבלה על תשלום" — the composer offers no
 * stand-alone 400 when VAT is charged, Composer.tsx), so its "+" opens "חייבים" and says so.
 */
export function financeActions(entity?: EntityType): ModuleAction[] {
  const vat = entity ? chargesVat(entity) : true;
  const doc = (type: number, label: string, Icon: ModuleAction['Icon']): ModuleAction =>
    ({ id: `doc-${type}`, label, Icon, href: financeHref('documents', { new: String(type) }) });
  const docs = vat
    ? [doc(305, 'חשבונית מס', FileText), doc(320, 'חשבונית מס / קבלה', Receipt),
      { id: 'doc-400', label: 'קבלה', Icon: HandCoins, hint: 'על חשבונית ששולמה — מתוך "חייבים"', href: financeHref('receivables', { receipt: '1' }) }]
    : [doc(300, 'חשבונית עסקה', FileText), doc(400, 'קבלה', HandCoins)];
  return [
    ...docs,
    { id: 'quote', label: 'הצעת מחיר', Icon: ClipboardText, href: financeHref('quotes', { new: '1' }) },
    { id: 'expense', label: 'הוצאה', Icon: ShoppingCart, href: financeHref('expenses', { new: '1' }) },
  ];
}

export const FINANCE_MODULE: ModuleConfig = {
  id: 'finance',
  name: 'כספים',
  theme: 'module-finance',
  home: financeHref('overview'),
  Icon: Wallet,
  groups: [
    { id: 'lobby', label: 'לובי כספים', Icon: ChartPieSlice, links: [{ href: financeHref('overview'), label: 'לובי כספים', Icon: ChartPieSlice }] },
    {
      id: 'income', label: 'הכנסות', Icon: TrendUp, links: [
        { href: financeHref('documents'), label: 'מסמכים', Icon: FileText },
        { href: financeHref('income'), label: 'הכנסות', Icon: Coins },
        { href: financeHref('receivables'), label: 'חייבים', Icon: Hourglass },
        { href: financeHref('quotes'), label: 'הצעות מחיר', Icon: ClipboardText },
        { href: financeHref('packages'), label: 'חבילות', Icon: Package },
        { href: financeHref('recurring'), label: 'חיובים חוזרים', Icon: ArrowsClockwise },
      ],
    },
    { id: 'expenses', label: 'הוצאות', Icon: Receipt, links: [{ href: financeHref('expenses'), label: 'הוצאות', Icon: Receipt }] },
    {
      id: 'reports', label: 'דוחות ורואה חשבון', Icon: ChartBar, links: [
        { href: financeHref('reports'), label: 'דוחות', Icon: ChartBar },
        { href: financeHref('accountant'), label: 'רואה חשבון', Icon: Briefcase },
      ],
    },
    { id: 'settings', label: 'הגדרות כספים', Icon: GearSix, links: [{ href: financeHref('settings'), label: 'הגדרות כספים', Icon: GearSix }] },
  ],
  tabs: [
    { href: financeHref('overview'), label: 'לובי', Icon: ChartPieSlice },
    { href: financeHref('income'), label: 'הכנסות', Icon: Coins },
    { href: financeHref('expenses'), label: 'הוצאות', Icon: Receipt },
    { href: financeHref('receivables'), label: 'חייבים', Icon: Hourglass },
  ],
  actions: financeActions(),
};
