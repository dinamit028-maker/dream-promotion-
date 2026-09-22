import { NextResponse } from 'next/server';
import { fal } from '@fal-ai/client';
import { accessDenied } from '@/lib/server/access';

export const runtime = 'nodejs';

const KEY = process.env.FAL_KEY;
if (KEY) fal.config({ credentials: KEY });

/** Wan 3.0 on fal — swap here to change the video engine for the whole app. */
const MODELS = {
  image: 'alibaba/wan-3.0/image-to-video',
  text: 'alibaba/wan-3.0/text-to-video',
} as const;
const ALLOWED_MODELS: string[] = Object.values(MODELS);
const RESOLUTIONS = ['480p', '720p', '1080p'] as const;
const ASPECTS = ['9:16', '16:9', '1:1', '3:4', '4:3', 'adaptive'] as const;

const isImage = (v: unknown): v is string =>
  typeof v === 'string' && (v.startsWith('data:image/') || v.startsWith('https://'));

export async function GET() {
  return NextResponse.json({ available: Boolean(KEY), engine: 'Wan 3.0 · fal' });
}

export async function POST(req: Request) {
  if (!KEY) {
    return NextResponse.json({ code: 'no_fal_key', message: 'FAL_KEY is not configured' }, { status: 503 });
  }
  const denied = accessDenied(req);
  if (denied) return denied;

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ code: 'bad_request', message: 'Invalid JSON' }, { status: 400 });
  }

  try {
    if (body.action === 'submit') {
      const prompt = String(body.prompt ?? '').trim().slice(0, 4000);
      if (!prompt) return NextResponse.json({ code: 'bad_request', message: 'prompt required' }, { status: 400 });

      const duration = Math.min(30, Math.max(2, Math.round(Number(body.duration) || 15)));
      const resolution = RESOLUTIONS.includes(body.resolution) ? body.resolution : '720p';
      const aspect_ratio = ASPECTS.includes(body.aspectRatio) ? body.aspectRatio : '9:16';

      const mode = isImage(body.startImage) ? 'image' : 'text';
      const input: Record<string, unknown> = {
        prompt, duration, resolution, aspect_ratio,
        audio: body.audio !== false,
        enable_prompt_expansion: true,
      };
      if (mode === 'image') {
        input.start_image_url = body.startImage;
        if (isImage(body.endImage)) input.end_image_url = body.endImage;
      }

      const queued = await fal.queue.submit(MODELS[mode], { input: input as any });
      return NextResponse.json({ requestId: queued.request_id, model: MODELS[mode], duration, resolution });
    }

    if (body.action === 'status') {
      const model = String(body.model ?? '');
      const requestId = String(body.requestId ?? '');
      if (!ALLOWED_MODELS.includes(model) || !requestId) {
        return NextResponse.json({ code: 'bad_request', message: 'unknown job' }, { status: 400 });
      }
      const st: any = await fal.queue.status(model, { requestId, logs: false });
      if (st.status === 'COMPLETED') {
        const r: any = await fal.queue.result(model, { requestId });
        const video = r?.data?.video;
        if (!video?.url) return NextResponse.json({ status: 'FAILED', error: 'no video in result' });
        return NextResponse.json({ status: 'COMPLETED', url: video.url, duration: r.data.duration ?? null });
      }
      return NextResponse.json({ status: st.status, position: st.queue_position ?? null });
    }

    return NextResponse.json({ code: 'bad_request', message: 'unknown action' }, { status: 400 });
  } catch (e: any) {
    // fal surfaces validation / safety / billing errors here — pass the reason through
    const detail = e?.body?.detail ?? e?.message ?? 'unknown';
    const status = e?.status === 402 ? 'insufficient_balance' : e?.status === 422 ? 'rejected_input' : 'video_error';
    return NextResponse.json(
      { status: 'FAILED', code: status, error: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400) },
      { status: 200 },
    );
  }
}
