import { israelParts } from '@/lib/il-time';

/**
 * Register math — whole agorot internally, so 0.1 + 0.2 never becomes 0.30000000000000004.
 * Prices are VAT-inclusive (as customers see them in Israel). A licensed dealer's VAT is the part of
 * the total that is tax: total × rate / (100 + rate). An exempt dealer charges no VAT.
 */
export type Method = 'cash' | 'transfer' | 'bit' | 'card' | 'link' | 'other';
export const METHODS: { id: Method; label: string; icon: string }[] = [
  { id: 'cash', label: 'מזומן', icon: '💵' }, { id: 'bit', label: 'Bit / PayBox', icon: '📱' },
  { id: 'transfer', label: 'העברה', icon: '🏦' }, { id: 'card', label: 'אשראי (מסוף)', icon: '💳' },
  { id: 'link', label: 'קישור תשלום', icon: '🔗' }, { id: 'other', label: 'אחר', icon: '•' },
];
export const methodLabel = (m: Method) => METHODS.find((x) => x.id === m)?.label ?? m;

export interface Line { name: string; price: number; qty: number }
export interface Sale {
  id: string; leadId: string | null; appointmentId: string | null; customerName: string; customerPhone: string;
  items: Line[]; subtotal: number; discount: number; total: number; vatRate: number; vatAmount: number;
  method: Method; status: 'paid' | 'pending' | 'cancelled'; note: string; paidAt: string | null; createdAt: string;
}

const ag = (n: number) => Math.round((Number(n) || 0) * 100);
const sh = (a: number) => a / 100;
export const ils = (n: number) => `₪${(Math.round(n * 100) / 100).toLocaleString('he-IL', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** totals of a sale; discount as a sum (₪) or a percent, never more than the subtotal */
export function computeSale(lines: Line[], discount: { kind: 'sum' | 'percent'; value: number }, vat: { type: 'exempt' | 'licensed'; rate: number }) {
  const subA = lines.reduce((a, l) => a + ag(l.price) * Math.max(0, Math.floor(l.qty || 0)), 0);
  const dRaw = discount.kind === 'percent' ? Math.round(subA * Math.min(100, Math.max(0, discount.value)) / 100) : ag(Math.max(0, discount.value));
  const discA = Math.min(subA, dRaw);
  const totA = subA - discA;
  const rate = vat.type === 'licensed' ? vat.rate : 0;
  const vatA = rate ? Math.round((totA * rate) / (100 + rate)) : 0;
  return { subtotal: sh(subA), discount: sh(discA), total: sh(totA), vatRate: rate, vatAmount: sh(vatA), beforeVat: sh(totA - vatA) };
}

export const saleDay = (s: Pick<Sale, 'createdAt' | 'paidAt'>) => israelParts(new Date(s.paidAt ?? s.createdAt)).date;

/** the day / month summary: paid totals by method, VAT, open (pending) sums */
export function summarize(sales: Sale[], fromDay: string, toDay: string) {
  const inRange = sales.filter((s) => s.status !== 'cancelled' && saleDay(s) >= fromDay && saleDay(s) <= toDay);
  const paid = inRange.filter((s) => s.status === 'paid');
  const byMethod = new Map<Method, { count: number; totalA: number }>();
  for (const s of paid) { const m = byMethod.get(s.method) ?? { count: 0, totalA: 0 }; m.count++; m.totalA += ag(s.total); byMethod.set(s.method, m); }
  return {
    count: paid.length,
    total: sh(paid.reduce((a, s) => a + ag(s.total), 0)),
    vat: sh(paid.reduce((a, s) => a + ag(s.vatAmount), 0)),
    discounts: sh(paid.reduce((a, s) => a + ag(s.discount), 0)),
    byMethod: [...byMethod.entries()].map(([method, v]) => ({ method, count: v.count, total: sh(v.totalA) })).sort((a, b) => b.total - a.total),
    pendingCount: inRange.filter((s) => s.status === 'pending').length,
    pendingTotal: sh(inRange.filter((s) => s.status === 'pending').reduce((a, s) => a + ag(s.total), 0)),
  };
}

/** CSV for the accountant (UTF-8 BOM). Records only — the tax documents come from the invoicing service. */
export function salesCsv(sales: Sale[], fromDay: string, toDay: string) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const st = { paid: 'שולם', pending: 'ממתין לתשלום', cancelled: 'בוטל' } as const;
  const rows = sales.filter((s) => saleDay(s) >= fromDay && saleDay(s) <= toDay).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => [saleDay(s), israelParts(new Date(s.paidAt ?? s.createdAt)).time, s.customerName, s.items.map((l) => `${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(' + '),
      s.subtotal.toFixed(2), s.discount.toFixed(2), s.total.toFixed(2), s.vatAmount.toFixed(2), methodLabel(s.method), st[s.status], s.note].map(esc).join(','));
  return '\uFEFF' + ['תאריך,שעה,לקוח,פריטים,לפני הנחה,הנחה,סה״כ,מתוכו מע״מ,אמצעי תשלום,סטטוס,הערה', ...rows].join('\r\n');
}

/** WhatsApp text asking the customer to pay, with the business's payment link */
export const payRequestText = (p: { name: string; total: number; items: string; business: string; link: string }) =>
  `היי ${p.name.split(' ')[0] || ''}, תודה שבחרת ב${p.business}! 🙏\nלתשלום על ${p.items}: ${ils(p.total)}\n${p.link}`;
