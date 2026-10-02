import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import {
  adCopyPrompt, assistantPrompt, brandAnalysisPrompt,
  contentPrompt, rewritePrompt, scenePrompt, storyboardPrompt, weeklyPlanPrompt,
  socialPrompt, captionPolishPrompt, ideasPrompt,
} from '@/lib/services/prompts';
import { accessDenied } from '@/lib/server/access';
import { commitUsage, releaseUsage, requestUser, reserveUsage, type Reservation } from '@/lib/server/quota';
import { PRICES } from '@/lib/server/ai/config';
import { contentIdFrom, logGeneration } from '@/lib/server/ai/ledger';

export const runtime = 'nodejs';
// a full week of Hebrew captions takes longer than the default function limit
export const maxDuration = 60;

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';

/** Health check the client uses to decide whether to offer generation at all. */
export async function GET() {
  return NextResponse.json({ available: Boolean(KEY), model: KEY ? MODEL : null });
}

function buildPrompt(task: string, p: any): { prompt: string; json: boolean } {
  switch (task) {
    case 'content':    return { prompt: contentPrompt(p.brand, p.brief), json: true };
    case 'weekly':     return { prompt: weeklyPlanPrompt(p.brand), json: true };
    case 'storyboard': return { prompt: storyboardPrompt(p.brand, p.brief, p.duration, Array.isArray(p.avoid) ? p.avoid.slice(0, 6) : undefined), json: true };
    case 'analysis':   return { prompt: brandAnalysisPrompt(p.brand), json: true };
    case 'ad':         return { prompt: adCopyPrompt(p.brand, p), json: true };
    case 'assistant':  return { prompt: assistantPrompt(p.brand, p.recentContent, p.question), json: false };
    case 'rewrite':    return { prompt: rewritePrompt(p.brand, p.mode, p.caption, p.cta), json: true };
    case 'scene':      return { prompt: scenePrompt(p.brand, p.role, p.onScreen, p.previous, { voiceover: p.voiceover, cast: p.cast, angle: p.angle }), json: true };
    case 'ideas':      return { prompt: ideasPrompt(p.brand, { recent: p.recent, avoid: p.avoid, count: 6 }), json: true };
    case 'social':     return { prompt: socialPrompt(p.brand, p), json: true };
    case 'captions':   return { prompt: captionPolishPrompt(p.brand, p), json: true };
    default: throw new Error('unknown_task');
  }
}

export async function POST(req: Request) {
  if (!KEY) {
    return NextResponse.json(
      { code: 'no_api_key', message: 'ANTHROPIC_API_KEY is not configured' },
      { status: 503 },
    );
  }
  const denied = await accessDenied(req);
  if (denied) return denied;
  let slot: Reservation | null = null;
  try {
    const raw = await req.text();
    // a cap on what one request may send (brand profile + brief + script fit easily in 60k characters)
    if (raw.length > 60_000) return NextResponse.json({ code: 'too_large', message: 'request too large' }, { status: 413 });
    const { task, payload } = JSON.parse(raw);
    const { prompt, json } = buildPrompt(task, payload);
    const userId0 = await requestUser(req);
    const r = await reserveUsage(userId0, 'text', 1, { task });
    if (r.denied) return r.denied;
    slot = r.reservation;
    const client = new Anthropic({ apiKey: KEY });

    const started = Date.now();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: task === 'weekly' || task === 'storyboard' ? 8000 : 3000,
      messages: [{ role: 'user', content: prompt }],
    });
    // ledger: tokens are reported by Anthropic, so this is the actual cost, not an estimate
    const tin = res.usage?.input_tokens ?? 0, tout = res.usage?.output_tokens ?? 0;
    const cost = (tin * PRICES.anthropicIn + tout * PRICES.anthropicOut) / 1e6;
    const userId = userId0;
    await commitUsage(slot, { status: 'done', costUsd: cost, meta: { provider: 'anthropic', tin, tout } });
    slot = null;
    void logGeneration({
      userId, contentId: await contentIdFrom(req, userId), type: 'text', provider: 'anthropic', model: MODEL,
      status: 'succeeded', inputUnits: tin, outputUnits: tout, estimatedCostUsd: cost, actualCostUsd: cost,
      latencyMs: Date.now() - started, meta: { task },
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!json) return NextResponse.json({ text });

    // take the JSON object even if the model wrapped it in fences or a sentence
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    const clean = start >= 0 && end > start ? text.slice(start, end + 1) : text;
    try {
      return NextResponse.json(JSON.parse(clean));
    } catch {
      return NextResponse.json(
        { code: 'invalid_json', message: 'Model did not return valid JSON', raw: clean.slice(0, 400) },
        { status: 502 },
      );
    }
  } catch (e: any) {
    if (slot) await releaseUsage(slot, String(e?.message ?? e));
    return NextResponse.json(
      { code: e?.status === 429 ? 'rate_limited' : 'ai_error', message: e?.message || 'unknown' },
      { status: 500 },
    );
  }
}
