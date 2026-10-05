import Anthropic from '@anthropic-ai/sdk';
import { financeCaller } from '@/lib/server/finance';
import { commitUsage, releaseUsage, reserveUsage, type Reservation } from '@/lib/server/quota';
import { PRICES, SCAN_MODEL } from '@/lib/server/ai/config';
import { logGeneration } from '@/lib/server/ai/ledger';
import { EXPENSE_CATEGORIES, SUPPLIER_DOC_TYPES, sanitizeExtraction } from '@/features/finance/expenses';
import { israelParts } from '@/lib/il-time';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * "✨ קריאה אוטומטית" of a supplier's invoice / receipt (a photo or a PDF) for the expense form.
 * The answer only FILLS THE FORM in the browser: nothing is saved here, every value is checked by sanitizeExtraction
 * (a dealer number must pass its check digit, a date must be real and not in the future, the amounts must add up — or
 * the field stays empty), and the user confirms every field before the expense exists. The file itself is uploaded to
 * the business's private bucket by the browser only when the user saves.
 * Same gates as every money route: the business worked in now, its money open to the caller, never a cashier;
 * counted against the AI quota like every AI call.
 */
const KEY = process.env.ANTHROPIC_API_KEY;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
const MAX_BYTES = 8 * 1024 * 1024;

const prompt = (today: string) => `You read ONE Israeli supplier document (invoice, receipt, tax invoice-receipt or credit note) for a small business's bookkeeping.
Answer with ONLY a JSON object with exactly these keys. Use null for anything you cannot read with certainty — never guess, never calculate a value that is not printed:
{
  "supplierName": string | null,
  "supplierDealer": string | null,      // the supplier's 9-digit dealer / company number (עוסק מורשה / ח.פ), digits only
  "supplierDocType": ${SUPPLIER_DOC_TYPES.map((t) => `"${t.id}"`).join(' | ')} | null,   // חשבונית מס / חשבונית מס-קבלה / קבלה / חשבונית עסקה / זיכוי / other
  "supplierDocNumber": string | null,
  "allocationNumber": string | null,    // "מספר הקצאה", only if printed
  "docDate": "YYYY-MM-DD" | null,       // dates in Israel are printed day first (DD/MM/YYYY)
  "amountBeforeVat": number | null,
  "vatAmount": number | null,
  "total": number | null,               // the total to pay, including VAT, in shekels as printed
  "category": ${EXPENSE_CATEGORIES.map((c) => `"${c.id}"`).join(' | ')} | null,
  "description": string | null          // a few Hebrew words: what was bought
}
Today is ${today}.`;

export async function POST(req: Request) {
  if (!KEY) return Response.json({ code: 'no_api_key', message: 'הקריאה האוטומטית לא מוגדרת בשרת — ממלאים ידנית.' }, { status: 503 });
  const c = await financeCaller(req, { write: true });
  if (!c.ok) return Response.json(c.body, { status: c.status });
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof Blob) || !file.size) return Response.json({ code: 'no_file', message: 'לא התקבל קובץ.' }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ code: 'too_large', message: 'הקובץ גדול מדי לקריאה אוטומטית (עד 8MB) — אפשר לשמור אותו ולמלא ידנית.' }, { status: 413 });
  const mime = file.type;
  if (!TYPES.has(mime)) return Response.json({ code: 'type', message: 'קריאה אוטומטית עובדת על JPEG / PNG / WEBP / PDF. בתמונה מאייפון (HEIC) — מצלמים שוב או ממלאים ידנית.' }, { status: 415 });

  const r = await reserveUsage(c.userId, 'text', 1, { task: 'expense_scan' });
  if (r.denied) return r.denied;
  let slot: Reservation | null = r.reservation;
  const started = Date.now();
  try {
    const data = Buffer.from(await file.arrayBuffer()).toString('base64');
    const today = israelParts(Date.now()).date;
    const source = mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mime, data } };
    const params = { model: SCAN_MODEL, max_tokens: 16000, messages: [{ role: 'user', content: [source, { type: 'text', text: prompt(today) }] }] };
    const client = new Anthropic({ apiKey: KEY, timeout: 50_000, maxRetries: 1 });
    let res: any;
    try {
      // a request the model declines is re-run on a fallback model chosen by the API (server-side fallbacks)
      res = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as any);
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
      res = await client.messages.create(params as any); // an account without that option: the plain request
    }
    const tin = res.usage?.input_tokens ?? 0, tout = res.usage?.output_tokens ?? 0;
    const cost = (tin * PRICES.anthropicScanIn + tout * PRICES.anthropicScanOut) / 1e6;
    await commitUsage(slot!, { status: 'done', costUsd: cost, meta: { provider: 'anthropic', task: 'expense_scan', tin, tout } });
    slot = null;
    void logGeneration({ userId: c.userId, contentId: null, type: 'text', provider: 'anthropic', model: String(res.model ?? SCAN_MODEL), status: 'succeeded',
      inputUnits: tin, outputUnits: tout, estimatedCostUsd: cost, actualCostUsd: cost, latencyMs: Date.now() - started, meta: { task: 'expense_scan', mime } });
    if (res.stop_reason === 'refusal') return Response.json({ code: 'refused', message: 'הקריאה האוטומטית לא זמינה למסמך הזה — ממלאים ידנית.' }, { status: 422 });
    const text = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    let raw: unknown = null;
    try { raw = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null; } catch { raw = null; }
    if (!raw) return Response.json({ code: 'unreadable', message: 'לא הצלחנו לקרוא את הקובץ — ממלאים ידנית.' }, { status: 422 });
    const { fields, warnings } = sanitizeExtraction(raw, today);
    // only the checked fields go back (and are kept with the expense as "what the AI read")
    return Response.json({ fields, warnings, model: String(res.model ?? SCAN_MODEL), raw: fields }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    if (slot) await releaseUsage(slot, String(e?.message ?? e));
    return Response.json({ code: e?.status === 429 ? 'rate_limited' : 'ai_error', message: 'הקריאה האוטומטית לא זמינה כרגע — ממלאים ידנית.' }, { status: 502 });
  }
}
