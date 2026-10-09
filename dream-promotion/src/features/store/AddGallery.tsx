'use client';
import { Button } from '@/components/ui/primitives';
import { LIBRARY, LIBRARY_CATEGORIES } from './builder-registry';
import { SECTION_DEFS, type SectionType } from './theme-fields';
import { ADDABLE } from './visual-edit';

/**
 * "+ הוספה" (Dream Builder PR-3e, 2.69): the kinds of section, by category — each with its picture from the real renderer
 * (/section-previews/<type>.jpg, `npm run kit-shots`), its name and a line about it. A choice adds it where the owner
 * asked (after a section on the page, or at the end), with its starting words.
 */
export function AddGallery({ where, onPick, onBack }: { where: string; onPick: (type: SectionType) => void; onBack: () => void }) {
  return (
    <div className="stack-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-bold">חלק חדש</h2>
        <Button size="sm" variant="ghost" onClick={onBack}>סגירה</Button>
      </div>
      <p className="text-sm text-muted">{where}. כל חלק נכנס עם מילים להתחלה — אחר כך עורכים אותן באתר.</p>
      {LIBRARY_CATEGORIES.map((cat) => {
        const items = LIBRARY.filter((x) => x.category === cat && ADDABLE.includes(x.type as SectionType));
        if (!items.length) return null;
        return (
          <section key={cat} aria-label={cat}>
            <h3 className="mb-2 text-sm font-bold text-ink-2">{cat}</h3>
            <ul className="grid grid-cols-2 gap-2" role="list">
              {items.map((x) => {
                const label = SECTION_DEFS[x.type as SectionType].label;
                return (
                  <li key={x.type}>
                    <button type="button" className="flex h-full w-full flex-col overflow-hidden rounded-md border border-line bg-surface text-start hover:ring-2 hover:ring-primary/50 focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label={`הוספת ${label}`} onClick={() => onPick(x.type as SectionType)}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/section-previews/${x.type}.jpg`} alt="" width={320} height={160} loading="lazy" className="aspect-2/1 w-full bg-white object-cover object-top-right" />
                      <span className="block p-2">
                        <span className="block text-sm font-semibold">{label}</span>
                        <span className="block text-xs text-muted">{x.about}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
