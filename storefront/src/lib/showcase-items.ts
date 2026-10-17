import { kitPicture } from './kit-images';
import type { ShowcaseItem } from './showcase';
import { safeImage } from './theme';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const HEX = /^#[0-9a-f]{6}$/;

/**
 * A catalog's rows (already checked by resolveTheme) → the models to show (2.101), on the server: the business's own picture,
 * else the kit's by its file (kitPicture), else none — the page draws one in the brand's colour. A row without a name is left out.
 */
export function showcaseItems(rows: unknown, kit: string | null): ShowcaseItem[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw, n): ShowcaseItem[] => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = str(r.name);
    if (!name) return [];
    const brand = str(r.brand);
    const own = safeImage(r.image);
    const kitPic = own ? null : kitPicture(kit, str(r.pic));
    const label = [name, brand].filter(Boolean).join(' — ');
    return [{
      n, name, brand, color: HEX.test(str(r.color)) ? str(r.color) : '', category: str(r.category), material: str(r.material),
      handle: str(r.handle), finish: str(r.finish), shape: str(r.shape), text: str(r.text),
      minQty: typeof r.minQty === 'number' && Number.isInteger(r.minQty) && r.minQty > 0 ? r.minQty : null,
      picture: own ? { src: own, alt: label, className: '' } : kitPic ? { src: kitPic.src, alt: kitPic.alt || label, className: kitPic.className } : null,
    }];
  });
}
