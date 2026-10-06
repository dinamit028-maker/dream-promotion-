import { data } from './data';
import { orderRefOk } from './order-link';
import { hashToken, isToken } from './tokens';
import type { OrderView } from './types';

/**
 * The customer's order page (/orders/<ref>): <ref> is the checkout's own token (the "back from paying" link), or the signed
 * link of an email (<order id>.<mac>, ORDER_LINK_SECRET). Anything else is "not found" — never another order.
 */
export async function orderOfRef(storeId: string, ref: string): Promise<OrderView | null> {
  if (isToken(ref)) return data.order(storeId, hashToken(ref));
  const id = orderRefOk(ref);
  return id ? data.orderById(storeId, id) : null;
}

export const FULFILLMENT_TEXT: Record<string, string> = {
  unfulfilled: 'ההזמנה התקבלה ומחכה לטיפול.', processing: 'ההזמנה בהכנה.', ready: 'ההזמנה מוכנה לאיסוף.',
  shipped: 'ההזמנה נשלחה.', delivered: 'ההזמנה נמסרה.', returned: 'ההזמנה הוחזרה.',
};
export const REQUEST_ERRORS: Record<string, string> = {
  bad_request: 'משהו בבקשה לא תקין. נסו שוב.',
  not_found: 'לא מצאנו הזמנה עם הפרטים האלה. בדקו את מספר ההזמנה ואת האימייל שאיתו הוזמן.',
  not_paid: 'אפשר לבקש ביטול או החזרה רק על הזמנה ששולמה. בשאלות — צרו איתנו קשר.',
  already: 'כבר התקבלה בקשה על ההזמנה הזו. נחזור אליכם.',
  rate: 'יותר מדי בקשות. חכו כמה דקות ונסו שוב.',
  bot: 'משהו בבקשה לא תקין. נסו שוב.',
};
