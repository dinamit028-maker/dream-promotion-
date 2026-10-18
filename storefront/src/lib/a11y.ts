/**
 * The accessibility menu of every site (2.104, A11yMenu): the shopper's own choices, kept in this browser only (localStorage —
 * nothing is sent anywhere, there is no cookie), applied as classes on <html>. globals.css has the rule of every class.
 * A11Y_BOOT applies the kept choices before the first paint (<head>, with the page's nonce), so a page never shows without them;
 * it reads them by the same rules as readPrefs — change both together (a11y.test.ts runs the script against readPrefs).
 */
export const A11Y_KEY = 'sf-a11y';

/** the text: as the site is (0), then three sizes up */
export type TextLevel = 0 | 1 | 2 | 3;
export const A11Y_TOGGLES = ['contrast', 'links', 'font', 'still', 'spacing'] as const;
export type A11yToggle = (typeof A11Y_TOGGLES)[number];
export type A11yPrefs = { text: TextLevel } & Record<A11yToggle, boolean>;

export const NO_PREFS: A11yPrefs = { text: 0, contrast: false, links: false, font: false, still: false, spacing: false };

/** what was kept → the choices; anything else (a broken value, an old one) → nothing chosen */
export function readPrefs(raw: string | null | undefined): A11yPrefs {
  let v: unknown = null;
  try { v = raw ? JSON.parse(raw) : null; } catch { v = null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...NO_PREFS };
  const o = v as Record<string, unknown>;
  const text: TextLevel = o.text === 1 || o.text === 2 || o.text === 3 ? o.text : 0;
  const p: A11yPrefs = { ...NO_PREFS, text };
  for (const k of A11Y_TOGGLES) p[k] = o[k] === true;
  return p;
}

export const isDefault = (p: A11yPrefs) => p.text === 0 && A11Y_TOGGLES.every((k) => !p[k]);

/** the choices → what is kept; nothing chosen → nothing kept (null: the key is removed) */
export const writePrefs = (p: A11yPrefs): string | null => (isDefault(p) ? null : JSON.stringify(p));

/** the classes on <html> for these choices */
export function prefClasses(p: A11yPrefs): string[] {
  return [...(p.text ? [`a11y-text-${p.text}`] : []), ...A11Y_TOGGLES.filter((k) => p[k]).map((k) => `a11y-${k}`)];
}
/** every class the menu may put on <html> (to take them off before putting the new ones) */
export const A11Y_CLASSES: readonly string[] = ['a11y-text-1', 'a11y-text-2', 'a11y-text-3', ...A11Y_TOGGLES.map((k) => `a11y-${k}`)];

/** before the first paint: the kept choices as classes — the same rules as readPrefs / prefClasses */
export const A11Y_BOOT = `(function(){try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(A11Y_KEY)})||'null');`
  + `if(!p||typeof p!=='object'||Array.isArray(p))return;var c=document.documentElement.classList;`
  + `if(p.text===1||p.text===2||p.text===3)c.add('a11y-text-'+p.text);`
  + `${JSON.stringify(A11Y_TOGGLES)}.forEach(function(k){if(p[k]===true)c.add('a11y-'+k)})}catch(e){}})();`;
