'use client';
import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';

/** The owner's phones get a notification on every sale (Web Push via /sw.js). */
const KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const pushKeyReady = () => Boolean(KEY);
/** iPhone allows web notifications only from the home-screen app (iOS 16.4+) */
export const needsHomeScreen = () => typeof navigator !== 'undefined' && /iPhone|iPad/.test(navigator.userAgent) && !(window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone);

const b64ToBytes = (b64: string) => { const p = '='.repeat((4 - (b64.length % 4)) % 4); const s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
const deviceLabel = () => { const u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'מכשיר'; };

export async function enablePush(userId: string): Promise<{ ok: boolean; message: string }> {
  if (!pushSupported()) return { ok: false, message: 'הדפדפן הזה לא תומך בהתראות.' };
  if (needsHomeScreen()) return { ok: false, message: 'באייפון: קודם "שיתוף ← הוספה למסך הבית", ואז לפתוח את האפליקציה מהמסך הבית ולהפעיל כאן.' };
  if (!KEY) return { ok: false, message: 'חסרים מפתחות התראות ב-Vercel (VAPID).' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, message: 'ההרשאה להתראות לא אושרה. אפשר לאשר בהגדרות הדפדפן.' };
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(KEY) });
  const j = sub.toJSON();
  const { error } = await supabase().from('push_subscriptions').upsert({ user_id: userId, endpoint: j.endpoint, keys: j.keys, label: deviceLabel() }, { onConflict: 'endpoint' });
  if (error) return { ok: false, message: /relation .* does not exist|schema cache/i.test(error.message) ? 'צריך להריץ את מיגרציה 20261003001600 ב-Supabase.' : 'לא נשמר. נסו שוב.' };
  return { ok: true, message: 'ההתראות הופעלו במכשיר הזה.' };
}
export async function sendTest() {
  const r = await fetch('/api/notify/test', { method: 'POST', headers: await authHeaders() });
  const j = await r.json().catch(() => ({}));
  return r.ok ? (j.sent ? `נשלחה התראת ניסיון ל-${j.sent} מכשירים.` : 'אין מכשירים מחוברים.') : (j.message || 'לא נשלח.');
}
/** fire-and-forget after every sale */
export async function notifySale(saleId: string) {
  try { await fetch('/api/notify/sale', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ saleId }) }); } catch { /* a notification must never block a sale */ }
}
