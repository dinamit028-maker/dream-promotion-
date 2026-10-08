/**
 * A section's own design in the editor (Dream Builder PR-3d, 2.68) — pure rules over the draft. The phone ("base") is
 * the section's `style`; a tablet ("md") and a computer ("lg") are `responsive.md / .lg`, and take what is above them
 * unless they have their own. An empty value removes the step (back to the kit's, or to the smaller screen's). Only steps
 * of the scales (builder-registry.ts); anything else changes nothing.
 */
import { STYLE_SCALES, styleClasses, type Responsive, type StyleKey, type StyleValues } from './builder-registry';
import type { Device, Draft, Section } from './theme-fields';

const ownOf = (s: Section, device: Device): StyleValues => (device === 'base' ? s.style : s.responsive?.[device]) ?? {};
/** what a screen shows: its own, else the tablet's (for a computer), else the phone's — and where it comes from */
export function styleShown(s: Section, device: Device, key: StyleKey): { value: string; own: boolean } {
  const chain: Device[] = device === 'lg' ? ['lg', 'md', 'base'] : device === 'md' ? ['md', 'base'] : ['base'];
  for (const d of chain) { const v = ownOf(s, d)[key]; if (v) return { value: v, own: d === device }; }
  return { value: '', own: false };
}

export function setSectionStyle(d: Draft, id: string, device: Device, key: StyleKey, value: string): Draft {
  const s = d.sections.find((x) => x.id === id);
  if (!s || (value !== '' && !STYLE_SCALES[key].some((x) => x.value === value))) return d;
  const own = ownOf(s, device);
  if ((own[key] ?? '') === value) return d;
  const next = { ...own } as Record<string, string>;
  if (value) next[key] = value; else delete next[key];
  return { ...d, sections: d.sections.map((x) => (x === s ? withOwn(x, device, next as StyleValues) : x)) };
}
/** a screen back to the one below it (a tablet to the phone's, a computer to the tablet's) */
export function resetDevice(d: Draft, id: string, device: 'md' | 'lg'): Draft {
  const s = d.sections.find((x) => x.id === id);
  return s && s.responsive?.[device] ? { ...d, sections: d.sections.map((x) => (x === s ? withOwn(x, device, {}) : x)) } : d;
}
function withOwn(s: Section, device: Device, own: StyleValues): Section {
  const empty = !Object.keys(own).length;
  if (device === 'base') { const { style: _s, ...rest } = s; return empty ? rest : { ...rest, style: own }; }
  const responsive: Responsive = { ...s.responsive };
  if (empty) delete responsive[device]; else responsive[device] = own;
  const { responsive: _r, ...rest } = s;
  return Object.keys(responsive).length ? { ...rest, responsive } : rest;
}
/** the classes the page's wrapper of a section carries (the same function as the storefront's) */
export const sectionStyleClasses = (s: Section) => styleClasses(s.style, s.responsive);
