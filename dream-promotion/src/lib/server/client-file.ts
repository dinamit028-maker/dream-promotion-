import sharp from 'sharp';
import { adminDb, userFromRequest } from './admin';
import { isSuperAdmin, memberRole, userLocked, workBusiness, LOCKED, VIEW_ONLY } from './business';
import { MAX_PHOTO_BYTES, MAX_PHOTO_SIDE, isUuid, sniffImage } from '@/features/client-file/photos';

/**
 * Client file on the server (docs/CLIENT FILE ENGINEERING HE.md). The routes use the service role, so the rule of the
 * database is asked here too: client_files_allowed_for(user, business) — the owner, or a practitioner the owner marked,
 * with full access (never a cashier), in the business the user works in NOW (never one sent by the browser).
 */
export const NO_ACCESS = { code: 'no_access', message: 'תיק הלקוח פתוח רק לבעלי העסק ולמטפלים שהבעלים סימן.' } as const;
export const NOT_READY = { code: 'not_ready', message: 'תיק הלקוח עוד לא הופעל במערכת.' } as const;

export type ClientFileCaller =
  | { ok: true; userId: string; business: string }
  | { ok: false; status: number; body: { code: string; message: string } };

/** a missing table or function: the migration of the client file is not in this database yet */
export const notInstalled = (e: { code?: string; message?: string } | null | undefined) =>
  Boolean(e && (e.code === '42P01' || e.code === '42883' || e.code === 'PGRST202' || e.code === 'PGRST205'));

export async function clientFileCaller(req: Request, opts: { write?: boolean } = {}): Promise<ClientFileCaller> {
  const userId = await userFromRequest(req);
  if (!userId) return { ok: false, status: 401, body: { code: 'no_session', message: 'צריך להתחבר מחדש.' } };
  if (await userLocked(userId)) return { ok: false, status: 403, body: LOCKED };
  const business = await workBusiness(userId);
  if (!isUuid(business)) return { ok: false, status: 403, body: { code: 'no_business', message: 'החשבון לא משויך לעסק.' } };
  const { data, error } = await adminDb().rpc('client_files_allowed_for', { p_user: userId, p_business: business });
  if (notInstalled(error)) return { ok: false, status: 404, body: NOT_READY };
  if (error || data !== true) return { ok: false, status: 403, body: NO_ACCESS };
  // a super admin who is a member counts by the membership (the database said yes); a viewer reads, never writes
  if (opts.write && !(await isSuperAdmin(userId)) && (await memberRole(userId, business)) === 'viewer') {
    return { ok: false, status: 403, body: VIEW_ONLY };
  }
  return { ok: true, userId, business };
}

export class PhotoError extends Error {
  constructor(public code: 'too_big' | 'not_image' | 'broken', message: string) { super(message); }
}

/**
 * The copy that is kept: what the bytes really are (not the phone's word), turned upright by its EXIF orientation,
 * at most 2048px, WebP — and NO metadata at all (EXIF, GPS, XMP, ICC profile, comments): sharp writes none unless asked.
 */
export async function cleanPhoto(bytes: Uint8Array): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new PhotoError('too_big', 'התמונה גדולה מ-15MB.');
  if (!sniffImage(bytes)) throw new PhotoError('not_image', 'הקובץ אינו תמונה (JPEG, PNG או WebP).');
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: 80_000_000, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_PHOTO_SIDE, height: MAX_PHOTO_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height };
  } catch {
    throw new PhotoError('broken', 'לא הצלחנו לקרוא את התמונה. נסו לצלם שוב.');
  }
}

/** the start of today in Israel, as an ISO time (the daily upload limit counts from it) */
export function israelDayStart(now = new Date()): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
  // midnight in Israel = 22:00 or 21:00 UTC the day before; find it by the offset at noon of that day
  const noon = new Date(`${day}T12:00:00Z`);
  const ilNoon = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(noon);
  const offsetHours = Number(ilNoon) - 12;
  return new Date(Date.parse(`${day}T00:00:00Z`) - offsetHours * 3_600_000).toISOString();
}

/** the business's name as its customers know it: the brand, else the business record */
export async function businessName(business: string): Promise<string> {
  const db = adminDb();
  const { data: b } = await db.from('brands').select('name').eq('business_id', business).limit(1).maybeSingle();
  const brand = String((b as { name?: string } | null)?.name ?? '').trim();
  if (brand) return brand;
  const { data: r } = await db.from('businesses').select('name').eq('id', business).maybeSingle();
  return String((r as { name?: string } | null)?.name ?? '').trim();
}

/** may this user approve templates, archive them and read the view log? (the owner — as client_file_owner_for) */
export async function isClientFileOwner(userId: string, business: string): Promise<boolean> {
  const { data } = await adminDb().rpc('client_file_owner_for', { p_user: userId, p_business: business });
  return data === true;
}
