import type { Line } from './money';

/**
 * Held sales ("השהיית עסקה"): a cart is parked on this device so the next customer can be served,
 * then resumed exactly as it was. Kept in localStorage — per device and per business account —
 * at most MAX_HELD at a time. Nothing here touches the database; a held cart is not a sale.
 */
export const MAX_HELD = 10;
export const heldKey = (userId: string) => `dp-pos-held:${userId}`;

export interface HeldCustomer { name: string; phone: string; leadId: string | null; appointmentId: string | null }
export interface HeldSale {
  id: string; heldAt: string; lines: Line[]; customer: HeldCustomer;
  discount: { kind: 'sum' | 'percent'; value: number }; note: string; employeeId: string;
  /** an invoice to a business, when one was being filled in */
  billing?: { name: string; dealer: string; street: string; city: string } | null;
}
export type Cart = Omit<HeldSale, 'id' | 'heldAt'>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** one stored entry → a clean held sale, or null when it is not usable (old format, edited by hand, empty) */
function clean(x: any): HeldSale | null {
  if (!x || typeof x !== 'object' || !Array.isArray(x.lines)) return null;
  const KINDS = ['service', 'product', 'package', 'other'];
  const lines = x.lines.filter((l: any) => l && typeof l.name === 'string').map((l: any): Line => ({
    name: l.name, price: num(l.price), qty: Math.max(0, Math.floor(num(l.qty))),
    // the price-list link (stock, commissions) and the size / colour (2.54) survive the hold
    ...(str(l.itemId) ? { itemId: str(l.itemId) } : {}), ...(str(l.itemId) && str(l.variantId) ? { variantId: str(l.variantId) } : {}),
    ...(KINDS.includes(l.kind) ? { kind: l.kind } : {}),
  })).filter((l: Line) => l.qty > 0);
  if (!lines.length || !str(x.id)) return null;
  const c = x.customer ?? {};
  return {
    id: str(x.id), heldAt: str(x.heldAt) || new Date(0).toISOString(), lines,
    customer: { name: str(c.name), phone: str(c.phone), leadId: strOrNull(c.leadId), appointmentId: strOrNull(c.appointmentId) },
    discount: { kind: x.discount?.kind === 'percent' ? 'percent' : 'sum', value: Math.max(0, num(x.discount?.value)) },
    note: str(x.note), employeeId: str(x.employeeId),
    ...(x.billing && typeof x.billing === 'object'
      ? { billing: { name: str(x.billing.name), dealer: str(x.billing.dealer), street: str(x.billing.street), city: str(x.billing.city) } } : {}),
  };
}

/** what is stored → the list (newest first); anything broken is skipped, never thrown */
export function parseHeld(raw: string | null): HeldSale[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return (Array.isArray(v) ? v : []).map(clean).filter((h): h is HeldSale => h !== null).slice(0, MAX_HELD);
  } catch { return []; }
}

export function loadHeld(storage: StorageLike | null, userId: string): HeldSale[] {
  try { return parseHeld(storage?.getItem(heldKey(userId)) ?? null); } catch { return []; }
}
/** false when the device would not save (private mode, storage full) */
export function saveHeld(storage: StorageLike | null, userId: string, list: HeldSale[]): boolean {
  try { if (!storage) return false; storage.setItem(heldKey(userId), JSON.stringify(list)); return true; } catch { return false; }
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `h${Date.now()}${Math.random().toString(36).slice(2, 8)}`);

/** park the current cart; refused when the cart is empty or MAX_HELD are already held */
export function holdCart(list: HeldSale[], cart: Cart, now = new Date()): { ok: true; list: HeldSale[]; held: HeldSale } | { ok: false; error: 'empty' | 'full' } {
  const held = clean({ ...cart, id: newId(), heldAt: now.toISOString() });
  if (!held) return { ok: false, error: 'empty' };
  if (list.length >= MAX_HELD) return { ok: false, error: 'full' };
  return { ok: true, list: [held, ...list], held };
}

export const removeHeld = (list: HeldSale[], id: string) => list.filter((h) => h.id !== id);

/**
 * take a held cart back to the register. When `current` is given (a cart already in progress that the
 * cashier chose to keep), it is parked in its place — the list never grows, so the limit cannot be hit.
 */
export function resumeHeld(list: HeldSale[], id: string, current: Cart | null = null, now = new Date()): { cart: Cart; list: HeldSale[] } | null {
  const h = list.find((x) => x.id === id);
  if (!h) return null;
  let rest = removeHeld(list, id);
  if (current) { const r = holdCart(rest, current, now); if (r.ok) rest = r.list; }
  const { id: _id, heldAt: _at, ...cart } = h;
  return { cart, list: rest };
}
