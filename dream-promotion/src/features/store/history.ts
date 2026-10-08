/**
 * Undo / redo of the visual editor (Dream Builder PR-3a, 2.65): a stack of drafts in the browser only. Every draft is a new
 * object (never changed in place), so a step is the draft before it. Up to 50 steps; typing in one field within 800ms is one
 * step. Undo and redo are changes like any other: they are saved as the draft, and the versions of the site (publish,
 * rollback) are not touched — there is no second version system.
 */
export const HISTORY_LIMIT = 50;
export const MERGE_MS = 800;

export interface History<T> { past: T[]; future: T[]; key: string | null; at: number }
export const emptyHistory = <T>(): History<T> => ({ past: [], future: [], key: null, at: 0 });

/**
 * A change from `before`: one more step back — unless it continues the last one (the same key, e.g. "text:hero:title",
 * within MERGE_MS), which stays one step. Any change clears what redo could bring back.
 */
export function record<T>(h: History<T>, before: T, key: string | null = null, now = Date.now()): History<T> {
  if (key && h.key === key && now - h.at < MERGE_MS && h.past.length) return { past: h.past, future: [], key, at: now };
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), future: [], key, at: now };
}
/** back one step: the draft to show, and the history with the current draft ready for redo — null when nothing is back */
export function undo<T>(h: History<T>, current: T): { value: T; history: History<T> } | null {
  if (!h.past.length) return null;
  return { value: h.past[h.past.length - 1], history: { past: h.past.slice(0, -1), future: [current, ...h.future].slice(0, HISTORY_LIMIT), key: null, at: 0 } };
}
export function redo<T>(h: History<T>, current: T): { value: T; history: History<T> } | null {
  if (!h.future.length) return null;
  return { value: h.future[0], history: { past: [...h.past, current].slice(-HISTORY_LIMIT), future: h.future.slice(1), key: null, at: 0 } };
}
