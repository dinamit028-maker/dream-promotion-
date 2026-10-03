import webpush from 'web-push';
import { adminDb } from './admin';

/**
 * Phone notifications for the business owner (Web Push — free, no third-party service).
 * Env: NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…).
 * Dead subscriptions (uninstalled / permission revoked → 404/410) are removed automatically.
 */
export const pushConfigured = () => Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

export async function pushToUser(userId: string, payload: { title: string; body: string; url?: string; tag?: string }) {
  if (!pushConfigured()) return { sent: 0, skipped: 'not_configured' as const };
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@dream-promotion.app', process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  const db = adminDb();
  const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, keys').eq('user_id', userId);
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s: any) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from('push_subscriptions').delete().eq('id', s.id);
      else console.error('[push]', e?.statusCode, String(e?.body ?? e?.message ?? e).slice(0, 160));
    }
  }));
  return { sent };
}
