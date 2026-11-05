import { waLink } from '@/features/crm/crm';

/**
 * An invitation by link (2.114, migration 6500): the super admin adds a person ("+ אדם") and sends them a link on WhatsApp; they
 * tap it, are signed in, and choose their own password (the phone saves it). The link: /join/<64 hex>, 48 hours, used once.
 */
export const INVITE_HOURS = 48;
export const INVITE_TOKEN = /^[0-9a-f]{64}$/;
export const isInviteToken = (t: unknown): t is string => typeof t === 'string' && INVITE_TOKEN.test(t);

const ACCESS_LINE: Record<string, string> = {
  agenda: 'ליומן התורים', calendar: 'ליומן התורים וללקוחות', register: 'לקופה', full: '',
};

/** the message the super admin sends — the business's name, what it opens, the link, and how long it works */
export function inviteText(business: string, access: string, link: string): string {
  const what = ACCESS_LINE[access] ?? '';
  return `שלום, הוזמנת ${what ? `${what} ` : ''}של ${business || 'העסק'} ב-Dream.\n`
    + `לחצו על הקישור, בחרו סיסמה — והטלפון ישמור אותה:\n${link}\n`
    + `הקישור אישי, עובד פעם אחת ותקף ${INVITE_HOURS} שעות.`;
}

/** wa.me with the message to that phone, or '' when no phone was given (the link is then copied) */
export const inviteWhatsapp = (phone: string, business: string, access: string, link: string) =>
  waLink(phone, inviteText(business, access, link));

/** where an invited person starts: their screens (a limited member), else the dashboard */
export const homeOf = (access: string) => (access === 'register' ? '/register' : access === 'calendar' || access === 'agenda' ? '/appointments' : '/dashboard');

/** what the join page tells of a link the server refused */
export const JOIN_GONE: Record<string, string> = {
  not_found: 'הקישור לא תקין. בקשו קישור חדש.',
  used: 'כבר השתמשו בקישור הזה. נכנסים עם המייל והסיסמה שבחרתם — או בקשו קישור חדש.',
  expired: 'הקישור פג תוקף. בקשו קישור חדש.',
  revoked: 'נשלח קישור חדש במקום הזה — השתמשו בחדש.',
  closed: 'העסק לא פעיל כרגע.',
};
