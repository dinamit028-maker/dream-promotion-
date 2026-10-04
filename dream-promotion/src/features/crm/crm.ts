import type { Lead, LeadActivityKind, LeadStatus } from '@/types';
import { israelParts } from '@/lib/il-time';

/** The pipeline, in order. Stored values stay as they always were; only the labels are new. */
export const STAGES: { id: LeadStatus; label: string; tone: string }[] = [
  // comments and messages from Facebook / Instagram / Messenger land here; "🔥 ליד חם" moves them on
  { id: 'פנייה', label: '💬 תגובות', tone: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300' },
  { id: 'חדש', label: 'חדש', tone: 'bg-sky-500/15 text-sky-600 dark:text-sky-300' },
  { id: 'נוצר קשר', label: 'נוצר קשר', tone: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300' },
  { id: 'מעוניין', label: 'מעוניין', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  { id: 'נקבע תור', label: 'נקבע תור', tone: 'bg-violet-500/15 text-violet-600 dark:text-violet-300' },
  { id: 'נסגר', label: 'לקוח ✓', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  { id: 'לא רלוונטי', label: 'לא רלוונטי', tone: 'bg-zinc-500/15 text-zinc-500' },
];
export const stageOf = (s: LeadStatus) => STAGES.find((x) => x.id === s) ?? STAGES[1];

export const ACTIVITY_HE: Record<LeadActivityKind, { label: string; icon: string }> = {
  note: { label: 'הערה', icon: '📝' }, call: { label: 'שיחה', icon: '📞' }, whatsapp: { label: 'וואטסאפ', icon: '💬' },
  email: { label: 'מייל', icon: '✉️' }, meeting: { label: 'פגישה', icon: '🤝' }, status: { label: 'שינוי שלב', icon: '➜' },
  purchase: { label: 'רכישה', icon: '💳' },
};

/** Israeli numbers to international digits: 050-1234567 → 972501234567; +972… kept. */
export function phoneDigits(raw: string): string {
  let d = (raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = `972${d.slice(1)}`;
  return d.replace(/\D/g, '');
}
export const telLink = (raw: string) => (raw ? `tel:${raw.replace(/[^\d+]/g, '')}` : '');
export const waLink = (raw: string, text?: string) => {
  const d = phoneDigits(raw);
  return d.length >= 9 ? `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}` : '';
};

/** overdue / today / upcoming, by Israeli calendar days */
export function followupState(l: Pick<Lead, 'nextFollowup'>, now = Date.now()): 'overdue' | 'today' | 'upcoming' | null {
  if (!l.nextFollowup) return null;
  const at = new Date(l.nextFollowup).getTime();
  if (Number.isNaN(at)) return null;
  const today = israelParts(now).date, day = israelParts(at).date;
  if (day < today) return 'overdue';
  if (day === today) return at < now ? 'overdue' : 'today';
  return 'upcoming';
}

/** search over name, phone (any format), email, tags, notes */
export function matches(l: Lead, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const digits = s.replace(/\D/g, '');
  return [l.name, l.email, l.source, l.notes, ...(l.tags ?? [])].some((v) => (v ?? '').toLowerCase().includes(s))
    || (digits.length >= 3 && phoneDigits(l.phone).includes(phoneDigits(digits)));
}

/** "Tag1, tag2 ,tag1" → ['Tag1','tag2'] */
export const parseTags = (s: string) => [...new Set(s.split(/[,،\n]/).map((t) => t.trim()).filter(Boolean))].slice(0, 12);
