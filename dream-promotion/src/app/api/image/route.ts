import { NextResponse } from 'next/server';
import { accessDenied } from '@/lib/server/access';
import { commitUsage, releaseUsage, requestUser, reserveUsage } from '@/lib/server/quota';
import { AI_CONFIG, type ImageQuality } from '@/lib/server/ai/config';
import { imageProvider, imageStatus, submitImage } from '@/lib/server/ai/router';
import { contentIdFrom } from '@/lib/server/ai/ledger';
import { ProviderError } from '@/lib/server/ai/types';

export const runtime = 'nodejs';

/** Images, through the AI router (Nano Banana 2 on fal today; the mode decides the model later). */
const ASPECTS = ['9:16', '4:5', '1:1', '16:9', '3:4', '4:3', 'auto'];
const QUALITIES: ImageQuality[] = ['economy', 'standard', 'premium'];

export async function GET() {
  return NextResponse.json({ available: Boolean(imageProvider()), engine: 'Nano Banana 2 · fal' });
}

export async function POST(req: Request) {
  if (!imageProvider()) return NextResponse.json({ code: 'no_fal_key', message: 'FAL_KEY is not configured' }, { status: 503 });
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
      const references: string[] = Array.isArray(body.imageUrls)
        ? body.imageUrls.filter((u: unknown) => typeof u === 'string' && (u.startsWith('data:image/') || u.startsWith('https://'))).slice(0, 4)
        : [];
      const count = Math.min(AI_CONFIG.limits.maxImagesPerRequest, Math.max(1, Math.round(Number(body.count) || 1)));
      const quality: ImageQuality = QUALITIES.includes(body.quality) ? body.quality : 'standard';
      const userId = await requestUser(req);
      const r = await reserveUsage(userId, 'image', count, { quality });
      if (r.denied) return r.denied;
      const slot = r.reservation;
      try {
        const job = await submitImage({ userId, contentId: await contentIdFrom(req, userId) }, {
          prompt, count, references, aspectRatio: ASPECTS.includes(body.aspectRatio) ? body.aspectRatio : '4:5',
        }, quality);
        await commitUsage(slot, { status: 'done', costUsd: job.estimate ?? 0, requestId: job.jobId, meta: { model: job.handle } });
        return NextResponse.json({ requestId: job.jobId, model: job.handle });
      } catch (e) {
        await releaseUsage(slot, String((e as any)?.message ?? e));
        throw e;
      }
    }

    if (body.action === 'status') {
      const handle = String(body.model ?? ''), requestId = String(body.requestId ?? '');
      const st = handle && requestId ? await imageStatus(handle, requestId) : null;
      if (!st) return NextResponse.json({ code: 'bad_request', message: 'unknown job' }, { status: 400 });
      if (st.state === 'succeeded') return NextResponse.json({ status: 'COMPLETED', urls: st.urls });
      if (st.state === 'failed') return NextResponse.json({ status: 'FAILED', error: st.error });
      return NextResponse.json({ status: st.state === 'queued' ? 'IN_QUEUE' : 'IN_PROGRESS' });
    }

    return NextResponse.json({ code: 'bad_request', message: 'unknown action' }, { status: 400 });
  } catch (e: any) {
    const code = e instanceof ProviderError
      ? (e.kind === 'quota' ? 'insufficient_balance' : e.kind === 'input' ? 'rejected_input' : e.kind === 'policy' ? 'content_policy' : 'image_error')
      : 'image_error';
    return NextResponse.json({ status: 'FAILED', code, error: String(e?.message ?? e).slice(0, 400) }, { status: 200 });
  }
}
