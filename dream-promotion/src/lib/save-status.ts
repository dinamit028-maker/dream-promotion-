/**
 * Saves that run in the background (contacts, content, media, brand…) used to fail silently: the screen showed the change,
 * the server never got it, and it was gone on the next load. Now a failed save is announced: Repo reports it here, and
 * <SaveErrorBanner/> shows a Hebrew bar until the user closes it. Browser only; nothing is stored or sent anywhere.
 */
export const SAVE_ERROR_EVENT = 'dp-save-error';
export interface SaveError { what: string; message: string }

type DbError = { message?: string; code?: string; details?: string } | null | undefined;

/** a database / network error → why, in Hebrew (the technical text goes to the console only) */
export function saveErrorReason(e: DbError): string {
  const text = `${e?.message ?? ''} ${e?.details ?? ''}`.toLowerCase();
  if (e?.code === '42501' || text.includes('row-level security') || text.includes('permission denied')) return 'אין הרשאה לשמור את זה בעסק הנוכחי';
  if (text.includes('business_locked') || text.includes('locked')) return 'העסק נעול כרגע';
  if (text.includes('failed to fetch') || text.includes('network') || text.includes('load failed')) return 'אין חיבור לאינטרנט';
  return 'השרת לא אישר את השמירה';
}

export function saveErrorText(what: string, e: DbError): string {
  return `לא הצלחנו לשמור את ${what} (${saveErrorReason(e)}). השינוי מופיע במסך, אבל לא נשמר — בדקו ונסו שוב.`;
}

/** report a failed background save (no-op on the server and in tests without a window) */
export function reportSaveError(what: string, e: DbError) {
  if (!e) return;
  if (typeof console !== 'undefined') console.error(`save failed: ${what}`, e);
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent<SaveError>(SAVE_ERROR_EVENT, { detail: { what, message: saveErrorText(what, e) } }));
}

/** run a background write: a thrown error (offline) or an { error } answer is reported, never swallowed */
export async function reported<T extends { error: DbError }>(what: string, write: PromiseLike<T>): Promise<T | null> {
  try {
    const r = await write;
    if (r?.error) reportSaveError(what, r.error);
    return r;
  } catch (e) {
    reportSaveError(what, { message: String((e as Error)?.message ?? e) });
    return null;
  }
}
