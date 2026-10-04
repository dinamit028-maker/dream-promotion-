import { phoneDigits } from './crm';

/**
 * Meta Lead Ads → the CRM. Pure (no database, no network) so it is tested on its own.
 * A Meta lead is { id, created_time, field_data: [{ name, values }] }; the form's questions give the
 * labels ("עשית בעבר טיפול גבות?") for the field keys.
 */
export const META_LEADS_SOURCE = 'meta_lead_ads';
export const SPONSORED_TAG = 'ליד ממומן';
export const RECONNECT_FOR_LEADS = 'צריך לחבר מחדש את Meta עם הרשאת לידים';

export type MetaFieldDatum = { name: string; values?: string[] };
export type MetaLeadRaw = { id: string; created_time?: string; field_data?: MetaFieldDatum[]; ad_name?: string; form_id?: string };
export type MappedLead = {
  externalId: string; createdAt: string | null; name: string; phone: string; email: string;
  answers: { q: string; a: string }[]; adName: string;
};

/** Israeli format: +972 50-123-4567 / 0501234567 → 050-1234567, 03 1234567 → 03-1234567; foreign numbers keep +country. */
export function ilPhone(raw: string): string {
  const d = phoneDigits(raw || '');
  if (!d) return '';
  if (d.startsWith('972')) {
    const local = `0${d.slice(3)}`;
    if (/^0(5\d|7\d)\d{7}$/.test(local)) return `${local.slice(0, 3)}-${local.slice(3)}`; // mobile / 07x
    if (/^0[2-489]\d{7}$/.test(local)) return `${local.slice(0, 2)}-${local.slice(2)}`;  // landline
    return local;
  }
  return `+${d}`;
}

const NAME_KEYS = ['full_name', 'name', 'שם_מלא', 'שם'];
const PHONE_KEYS = ['phone_number', 'phone', 'mobile_phone', 'טלפון'];
const EMAIL_KEYS = ['email', 'work_email', 'אימייל', 'מייל'];
const STRUCTURAL = new Set([...NAME_KEYS, ...PHONE_KEYS, ...EMAIL_KEYS, 'first_name', 'last_name']);

/** field keys look like "did_you_do_eyebrows_before?" — the label is nicer when the form gave one */
const prettyKey = (k: string) => k.replace(/_/g, ' ').trim();

/** a custom question can still be the phone / email / name: recognised by its key or by the question's text */
const PHONE_RX = /phone|mobile|טלפון|נייד|פלאפון/i;
const EMAIL_RX = /e-?mail|מייל|אימייל|דוא"?ל/i;
const NAME_RX = /full.?name|^name$|שם מלא|^שם$/i;

/** multiple-choice answers come as keys ("כן_אבל_מזמן") — shown with spaces */
const prettyAnswer = (v: string) => v.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

export function mapMetaLead(raw: MetaLeadRaw, labels: Record<string, string> = {}): MappedLead {
  const fields = new Map<string, string>();
  for (const f of raw.field_data ?? []) fields.set(String(f.name), (f.values ?? []).map(String).join(', ').trim());
  const textOf = (k: string) => `${k} ${labels[k] ?? ''}`;
  const pick = (keys: string[], rx: RegExp) => {
    const k = keys.find((x) => fields.get(x)) ?? [...fields.keys()].find((x) => fields.get(x) && rx.test(textOf(x)));
    return k ? { key: k, value: fields.get(k)! } : null;
  };
  const phone = pick(PHONE_KEYS, PHONE_RX);
  const email = pick(EMAIL_KEYS, EMAIL_RX);
  const name = pick(NAME_KEYS, NAME_RX);
  const used = new Set([...STRUCTURAL, phone?.key, email?.key, name?.key].filter(Boolean) as string[]);
  const split = [fields.get('first_name'), fields.get('last_name')].filter(Boolean).join(' ');
  const answers = [...fields.entries()]
    .filter(([k, v]) => !used.has(k) && v)
    .map(([k, v]) => ({ q: labels[k] || prettyKey(k), a: prettyAnswer(v) }));
  return {
    externalId: String(raw.id),
    createdAt: raw.created_time ? new Date(raw.created_time).toISOString() : null,
    name: (name?.value || split || 'ליד מ-Meta').slice(0, 120),
    phone: ilPhone(phone?.value ?? ''),
    email: (email?.value ?? '').toLowerCase().slice(0, 160),
    answers,
    adName: raw.ad_name ?? '',
  };
}

/** Every answer of the form as one note on the contact card. The Meta id marks it (never added twice). */
export function leadNote(formName: string, m: MappedLead): string {
  const lines = [`ליד מטופס Meta · ${formName}${m.adName ? ` · מודעה: ${m.adName}` : ''}`];
  for (const { q, a } of m.answers) lines.push(`${q}: ${a}`);
  lines.push(`(Meta lead ${m.externalId})`);
  return lines.join('\n');
}
export const noteMarker = (externalId: string) => `(Meta lead ${externalId})`;

/**
 * What to do with each incoming lead, given what the business already has:
 *  skip     — this Meta lead was imported before (same external id), or noted on a contact before
 *  existing — a contact with the same phone exists in THIS business: no duplicate, only a note
 *  new      — create the contact
 * Two leads with the same phone in one batch: the second one becomes a note on the first.
 */
export type ImportStep = { lead: MappedLead } & ({ kind: 'skip' } | { kind: 'existing'; leadId: string } | { kind: 'new' } | { kind: 'same_batch'; firstExternalId: string });
export function planImport(
  incoming: MappedLead[],
  existing: { id: string; phone: string | null; external_id: string | null }[],
  notedExternalIds: Set<string> = new Set(),
): ImportStep[] {
  const byExternal = new Set(existing.map((l) => l.external_id).filter(Boolean) as string[]);
  const byPhone = new Map<string, string>();
  for (const l of existing) { const d = phoneDigits(l.phone ?? ''); if (d.length >= 9 && !byPhone.has(d)) byPhone.set(d, l.id); }
  const batchPhone = new Map<string, string>();
  const seen = new Set<string>();
  return incoming.map((lead) => {
    if (byExternal.has(lead.externalId) || notedExternalIds.has(lead.externalId) || seen.has(lead.externalId)) return { lead, kind: 'skip' as const };
    seen.add(lead.externalId);
    const d = phoneDigits(lead.phone);
    if (d.length >= 9 && byPhone.has(d)) return { lead, kind: 'existing' as const, leadId: byPhone.get(d)! };
    if (d.length >= 9 && batchPhone.has(d)) return { lead, kind: 'same_batch' as const, firstExternalId: batchPhone.get(d)! };
    if (d.length >= 9) batchPhone.set(d, lead.externalId);
    return { lead, kind: 'new' as const };
  });
}

/** Meta's answer for "no permission" — #200 / #10 — becomes the one clear message on screen. */
export const isLeadsPermissionError = (m: string) => /permission_denied|\(#(200|10)\)|meta_(200|10)\b|leads_retrieval/i.test(m);
