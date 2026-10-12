import {
  ArrowsClockwise, Bank, Briefcase, ChartBar, ChartPieSlice, ClipboardText, Coins, FileText, GearSix, HandCoins, Hourglass, Notebook, Package, Receipt, ShoppingCart,
  TrendUp, Truck, Vault, Wallet,
} from '@/components/ui/Icon';
import type { ModuleAction, ModuleConfig, ModuleGroup } from '@/components/shell/module-nav';
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
export function financeActions(entity?: EntityType, o: { goods?: boolean } = {}): ModuleAction[] {
  const vat = entity ? chargesVat(entity) : true;
  const doc = (type: number, label: string, Icon: ModuleAction['Icon']): ModuleAction =>
    ({ id: `doc-${type}`, label, Icon, href: financeHref('documents', { new: String(type) }) });
  const docs = vat
    ? [doc(305, 'חשבונית מס', FileText), doc(320, 'חשבונית מס / קבלה', Receipt),
      { id: 'doc-400', label: 'קבלה', Icon: HandCoins, hint: 'על חשבונית ששולמה — מתוך "חייבים"', href: financeHref('receivables', { receipt: '1' }) }]
    : [doc(300, 'חשבונית עסקה', FileText), doc(400, 'קבלה', HandCoins)];
  // 2.95 (T10): a business that sells products — an order and a delivery note (a return note is made from its delivery note)
  const goods = o.goods ? [doc(100, 'הזמנה', ClipboardText), doc(200, 'תעודת משלוח', Truck)] : [];
  return [
    ...docs,
    ...goods,
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

/**
 * 2.95 (T9): the desks, deposits, cheques and the bank — a group of the menu only once the business turned them on (the money
 * settings): a business that did not sees the menu as it was. FinanceScreen hands the shell these groups (useModuleGroups).
 */
export const CASH_GROUP: ModuleGroup = {
  id: 'cash', label: 'קופות ובנק', Icon: Vault, links: [
    { href: financeHref('cash'), label: 'קופות והפקדות', Icon: Vault },
    { href: financeHref('bank'), label: 'התאמת בנק', Icon: Bank },
  ],
};
/** 2.96 (T13א): manual journal entries — in "דוחות ורואה חשבון" once migration 20261011005100 is in the database (every business) */
export const JOURNAL_LINK: ModuleGroup['links'][number] = { href: financeHref('journal'), label: 'פקודות יומן', Icon: Notebook };
/** the module's groups — with the desks' group after the expenses when they are on, and the journal once it is in the database */
export function financeGroups(o: { cash: boolean; journal?: boolean }): ModuleGroup[] {
  let groups = FINANCE_MODULE.groups;
  if (o.journal) groups = groups.map((g) => (g.id === 'reports' ? { ...g, links: [...g.links, JOURNAL_LINK] } : g));
  if (!o.cash) return groups;
  const at = groups.findIndex((g) => g.id === 'expenses') + 1;
  return [...groups.slice(0, at), CASH_GROUP, ...groups.slice(at)];
}
