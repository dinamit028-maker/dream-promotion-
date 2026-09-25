import { NextResponse } from 'next/server';
import { fal } from '@fal-ai/client';
import { accessDenied } from '@/lib/server/access';
import { quotaDenied, recordUsage, requestUser } from '@/lib/server/quota';

export const runtime = 'nodejs';

const KEY = process.env.FAL_KEY;
if (KEY) fal.config({ credentials: KEY });

/** Nano Banana 2 — $0.08 an image, which is why most posts should start here and not with video. */
const MODELS = {
  create: 'fal-ai/nano-banana-2',
  edit: 'fal-ai/nano-banana-2/edit',
} as const;
const ALLOWED: string[] = Object.values(MODELS);
const ASPECTS = ['9:16', '4:5', '1:1', '16:9', '3:4', '4:3', 'auto'];

export async function GET() {
  return NextResponse.json({ available: Boolean(KEY), engine: 'Nano Banana 2 · fal' });
}

export async function POST(req: Request) {
  if (!KEY) return NextResponse.json({ code: 'no_fal_key', message: 'FAL_KEY is not configured' }, { status: 503 });
  const denied = await accessDenied(req);
  if (denied) return denied;

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ code: 'bad_request', message: 'Invalid JSON' }, { status: 400 });
  }

  try {
    if (body.action === 'submit') {
      const prompt = String(body.prompt ?? '').trim().slice(0, 4000);
      if (!prompt) return NextResponse.json({ code: 'bad_request', message: 'prompt required' }, { status: 400 });

      const refs: string[] = Array.isArray(body.imageUrls)
        ? body.imageUrls.filter((u: unknown) => typeof u === 'string' && (u.startsWith('data:image/') || u.startsWith('https://'))).slice(0, 4)
        : [];
      const mode = refs.length ? 'edit' : 'create';
      const count = Math.min(4, Math.max(1, Math.round(Number(body.count) || 1)));
      const userId = await requestUser(req);
      const over = await quotaDenied(userId, 'image', count);
      if (over) return over;

      const input: Record<string, unknown> = {
        prompt,
        num_images: count,
        aspect_ratio: ASPECTS.includes(body.aspectRatio) ? body.aspectRatio : '4:5',
        output_format: 'jpeg',
      };
      if (refs.length) input.image_urls = refs;

      const queued = await fal.queue.submit(MODELS[mode], { input: input as any });
      await recordUsage(userId, 'image', count, count * 0.08, { requestId: queued.request_id, model: MODELS[mode] });
      return NextResponse.json({ requestId: queued.request_id, model: MODELS[mode] });
    }

    if (body.action === 'status') {
      const model = String(body.model ?? '');
      const requestId = String(body.requestId ?? '');
      if (!ALLOWED.includes(model) || !requestId) {
        return NextResponse.json({ code: 'bad_request', message: 'unknown job' }, { status: 400 });
      }
      const st: any = await fal.queue.status(model, { requestId, logs: false });
      if (st.status === 'COMPLETED') {
        const r: any = await fal.queue.result(model, { requestId });
        const urls = (r?.data?.images ?? []).map((i: any) => i.url).filter(Boolean);
        if (!urls.length) return NextResponse.json({ status: 'FAILED', error: 'no image in result' });
        return NextResponse.json({ status: 'COMPLETED', urls });
      }
      return NextResponse.json({ status: st.status, position: st.queue_position ?? null });
    }

    return NextResponse.json({ code: 'bad_request', message: 'unknown action' }, { status: 400 });
  } catch (e: any) {
    const detail = e?.body?.detail ?? e?.message ?? 'unknown';
    const code = e?.status === 402 ? 'insufficient_balance' : e?.status === 422 ? 'rejected_input' : 'image_error';
    return NextResponse.json(
      { status: 'FAILED', code, error: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400) },
      { status: 200 },
    );
  }
}
