import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import {
  adCopyPrompt, assistantPrompt, brandAnalysisPrompt,
  contentPrompt, rewritePrompt, scenePrompt, storyboardPrompt, weeklyPlanPrompt,
  socialPrompt, captionPolishPrompt, ideasPrompt, followupPrompt, collectionPrompt, productCopyPrompt, storePagePrompt, storeTextPrompt,
} from '@/lib/services/prompts';
import { cleanPageCopy, cleanShortCopy, type PageFacts, type ShortField } from '@/features/store/page-ai';
import { pageFacts } from '@/lib/server/page-facts';
import { cleanProductCopy } from '@/features/catalog/catalog';
import { aiDraftIsSafe, reminderTemplate, type Tone } from '@/features/finance/receivables';
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

const shortField = (v: unknown): ShortField => (v === 'store' ? 'store' : 'collection');

function buildPrompt(task: string, p: any, facts: PageFacts | null): { prompt: string; json: boolean } {
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
    case 'followup':   return { prompt: followupPrompt(p.brand, {
      name: String(p.name ?? '').slice(0, 80), stage: String(p.stage ?? ''), source: p.source, notes: String(p.notes ?? '').slice(0, 600),
      history: Array.isArray(p.history) ? p.history.slice(0, 12).map((h: unknown) => String(h).slice(0, 200)) : [], goal: p.goal,
    }), json: true };
    // the template is ours (by tone) — whatever the client sends; the AI never sees amounts, names or dates
    case 'collection': { const tone: Tone = p.tone === 'final' || p.tone === 'firm' ? p.tone : 'friendly';
      return { prompt: collectionPrompt({ tone, template: reminderTemplate(tone), business: String(p.business ?? '') }), json: true }; }
    case 'social':     return { prompt: socialPrompt(p.brand, p), json: true };
    case 'captions':   return { prompt: captionPolishPrompt(p.brand, p), json: true };
    // Dream Commerce: a product page's text — the product's own words in, a suggestion out (cleaned below)
    case 'product':    return { prompt: productCopyPrompt(p.brand, p), json: true };
    // a page or a policy of the site: the store's details come from the server (pageFacts), never from the request
    case 'storePage':  if (!facts) throw new Error('no_store'); return { prompt: storePagePrompt(p.brand, facts), json: true };
    case 'storeText':  if (!facts) throw new Error('no_store');
      return { prompt: storeTextPrompt(p.brand, facts.store, { field: shortField(p.field), title: String(p.title ?? '').slice(0, 80),
        tags: Array.isArray(p.tags) ? p.tags.slice(0, 20).map(String) : [], current: String(p.current ?? '').slice(0, 600) }), json: true };
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
    const userId0 = await requestUser(req);
    const store = task === 'storePage' || task === 'storeText';
    const facts = store && userId0 ? await pageFacts(userId0, task === 'storePage' ? payload ?? {} : { kind: 'page' }) : null;
    if (store && !facts) return NextResponse.json({ code: 'no_store', message: 'no store for this business' }, { status: 404 });
    const { prompt, json } = buildPrompt(task, payload, facts);
    const r = await reserveUsage(userId0, 'text', 1, { task });
    if (r.denied) return r.denied;
    slot = r.reservation;
    const client = new Anthropic({ apiKey: KEY });

    const started = Date.now();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: task === 'weekly' || task === 'storyboard' || task === 'storePage' ? 8000 : 3000,
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
      const parsed = JSON.parse(clean);
      // a reminder that wrote its own amount, date or link is refused here too (the client checks again)
      if (task === 'collection' && !aiDraftIsSafe(parsed?.message)) {
        return NextResponse.json({ code: 'unsafe_draft', message: 'the draft did not keep the placeholders' }, { status: 422 });
      }
      // a product's text: plain text within the limits (no HTML reaches a page) — or nothing
      if (task === 'product') {
        const copy = cleanProductCopy(parsed);
        return copy ? NextResponse.json(copy) : NextResponse.json({ code: 'empty_draft', message: 'no text came back' }, { status: 422 });
      }
      // a page: plain text, no claim nobody checked ("האתר נגיש"), and a policy keeps its lawyer line — or nothing
      if (task === 'storeText') {
        const copy = cleanShortCopy(parsed, shortField(payload?.field));
        return copy ? NextResponse.json(copy) : NextResponse.json({ code: 'unsafe_draft', message: 'the draft was empty or made a claim' }, { status: 422 });
      }
      if (task === 'storePage') {
        const copy = cleanPageCopy(parsed, facts!.kind);
        return copy ? NextResponse.json(copy) : NextResponse.json({ code: 'unsafe_draft', message: 'the draft was empty or made a claim' }, { status: 422 });
      }
      return NextResponse.json(parsed);
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
