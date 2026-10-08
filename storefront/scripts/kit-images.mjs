// Default pictures of the starter kits (2.62): a folder of one kit's pictures as delivered (WebP files + kit-images.json)
// becomes the kit's pictures in public/kit-images/<kit>/ and its asset manifest in src/lib/kit-images/<kit>.json — one
// shape for every kit, whatever the delivered JSON looked like. Every file is checked: it exists, it is WebP, and its real
// size is the size the JSON says (else the size is taken from the file, and the script says so).
//   node scripts/kit-images.mjs <folder> [<folder> …]     the folder is named after the kit, or its JSON names it
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const KIT = /^[a-z][a-z0-9-]{1,30}$/;
const SLOTS = ['hero', 'imageText', 'collection', 'gallery'];

/** the width and height a WebP file declares (VP8, VP8L or VP8X) */
export function webpSize(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
  if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return null;
}

const num01 = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? Math.round(v * 100) / 100 : 0.5);

/** a delivered kit-images.json → the manifest (pure; the notes say what was changed on the way) */
export function normalize(raw, kit, sizes) {
  const notes = [];
  const images = [];
  for (const i of Array.isArray(raw.images) ? raw.images : []) {
    if (!SLOTS.includes(i.slot)) { notes.push(`${i.file}: unknown slot "${i.slot}" — left out`); continue; }
    const real = sizes[i.file];
    if (!real) { notes.push(`${i.file}: no such WebP file — left out`); continue; }
    if (real.width !== i.width || real.height !== i.height) notes.push(`${i.file}: the JSON says ${i.width}×${i.height}, the file is ${real.width}×${real.height} — the file's size is used`);
    const img = { file: i.file, slot: i.slot, width: real.width, height: real.height, focal: { x: num01(i.focal?.x), y: num01(i.focal?.y) }, alt: String(i.alt ?? '').trim() };
    if (!img.alt) notes.push(`${i.file}: no alt text`);
    if (i.slot === 'hero') {
      img.variant = i.variant === 'vertical' ? 'vertical' : 'wide';
      // the delivered JSON names a physical side; the schema a logical one (the sites are RTL): right → start, left → end
      const side = { right: 'start', left: 'end', start: 'start', end: 'end' }[i.textSafe];
      if (side) img.textSafe = side;
    }
    if (i.slot === 'collection') {
      if (typeof i.collection !== 'string' || !i.collection) { notes.push(`${i.file}: a collection picture without a collection — left out`); continue; }
      img.collection = i.collection;
    }
    img._order = Number.isFinite(i.order) ? i.order : 99;
    images.push(img);
  }
  // the order counts within a slot (and a hero's variant): 1, 2, 3 — whatever numbers the JSON used
  const groups = new Map();
  for (const img of images) { const k = `${img.slot}/${img.variant ?? ''}`; groups.set(k, [...(groups.get(k) ?? []), img]); }
  for (const list of groups.values()) list.sort((a, b) => a._order - b._order || a.file.localeCompare(b.file)).forEach((img, n) => { img.order = n + 1; });
  const slotRank = (img) => SLOTS.indexOf(img.slot) * 10 + (img.variant === 'vertical' ? 1 : 0);
  images.sort((a, b) => slotRank(a) - slotRank(b) || a.order - b.order);
  for (const img of images) delete img._order;
  const dup = images.map((i) => i.collection).filter((c, n, all) => c && all.indexOf(c) !== n);
  if (dup.length) notes.push(`two pictures for the collection ${dup.join(', ')}`);
  return { manifest: { kit, version: Number.isInteger(raw.version) ? raw.version : 1, images }, notes };
}

function importFolder(dir) {
  const raw = JSON.parse(readFileSync(join(dir, 'kit-images.json'), 'utf8'));
  const kit = KIT.test(raw.kit ?? '') ? raw.kit : basename(dir);
  if (!KIT.test(kit)) throw new Error(`${dir}: no kit name`);
  const sizes = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.webp'))) {
    const s = webpSize(readFileSync(join(dir, f)));
    if (s) sizes[f] = s;
  }
  const { manifest, notes } = normalize(raw, kit, sizes);
  const out = join(root, 'public', 'kit-images', kit);
  mkdirSync(out, { recursive: true });
  for (const img of manifest.images) copyFileSync(join(dir, img.file), join(out, img.file));
  mkdirSync(join(root, 'src', 'lib', 'kit-images'), { recursive: true });
  writeFileSync(join(root, 'src', 'lib', 'kit-images', `${kit}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${kit}: ${manifest.images.length} pictures${notes.length ? `\n  - ${notes.join('\n  - ')}` : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length < 3) { console.error('usage: node scripts/kit-images.mjs <folder> [<folder> …]'); process.exit(1); }
  for (const dir of process.argv.slice(2)) importFolder(dir);
}
