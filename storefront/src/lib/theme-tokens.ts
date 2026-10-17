/**
 * The theme's design tokens as CSS variables — colours, corners and font (2.66): one rule for the <style nonce> of every page
 * (theme.ts → themeCss) and for the visual editor's live change (EditBridge sets the same variables through CSSOM, which the
 * CSP allows, before the draft is even saved). No kit data here, so the editor's script stays small.
 */
export type Radius = 'none' | 'small' | 'medium' | 'large';
export type Font = 'heebo' | 'rubik' | 'assistant' | 'frank';
export const FONTS: readonly Font[] = ['heebo', 'rubik', 'assistant', 'frank'];
export const RADII: readonly Radius[] = ['none', 'small', 'medium', 'large'];
export const COLOR_KEYS = ['background', 'surface', 'text', 'muted', 'primary', 'accent', 'accentSoft', 'border'] as const;
export type Colors = Record<(typeof COLOR_KEYS)[number], string>;

/** relative luminance and contrast (WCAG 2) */
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** the text colour on a button of this colour: whichever of white / ink reads better */
export const onColor = (hex: string) => (contrast(hex, '#ffffff') >= contrast(hex, '#14110e') ? '#ffffff' : '#14110e');

const RADIUS: Record<Radius, [string, string]> = { none: ['0', '0'], small: ['6px', '8px'], medium: ['12px', '999px'], large: ['20px', '999px'] };
const FAMILY: Record<Font, string> = {
  heebo: "'Heebo Variable','Heebo'", rubik: "'Rubik Variable','Rubik'", assistant: "'Assistant Variable','Assistant'",
  frank: "'Frank Ruhl Libre Variable','Frank Ruhl Libre'",
};
const HEX = /^#[0-9a-f]{6}$/;

/** the variables, in a fixed order — every value checked (a hex colour, a corner and a font from the lists); else null */
export function tokenVars(colors: object, font: unknown, radius: unknown): [string, string][] | null {
  const src = colors as Record<string, unknown>;
  const c = Object.fromEntries(COLOR_KEYS.map((k) => [k, typeof src[k] === 'string' ? (src[k] as string).toLowerCase() : ''])) as Colors;
  if (!COLOR_KEYS.every((k) => HEX.test(c[k])) || !FONTS.includes(font as Font) || !RADII.includes(radius as Radius)) return null;
  const [card, button] = RADIUS[radius as Radius];
  return [
    ['--c-bg', c.background], ['--c-surface', c.surface], ['--c-text', c.text], ['--c-muted', c.muted], ['--c-primary', c.primary],
    ['--c-on-primary', onColor(c.primary)], ['--c-accent', c.accent], ['--c-accent-soft', c.accentSoft], ['--c-border', c.border],
    ['--radius', card], ['--radius-btn', button], ['--font', `${FAMILY[font as Font]},system-ui,-apple-system,'Segoe UI',Arial,sans-serif`],
  ];
}

/**
 * 2.101: a dark background (the first dark kit) — what globals.css draws for a light one, in colours that read on it: the
 * stock and form colours, a problem row of the cart, and the words on the accent colour (a sale badge, the cart's count).
 * null on a light background: themeCss adds nothing, so every light site stays exactly as it was. The visual editor's live
 * change sets these, or LIGHT_VARS, with the colours.
 */
export function darkVars(colors: object): [string, string][] | null {
  const src = colors as Record<string, unknown>;
  const [bg, accent] = [src.background, src.accent].map((v) => (typeof v === 'string' ? v.toLowerCase() : ''));
  if (!HEX.test(bg) || !HEX.test(accent) || onColor(bg) !== '#ffffff') return null;
  return [['--c-ok', '#7dd3a0'], ['--c-bad', '#ff9b8f'], ['--c-bad-soft', 'rgba(255,155,143,.12)'], ['--c-on-accent', onColor(accent)]];
}
export const LIGHT_VARS: [string, string][] = [['--c-ok', 'var(--ok)'], ['--c-bad', 'var(--bad)'], ['--c-bad-soft', '#fdf6f6'], ['--c-on-accent', '#ffffff']];
