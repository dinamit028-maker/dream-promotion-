import KIT_THEMES from './kit-themes.json';
import { resolveTheme, type Theme } from './theme';

/**
 * A kit's preview before it is applied (Dream Builder PR-2, 2.64): the owner sees the store — its products, prices,
 * collections and details — in another kit, and nothing is written anywhere. Only with a valid preview token: the proxy
 * keeps the choice of ?kit=<id>&kitmode=<design|full> in a cookie of this address (KIT_COOKIE), and getSite takes it only
 * for a visitor who came with the token. Without the token the cookie is ignored.
 *   design — the store's own home page (its texts, pictures, order) in the kit's look ("החלפת עיצוב")
 *   full   — the kit's own home page and look, with the store's name ("ערכה מלאה")
 * The kits' themes are a generated copy of the dashboard's kits/ (kit-themes.json, scripts/kits.mjs) — data, checked by
 * resolveTheme like every saved theme.
 */
export { KIT_COOKIE, KIT_MODE_PARAM, KIT_PARAM, kitCookieValue } from './kit-choice';
export type KitMode = 'design' | 'full';
export interface KitChoice { kit: string; mode: KitMode; name: string }

interface KitTheme { name: string; theme: Record<string, unknown> & { sections: { id: string; type: string; hidden: boolean; settings: Record<string, unknown> }[] } }
const THEMES = KIT_THEMES as unknown as Record<string, KitTheme>;
export const KIT_IDS = Object.keys(THEMES);

/** the cookie's value → the choice: only a kit that exists, only the two modes */
export function readKitChoice(value: string | undefined | null): KitChoice | null {
  const m = /^([a-z][a-z0-9-]{1,30}):(design|full)$/.exec(value ?? '');
  if (!m || !Object.hasOwn(THEMES, m[1])) return null;
  return { kit: m[1], mode: m[2] as KitMode, name: THEMES[m[1]].name };
}

/** the kit's texts with the store's name; a link to the booking page → WhatsApp (as a kit applied with no booking page) */
function filled(kit: string, storeName: string): Record<string, unknown> {
  const json = JSON.stringify(THEMES[kit].theme).split('{{name}}').join(JSON.stringify(storeName).slice(1, -1)).split('"booking"').join('"whatsapp"');
  return JSON.parse(json) as Record<string, unknown>;
}

/** the theme a preview of the kit shows (never saved) */
export function previewTheme(template: string, saved: unknown, choice: KitChoice, storeName: string): Theme {
  const kit = filled(choice.kit, storeName);
  if (choice.mode === 'full') return resolveTheme('kit', { ...kit, kit: choice.kit });
  // design only: the store's home page as it is (its template fills in what the settings leave out), the kit's look
  const own = resolveTheme(template, saved);
  return resolveTheme('kit', {
    kit: choice.kit, colors: kit.colors, font: kit.font, art: kit.art, radius: kit.radius,
    announcement: own.announcement, product: own.product,
    sections: own.sections.map((s) => ({ id: s.id, type: s.type, hidden: s.hidden, settings: s.settings })),
  });
}
