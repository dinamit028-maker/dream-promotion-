import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import {
  adCopyPrompt, assistantPrompt, brandAnalysisPrompt,
  contentPrompt, storyboardPrompt, weeklyPlanPrompt,
} from '@/lib/services/prompts';
import { accessDenied } from '@/lib/server/access';

export const runtime = 'nodejs';

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
    case 'storyboard': return { prompt: storyboardPrompt(p.brand, p.brief, p.duration), json: true };
    case 'analysis':   return { prompt: brandAnalysisPrompt(p.brand), json: true };
    case 'ad':         return { prompt: adCopyPrompt(p.brand, p), json: true };
    case 'assistant':  return { prompt: assistantPrompt(p.brand, p.recentContent, p.question), json: false };
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
  const denied = accessDenied(req);
  if (denied) return denied;
  try {
    const { task, payload } = await req.json();
    const { prompt, json } = buildPrompt(task, payload);
    const client = new Anthropic({ apiKey: KEY });

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!json) return NextResponse.json({ text });

    const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
      return NextResponse.json(JSON.parse(clean));
    } catch {
      return NextResponse.json(
        { code: 'invalid_json', message: 'Model did not return valid JSON', raw: clean.slice(0, 400) },
        { status: 502 },
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { code: e?.status === 429 ? 'rate_limited' : 'ai_error', message: e?.message || 'unknown' },
      { status: 500 },
    );
  }
}
