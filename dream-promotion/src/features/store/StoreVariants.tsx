'use client';
import { Select } from '@/components/ui/primitives';
import { kitById } from './kits';
import type { Draft, Section } from './theme-fields';
import {
  CHROME_OPTIONS, COMMERCE_OPTIONS, DESIGN_OPTIONS, effective, NO_VARIANTS, SECTION_VARIANT_OPTIONS,
  type ChromeKey, type CommerceKey, type DesignKey, type KitVariants, type Overrides,
} from './variants';

/**
 * The design choices of 2.63 (variants.ts): each one shows what the site shows — the business's own, else the kit's. Picking
 * the kit's value is the same as not picking (nothing is saved); "חזרה לברירת המחדל של הערכה" removes the business's choice.
 */
export const kitVariants = (d: Draft): KitVariants => kitById(d.kit)?.variants ?? NO_VARIANTS;

function Choice({ label, options, own, kit, hasKit, onPick }: {
  label: string; options: { id: string; label: string }[]; own: string | undefined; kit: string | undefined; hasKit: boolean; onPick: (v: string | undefined) => void;
}) {
  const value = effective(options, own, kit);
  const fallback = effective(options, undefined, kit);
  return (
    <div className="mb-3">
      <label className="block">
        <span className="mb-1 block text-sm font-semibold text-ink-2">{label}</span>
        <Select value={value} onChange={(e) => onPick(e.target.value === fallback ? undefined : e.target.value)}>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.id === fallback ? (hasKit ? ' (של הערכה)' : ' (ברירת מחדל)') : ''}</option>)}
        </Select>
      </label>
      {own !== undefined && own !== fallback && (
        <button type="button" className="mt-1 text-sm font-semibold text-primary underline underline-offset-2" onClick={() => onPick(undefined)}>
          {hasKit ? 'חזרה לברירת המחדל של הערכה' : 'חזרה לברירת המחדל'}
        </button>
      )}
    </div>
  );
}

type Group = 'design' | 'chrome' | 'commerce';
const LISTS = { design: DESIGN_OPTIONS, chrome: CHROME_OPTIONS, commerce: COMMERCE_OPTIONS } as const;

/** a new draft with one choice set (or removed — back to the kit's) */
export function withOverride(d: Draft, group: Group, key: string, v: string | undefined): Draft {
  const next: Overrides = { design: { ...d.overrides.design }, chrome: { ...d.overrides.chrome }, commerce: { ...d.overrides.commerce } };
  const g = next[group] as Record<string, string>;
  if (v === undefined) delete g[key]; else g[key] = v;
  return { ...d, overrides: next };
}
export function withSectionVariant(d: Draft, id: string, v: string | undefined): Draft {
  return { ...d, sections: d.sections.map((s) => {
    if (s.id !== id) return s;
    const next: Section = { ...s };
    if (v === undefined) delete next.variant; else next.variant = v;
    return next;
  }) };
}

/** the whole site: header, footer, cards, product page, spacing, headings, buttons, width */
export function DesignChoices({ d, change }: { d: Draft; change: (next: Draft) => void }) {
  const kit = kitVariants(d);
  const hasKit = Boolean(kitById(d.kit));
  const rows: [Group, string][] = [
    ['chrome', 'header'], ['chrome', 'footer'], ['commerce', 'productCard'], ['commerce', 'collectionCard'], ['commerce', 'productPage'],
    ['design', 'spacing'], ['design', 'headingScale'], ['design', 'buttonStyle'], ['design', 'container'], ['design', 'cardStyle'],
  ];
  return (
    <div className="grid gap-x-4 sm:grid-cols-2">
      {rows.map(([group, key]) => {
        const def = (LISTS[group] as Record<string, { label: string; options: { id: string; label: string }[] }>)[key];
        return (
          <Choice key={`${group}.${key}`} label={def.label} options={def.options} hasKit={hasKit}
            own={(d.overrides[group] as Record<string, string>)[key]} kit={(kit[group] as Record<string, string>)[key]}
            onPick={(v) => change(withOverride(d, group, key, v))} />
        );
      })}
    </div>
  );
}
export type { ChromeKey, CommerceKey, DesignKey };

/** one section's layout — only for a type with more than one */
export function SectionLayout({ d, section, change }: { d: Draft; section: Section; change: (next: Draft) => void }) {
  const options = SECTION_VARIANT_OPTIONS[section.type] ?? [];
  if (options.length < 2) return null;
  return (
    <Choice label="פריסה" options={options} own={section.variant} kit={kitVariants(d).sections[section.id]} hasKit={Boolean(kitById(d.kit))}
      onPick={(v) => change(withSectionVariant(d, section.id, v))} />
  );
}
