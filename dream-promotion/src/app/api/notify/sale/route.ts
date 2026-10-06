import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { pushToUser } from '@/lib/server/push';
import { workBusiness } from '@/lib/server/business';
import { notifyManagers } from '@/lib/server/notify';
import { lowStockList, stockText, type StockItem } from '@/features/register/stock';

export const runtime = 'nodejs';
const ils = (n: number) => `₪${Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 })}`;
const METHOD: Record<string, string> = { cash: 'מזומן', card: 'אשראי', transfer: 'העברה', bit: 'Bit', link: 'בקשת תשלום', other: 'אחר', split: 'פיצול' };

/**
 * "a sale was made" → the phones of the business's managers (full-access members) — also when a cashier sold.
 * The sale is read from the database (never trusted from the client). When the sale left a product at or
 * under its alert level, a second notification says what is running out.
 */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'unauthorized' }, { status: 401 });
  const { saleId } = await req.json().catch(() => ({}));
  const businessId = await workBusiness(userId);
  const db = adminDb();
  const { data: s } = await db.from('sales').select('total, method, status, customer_name, employee_name, items').eq('id', String(saleId ?? '')).eq('business_id', businessId).maybeSingle();
  if (!s) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  const items: { name: string; itemId?: string }[] = Array.isArray((s as any).items) ? (s as any).items : [];
  const what = items.map((l) => l.name).slice(0, 3).join(', ');
  const sale = {
    title: s.status === 'pending' ? `בקשת תשלום ${ils(s.total)}` : `💰 עסקה חדשה ${ils(s.total)}`,
    body: [s.customer_name || 'לקוח מזדמן', METHOD[s.method] ?? s.method, what, s.employee_name ? `מוכר/ת: ${s.employee_name}` : ''].filter(Boolean).join(' · '),
    url: '/register', tag: `sale-${saleId}`,
  };
  const { sent, to } = await notifyManagers(businessId, sale, userId);

  // low stock: only the products of this sale, only when they are tracked
  const ids = [...new Set(items.map((l) => l.itemId).filter((x): x is string => Boolean(x)))];
  let low: string[] = [];
  if (ids.length) {
    const { data: cat, error } = await db.from('catalog_items').select('id, name, track_stock, stock_qty, low_stock').in('id', ids).eq('business_id', businessId);
    if (!error) {
      const list: StockItem[] = (cat ?? []).map((c: any) => ({ id: c.id, name: c.name, trackStock: Boolean(c.track_stock), stockQty: Number(c.stock_qty ?? 0), lowStock: Number(c.low_stock ?? 0) }));
      low = lowStockList(list).map((i) => `${i.name}: ${stockText(i)}`);
    }
  }
  if (low.length) for (const u of to) await pushToUser(u, { title: '⚠️ מלאי נמוך', body: low.join(' · '), url: '/register', tag: `stock-${ids.join('-').slice(0, 40)}` });
  return NextResponse.json({ sent, lowStock: low });
}
