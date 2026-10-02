import { PRICE_PER_SECOND } from '@/lib/services/video.service';
import { PRICE_PER_IMAGE } from '@/lib/services/image.service';
import type { ReelScene } from '@/types';
import type { Clip, Res } from './parts';

/**
 * Reel studio — pure logic (no React, no network): what is left to pay, which wizard step is
 * done. Moved out of the page so it can be tested on its own (tests/reel-studio.test.ts).
 */
export interface CostInput {
  scenes: ReelScene[]; clips: Record<number, Clip | undefined>; imageMode: Record<number, boolean>;
  photos: Record<number, unknown>; draftMode: boolean; res: Res;
}

/** now = to pay with the next "create" · final = to pay later for the final version (drafts → video). */
export function reelCosts({ scenes, clips, imageMode, photos, draftMode, res }: CostInput) {
  let now = 0, final = 0, videoSec = 0;
  scenes.forEach((sc, i) => {
    const src = sc.source ?? (imageMode[i] ? 'ai_image' : 'ai_video');
    const c = clips[i];
    const sec = sc.seconds || 5;
    if (src === 'ai_video') videoSec += sec;
    if (c?.status === 'done' && !c.draft) return;
    if (src === 'graphic' || src === 'user' || (src === 'ai_image' && photos[i])) return;
    if (src === 'ai_image') { now += PRICE_PER_IMAGE; return; }
    // AI video
    if (c?.draft) { final += sec * PRICE_PER_SECOND[res]; return; }
    if (draftMode) { now += PRICE_PER_IMAGE; final += sec * PRICE_PER_SECOND[res]; } else now += sec * PRICE_PER_SECOND[res];
  });
  const totalSec = scenes.reduce((a, x) => a + (x.seconds || 5), 0);
  return { now, final, videoSec, totalSec };
}

export type StepN = 1 | 2 | 3 | 4 | 5;
export interface StepInput {
  hasBoard: boolean; scenes: ReelScene[]; clips: Record<number, Clip | undefined>;
  narr: Record<number, { url?: string } | undefined>; withNarration: boolean; hasFinal: boolean;
}

/** A step is done when what it makes exists; the first step that is not done is where the user is sent. */
export function stepStatus({ hasBoard, scenes, clips, narr, withNarration, hasFinal }: StepInput) {
  const done: Record<StepN, boolean> = {
    1: hasBoard && scenes.length > 0,
    2: scenes.length > 0 && scenes.every((_, i) => clips[i]?.status === 'done' && Boolean(clips[i]?.url) && !clips[i]?.draft),
    3: scenes.length > 0 && (!withNarration || scenes.every((sc, i) => !sc.voiceover?.trim() || Boolean(narr[i]?.url))),
    4: hasFinal,
    5: false,
  };
  const firstOpen: StepN = !done[1] ? 1 : !done[2] ? 2 : !done[3] ? 3 : !done[4] ? 4 : 5;
  return { done, firstOpen };
}

export function wizardSteps(withNarration: boolean): { n: StepN; label: string; hint: string }[] {
  return [
    { n: 1, label: 'תסריט', hint: 'כתבו על מה הסרטון, בחרו סוג ואורך, ולחצו "בניית תסריט".' },
    { n: 2, label: 'וידאו', hint: 'לחצו "יצירת הסרטון" למטה. כל סצנה תסומן "מוכן" כשהיא גמורה.' },
    { n: 3, label: withNarration ? 'קריינות' : 'בלי קריינות', hint: withNarration ? 'בחרו קול, ולחצו "קריינות לכל הסצנות".' : 'בלי קול מקריא — עוברים לריל הסופי, ושם בוחרים מוזיקה וכתוביות.' },
    { n: 4, label: 'ריל סופי', hint: 'בחרו מוזיקה וכתוביות (לא חובה), ולחצו "יצירת הריל הסופי".' },
    { n: 5, label: 'פרסום', hint: 'פרסמו עכשיו, או תזמנו לשעה מומלצת.' },
  ];
}
