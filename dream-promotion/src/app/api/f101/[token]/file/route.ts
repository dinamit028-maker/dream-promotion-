import { businessOpen } from '@/lib/server/business';
import { MINUTE, PUBLIC_LIMITS, rateLimited } from '@/lib/server/rate-limit';
import { hashToken, isToken, sha256 } from '@/lib/server/declarations';
import { adminDb } from '@/lib/server/admin';
import { ATTACH_TYPES, FORM101_BUCKET, MAX_FILE_BYTES, linkGone, linkJson, openRequest, pendingFolder } from '@/lib/server/form101';
import { ATTACH_LABEL } from '@/features/attendance/form101';

export const runtime = 'nodejs';

/**
 * An attachment of טופס 101 (a photo of the ID, a certificate) — one file per request, before the form is signed: into the private
 * bucket, in the link's own folder; the answer is its path, which the signing POST names (and checks is really there). A photo
 * arrives resized by the page; the type is read from the file's first bytes, never from what the browser says.
 */
const MAGIC: [string, (b: Buffer) => boolean][] = [
  ['application/pdf', (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['image/heic', (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|msf1|heim|heis)$/.test(b.subarray(8, 12).toString('latin1'))],
];

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const limited = rateLimited(req, 'form101-file', PUBLIC_LIMITS.form101File, MINUTE);
  if (limited) return limited;
  if (!isToken(token)) return linkGone('not_found');
  const got = await openRequest(hashToken(token), businessOpen);
  if ('error' in got) return got.error;
  let form: FormData;
  try { form = await req.formData(); } catch { return linkJson(400, { code: 'bad_request', message: 'הקובץ לא הגיע. נסו שוב.' }); }
  const kind = String(form.get('kind') ?? '');
  const file = form.get('file');
  if (!(kind in ATTACH_LABEL) || !(file instanceof File)) return linkJson(400, { code: 'bad_request', message: 'הקובץ לא הגיע. נסו שוב.' });
  if (file.size > MAX_FILE_BYTES) return linkJson(413, { code: 'too_big', message: 'הקובץ גדול מדי (עד 4MB). צלמו שוב או שלחו PDF קטן יותר.' });
  const bytes = Buffer.from(await file.arrayBuffer());
  const type = MAGIC.find(([, ok]) => ok(bytes))?.[0];
  if (!type) return linkJson(415, { code: 'bad_type', message: 'אפשר לצרף רק תמונה (JPG / PNG / HEIC) או PDF.' });
  const path = `${pendingFolder(got.r)}/${crypto.randomUUID()}.${ATTACH_TYPES[type]}`;
  const { error } = await adminDb().storage.from(FORM101_BUCKET).upload(path, bytes, { contentType: type, upsert: false });
  if (error) return linkJson(500, { code: 'server_error', message: 'הקובץ לא נשמר. נסו שוב.' });
  return linkJson(200, { path, kind, name: String(file.name ?? '').slice(0, 120), sha256: sha256(bytes), type, size: bytes.byteLength });
}
