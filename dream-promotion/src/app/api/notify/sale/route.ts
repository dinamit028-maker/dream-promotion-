import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { pushToUser } from '@/lib/server/push';
import { workBusiness } from '@/lib/server/business';

export const runtime = 'nodejs';
const ils = (n: number) => `₪${Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 })}`;
const METHOD: Record<string, string> = { cash: 'מזומן', card: 'אשראי', transfer: 'העברה', bit: 'Bit', link: 'בקשת תשלום', other: 'אחר', split: 'פיצול' };

/** "a sale was made" → the owner's phones. The sale is read from the database (never trusted from the client). */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'unauthorized' }, { status: 401 });
  const { saleId } = await req.json().catch(() => ({}));
  const { data: s } = await adminDb().from('sales').select('total, method, status, customer_name, employee_name, items').eq('id', String(saleId ?? '')).eq('business_id', await workBusiness(userId)).maybeSingle();
  if (!s) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  const what = ((s as any).items ?? []).map((l: any) => l.name).slice(0, 3).join(', ');
  const r = await pushToUser(userId, {
    title: s.status === 'pending' ? `בקשת תשלום ${ils(s.total)}` : `💰 עסקה חדשה ${ils(s.total)}`,
    body: [s.customer_name || 'לקוח מזדמן', METHOD[s.method] ?? s.method, what, s.employee_name ? `מוכר/ת: ${s.employee_name}` : ''].filter(Boolean).join(' · '),
    url: '/register', tag: `sale-${saleId}`,
  });
  return NextResponse.json(r);
}
