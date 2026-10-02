/**
 * What the user reads when something fails. Technical detail (ffmpeg exit codes, HTTP status,
 * provider messages) stays in the server logs and the browser console — the screen says what
 * happened, that nothing was lost, and what to do.
 */
const SAFE = ' הסצנות, הקריינות והמוזיקה שלכם שמורים — שום דבר לא אבד.';

export function friendlyRenderError(raw: string | undefined | null): { title: string; body: string } {
  const m = String(raw ?? '');
  if (typeof console !== 'undefined') console.warn('[render] technical error:', m);
  if (/quota_exceeded|הגעתם למכסה/.test(m)) return { title: 'הגעתם למכסת הרינדורים החודשית.', body: 'המכסה מתאפסת בתחילת החודש.' };
  if (/too_many_running|כבר רצ/.test(m)) return { title: 'רינדור אחר עוד רץ.', body: 'חכו שהוא יסתיים ונסו שוב.' };
  if (/rate_limited|יותר מדי בקשות/.test(m)) return { title: 'יותר מדי רינדורים בדקה האחרונה.', body: 'נסו שוב בעוד רגע.' };
  if (/no_session|sign in|התחבר/.test(m)) return { title: 'צריך להתחבר מחדש.', body: 'התנתקתם מהחשבון. התחברו ונסו שוב.' + SAFE };
  if (/download_failed|blocked_url|host not allowed|cannot resolve|file too large/.test(m)) {
    return { title: 'אחד הקבצים של הסצנות לא היה זמין.', body: 'נסו "רינדור מחדש" לסצנה שחסרה, ואז שוב "יצירת הריל הסופי".' + SAFE };
  }
  if (/caption pack|captions/.test(m)) return { title: 'הכתוביות לא נטענו.', body: 'נסו שוב, או כבו כתוביות לרגע.' + SAFE };
  if (/timeout|timed out|aborted|504|FUNCTION_INVOCATION_TIMEOUT/i.test(m)) {
    return { title: 'הרינדור לקח יותר מדי זמן.', body: 'ריל ארוך או הרבה כתוביות. נסו שוב, או קצרו מעט את הריל.' + SAFE };
  }
  if (/ffmpeg|exited|signal|SIGKILL|out of memory/i.test(m)) {
    return { title: 'לא הצלחנו להשלים את הריל.', body: 'נסו שוב בעוד רגע.' + SAFE };
  }
  if (/no_cloud|Supabase is not configured/.test(m)) return { title: 'החשבון לא מחובר לשרת.', body: 'יצירת הריל הסופי דורשת חשבון מחובר.' };
  return { title: 'הרינדור לא הושלם.', body: 'נסו שוב בעוד רגע. אם זה חוזר — צלמו את המסך ושלחו לתמיכה.' + SAFE };
}

/** Short, human line for media / music / import failures. */
export function friendlyMediaError(raw: string | undefined | null): string {
  const m = String(raw ?? '');
  if (typeof console !== 'undefined') console.warn('[media] technical error:', m);
  if (/quota_exceeded|הגעתם למכסה/.test(m)) return 'הגעתם למכסה החודשית. היא מתאפסת בתחילת החודש.';
  if (/too_large|file too large|413/.test(m)) return 'הקובץ גדול מדי.';
  if (/bad_type|not a media file|bad_file/.test(m)) return 'סוג הקובץ לא נתמך.';
  if (/blocked_url|host not allowed/.test(m)) return 'לא ניתן להוריד מהמקור הזה.';
  if (/timeout|timed out|aborted/i.test(m)) return 'המקור לא ענה בזמן. נסו שוב.';
  if (/no_session|401/.test(m)) return 'צריך להתחבר מחדש.';
  return 'זה לא עבד הפעם. נסו שוב בעוד רגע.';
}
