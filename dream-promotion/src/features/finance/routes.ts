/**
 * The finance module's addresses (2.52): every screen has its own route, so a link, a refresh and the phone's back
 * button all land on the same screen. Old links (/finance?tab=…, from before 2.52 — notifications, bookmarks, the CRM
 * card) are moved to the new address by src/middleware.ts with legacyFinanceRedirect().
 * Pure functions only: the middleware runs on the edge.
 */
export type FinanceSection = 'overview' | 'documents' | 'income' | 'receivables' | 'quotes' | 'expenses' | 'reports' | 'accountant' | 'settings';

export const FINANCE_SECTIONS: readonly { id: FinanceSection; path: string; label: string }[] = [
  { id: 'overview', path: '/finance', label: 'לובי כספים' },
  { id: 'documents', path: '/finance/documents', label: 'מסמכים' },
  { id: 'income', path: '/finance/income', label: 'הכנסות' },
  { id: 'receivables', path: '/finance/receivables', label: 'חייבים' },
  { id: 'quotes', path: '/finance/quotes', label: 'הצעות מחיר' },
  { id: 'expenses', path: '/finance/expenses', label: 'הוצאות' },
  { id: 'reports', path: '/finance/reports', label: 'דוחות' },
  { id: 'accountant', path: '/finance/accountant', label: 'רואה חשבון' },
  { id: 'settings', path: '/finance/settings', label: 'הגדרות כספים' },
];
const BY_ID = new Map(FINANCE_SECTIONS.map((s) => [s.id, s]));
const trim = (p: string) => p.replace(/\/+$/, '') || '/';

/** /finance and everything under it: the shell shows the finance module instead of the app's own menus */
export const isFinancePath = (pathname: string) => { const p = trim(pathname); return p === '/finance' || p.startsWith('/finance/'); };

export const financeLabel = (section: FinanceSection) => BY_ID.get(section)?.label ?? 'כספים';

/** the address of a screen, with its query (?new=305&lead=…) */
export function financeHref(section: FinanceSection, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `${BY_ID.get(section)?.path ?? '/finance'}${q ? `?${q}` : ''}`;
}

/** the screen at an address (a trailing slash is fine); null outside the module or for an address it does not have */
export function sectionOfPath(pathname: string): FinanceSection | null {
  const p = trim(pathname);
  return FINANCE_SECTIONS.find((s) => s.path === p)?.id ?? null;
}

/**
 * /finance?tab=documents&new=1&lead=… → /finance/documents?new=1&lead=… (every other query value stays).
 * null when there is nothing to move — so a redirect can never loop. An unknown tab goes to the lobby.
 */
export function legacyFinanceRedirect(pathname: string, search: string): string | null {
  if (trim(pathname) !== '/finance') return null;
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const tab = q.get('tab');
  if (tab === null) return null;
  q.delete('tab');
  const to = BY_ID.get(tab as FinanceSection) ?? BY_ID.get('overview')!;
  const rest = q.toString();
  return `${to.path}${rest ? `?${rest}` : ''}`;
}
