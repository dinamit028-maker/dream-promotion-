import { adminDb } from './admin';
import { sendEmail } from './email';
import { notifyManagers } from './notify';
import { businessContact } from './paylink-mail';
import { emailFrom } from '@/features/store/commerce';
import { reminderEmail } from '@/features/finance/reminders';
import type { Tone } from '@/features/finance/receivables';

/**
 * Scheduled debt reminders on the dashboard's server (docs/FINANCE_ADDITIONS_HE.md T5; migration 20261010004400).
 * The timer (/api/cron/commerce, every 2 minutes) asks the database to queue what is due (debt_reminders_queue: only for a
 * business whose owner turned reminders on, only on the hours customers expect a message, each line and step once): an
 * email goes to the one outbox and out in the same run (sendQueuedEmails → here), a WhatsApp one waits for the owner — who
 * gets one phone notification per run. Just before an email goes, the database is asked again (debt_reminder_check): a debt
 * paid meanwhile, a customer marked "לא לשלוח", reminders turned off — nothing goes.
 */
type Db = ReturnType<typeof adminDb>;

/** the dashboard's own address (the email's link to the invoice): APP_URL, else Vercel's production address, else none */
export function dashboardOrigin(): string | null {
  const app = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^/?#\s]+$/.test(app)) return app;
  const v = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? '').trim();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) ? `https://${v}` : null;
}

export interface RemindersRun { cancelled: number; emails: number; whatsapp: number; quiet: boolean; pushed: number }
/** a database without migration 4400 yet: the function is not there — nothing to do (not an error every 2 minutes) */
const missing = (e: { code?: string; message?: string }) =>
  e.code === 'PGRST202' || e.code === '42883' || /debt_reminders_queue.*(does not exist|schema cache)|schema cache/i.test(String(e.message ?? ''));
export async function remindersCron(now = new Date()): Promise<RemindersRun | null> {
  const db = adminDb();
  const { data, error } = await db.rpc('debt_reminders_queue', { p_now: now.toISOString(), p_limit: 200 });
  if (error) { if (missing(error)) return null; throw new Error(error.message); }
  const r = (data ?? {}) as { cancelled?: number; emails?: number; whatsapp?: number; quiet?: boolean; businesses?: Record<string, number> };
  let pushed = 0;
  for (const [business, n] of Object.entries(r.businesses ?? {})) {
    const p = await notifyManagers(business, {
      title: 'תזכורות חוב לשליחה', body: Number(n) === 1 ? 'תזכורת אחת מחכה לשליחה בוואטסאפ' : `${n} תזכורות מחכות לשליחה בוואטסאפ`,
      url: '/finance/receivables', tag: `reminders-${business}`,
    }).catch(() => ({ sent: 0 }));
    pushed += p.sent;
  }
  return { cancelled: Number(r.cancelled ?? 0), emails: Number(r.emails ?? 0), whatsapp: Number(r.whatsapp ?? 0), quiet: Boolean(r.quiet), pushed };
}

const STATE_HE: Record<string, string> = {
  paid: 'החוב שולם', stopped: 'הלקוח/ה מסומן/ת "לא לשלוח"', off: 'התזכורות כובו', changed: 'הפריסה השתנתה', cancelled: 'התזכורת בוטלה',
  sent: 'כבר נשלחה', failed: 'נכשלה', not_found: 'לא נמצאה',
};

/** a reminder's email (email_outbox kind debt_reminder) — asked again first; nothing goes for a debt that is not open */
export async function sendReminderEmail(db: Db, e: { id: string; reminder_id?: string | null; business_id: string; to_email: string })
  : Promise<{ id: string } | { error: string; final: boolean }> {
  if (!e.reminder_id) return { error: 'no reminder', final: true };
  const { data, error } = await db.rpc('debt_reminder_check', { p_id: e.reminder_id });
  if (error) return { error: String(error.message ?? error).slice(0, 200), final: false };
  const s = (data ?? {}) as Record<string, any>;
  if (s.state !== 'ok') return { error: `לא נשלח: ${STATE_HE[String(s.state)] ?? String(s.state)}`, final: true };
  const who = await businessContact(db, e.business_id);
  // the business's store's verified sending domain, when it has one; else the platform's sending address
  const { data: st } = await db.from('stores').select('id').eq('business_id', e.business_id).order('created_at').limit(1).maybeSingle();
  let domain: { domain: string; status: string; fromName: string } | null = null;
  if (st) {
    const { data: dom } = await db.from('store_email_domains').select('domain, status, from_name').eq('store_id', (st as any).id).maybeSingle();
    if (dom) domain = { domain: (dom as any).domain, status: (dom as any).status, fromName: (dom as any).from_name ?? '' };
  }
  const from = emailFrom(who.name, domain, process.env.RESEND_FALLBACK_FROM);
  if (!from) return { error: 'אין כתובת שליחה מאומתת (מגדירים דומיין שליחה ב"מכירה באתר")', final: true };
  const origin = dashboardOrigin();
  const mail = reminderEmail({
    tone: (s.tone ?? 'friendly') as Tone, business: who.name, phone: who.phone, email: who.email, customerName: String(s.customer ?? ''),
    docType: Number(s.docType), docNumber: s.docNumber, n: s.n ?? null, of: s.of ?? null, open: Number(s.open), due: s.due ?? null,
    link: origin && s.shareToken ? `${origin}/d/${s.shareToken}` : '',
  });
  return sendEmail({ from, to: e.to_email, subject: mail.subject, html: mail.html, text: mail.text, replyTo: who.email || undefined, key: `dp-email-${e.id}` });
}
