/**
 * Client file — photos (docs/CLIENT FILE ENGINEERING HE.md §4). Pure rules, shared by the browser and the server.
 * The bucket client-files has no browser policy (migration 20261009004100): the phone uploads the original to a signed
 * link in <business>/<lead>/incoming/<id>, and the server makes the kept copy — EXIF and GPS removed, at most 2048px,
 * WebP — at <business>/<lead>/<id>.webp, then removes the original. A photo opens only through a signed link of 5
 * minutes, after the view is written in the log.
 */
export const CLIENT_BUCKET = 'client-files';
/** what a phone may send (the bucket allows these; HEIC is turned into JPEG by the phone's own file picker) */
export const PHOTO_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoInputType = (typeof PHOTO_INPUT_TYPES)[number];
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
/** the kept copy: the longest side at most this */
export const MAX_PHOTO_SIDE = 2048;
/** a signed link to a photo lives this long (seconds) */
export const PHOTO_LINK_SECONDS = 300;
/** uploads per business per Israeli day — a runaway phone or script does not fill the bucket */
export const DAILY_PHOTO_LIMIT = 300;

export const STAGES = [
  { id: 'before', label: 'לפני' },
  { id: 'process', label: 'תהליך' },
  { id: 'after', label: 'אחרי' },
] as const;
export type Stage = (typeof STAGES)[number]['id'];
export const isStage = (v: unknown): v is Stage => STAGES.some((s) => s.id === v);
export const stageLabel = (s: Stage) => STAGES.find((x) => x.id === s)?.label ?? s;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

/** where the phone puts the original, before the server cleans it */
export const incomingPath = (business: string, lead: string, id: string) => `${business}/${lead}/incoming/${id}`;
/** the kept copy (the path the database checks: <business>/<lead>/…) */
export const photoPath = (business: string, lead: string, id: string) => `${business}/${lead}/${id}.webp`;
/** a path of this business and customer only — the server checks every path it reads, signs or removes */
export const inLead = (path: string, business: string, lead: string) =>
  isUuid(business) && isUuid(lead) && path.startsWith(`${business}/${lead}/`) && !path.includes('..') && !path.includes('//');

/** what the bytes really are (never what the phone says): JPEG, PNG or WebP — else null */
export function sniffImage(b: Uint8Array): PhotoInputType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** the time a photo was taken, from the phone — only a real time, not in the future, not before 2000 (else now) */
export function cleanTakenAt(v: unknown, now = Date.now()): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t <= now + 5 * 60_000 && t >= Date.UTC(2000, 0, 1) ? new Date(t).toISOString() : new Date(now).toISOString();
}

export interface PhotoRow {
  id: string; lead_id: string; treatment_id: string | null; session_id: string | null; stage: Stage;
  width: number | null; height: number | null; taken_at: string; by_user: string | null; marketing_ok: boolean;
}
export interface TreatmentRow { id: string; lead_id: string; title: string; area: string; started_at: string; status: string; treatment_type_id: string | null }

/** the gallery: one group per treatment (newest first), photos by time; photos without a treatment last */
export function galleryGroups(photos: PhotoRow[], treatments: TreatmentRow[]): { treatment: TreatmentRow | null; photos: PhotoRow[] }[] {
  const byTime = (a: PhotoRow, b: PhotoRow) => a.taken_at.localeCompare(b.taken_at) || a.id.localeCompare(b.id);
  const known = new Set(treatments.map((t) => t.id));
  const groups = [...treatments]
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || a.id.localeCompare(b.id))
    .map((t) => ({ treatment: t as TreatmentRow | null, photos: photos.filter((p) => p.treatment_id === t.id).sort(byTime) }))
    .filter((g) => g.photos.length);
  const loose = photos.filter((p) => !p.treatment_id || !known.has(p.treatment_id)).sort(byTime);
  return loose.length ? [...groups, { treatment: null, photos: loose }] : groups;
}

/** the comparison a treatment opens with: its first "before" and its last "after" (null when one is missing) */
export function comparePair(photos: PhotoRow[]): { before: PhotoRow; after: PhotoRow } | null {
  const sorted = [...photos].sort((a, b) => a.taken_at.localeCompare(b.taken_at));
  const before = sorted.find((p) => p.stage === 'before');
  const after = [...sorted].reverse().find((p) => p.stage === 'after');
  return before && after ? { before, after } : null;
}

/** the upload queue on the phone: what is waiting, and how long to wait before the next try (weak network) */
export type QueueState = 'waiting' | 'uploading' | 'failed' | 'done';
export const retryDelay = (attempt: number) => Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
export const MAX_AUTO_RETRIES = 5;
