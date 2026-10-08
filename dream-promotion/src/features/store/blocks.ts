/**
 * The free section's columns and blocks in the editor (Dream Builder PR-3c, 2.67) — pure rules, each returns new columns
 * (never changed in place, so undo keeps its steps) or the same array when nothing changes. The limits and the checks are
 * the registry's (builder-registry.ts, the same file on the storefront): at most 4 columns of 12 blocks, a width from the
 * list, every value through cleanField.
 */
import { BLOCKS, cleanField, MAX_BLOCKS, MAX_COLUMNS, SPANS, type Block, type BlockType, type Column, type Span } from './builder-registry';
import type { Draft } from './theme-fields';

const ids = (cols: Column[]) => new Set(cols.flatMap((c) => [c.id, ...c.blocks.map((b) => b.id)]));
function freeId(cols: Column[], prefix: string): string {
  const taken = ids(cols);
  for (let n = 1; n < 1000; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
  return `${prefix}${Date.now() % 100000}`;
}
const block = (cols: Column[], type: BlockType, settings: Record<string, string> = {}): Block =>
  ({ id: freeId(cols, 'b'), type, settings: { ...BLOCKS[type].defaults, ...settings } });

/** a new free section: words and a button beside a picture (on a phone, one under the other) */
export function defaultColumns(): Column[] {
  return [
    { id: 'c1', span: 6, blocks: [
      { id: 'b1', type: 'heading', settings: { ...BLOCKS.heading.defaults, text: 'כותרת לחלק' } },
      { id: 'b2', type: 'paragraph', settings: { ...BLOCKS.paragraph.defaults } },
      { id: 'b3', type: 'button', settings: { ...BLOCKS.button.defaults } },
    ] },
    { id: 'c2', span: 6, blocks: [{ id: 'b4', type: 'image', settings: { ...BLOCKS.image.defaults } }] },
  ];
}

/** where a block is: its column and place — or null */
export function findBlock(cols: Column[], id: string): { column: Column; index: number; block: Block } | null {
  for (const column of cols) { const index = column.blocks.findIndex((b) => b.id === id); if (index >= 0) return { column, index, block: column.blocks[index] }; }
  return null;
}

/** one more column at the end (empty, a third of the row) — the same columns at 4 */
export function addColumn(cols: Column[]): Column[] {
  return cols.length >= MAX_COLUMNS ? cols : [...cols, { id: freeId(cols, 'c'), span: 4, blocks: [] }];
}
export const removeColumn = (cols: Column[], id: string): Column[] => (cols.some((c) => c.id === id) ? cols.filter((c) => c.id !== id) : cols);
export function setSpan(cols: Column[], id: string, span: number): Column[] {
  if (!SPANS.includes(span as Span)) return cols;
  return cols.map((c) => (c.id === id && c.span !== span ? { ...c, span: span as Span } : c));
}
/** a column one place to the side (in a Hebrew page, -1 is to the right) */
export function stepColumn(cols: Column[], id: string, by: -1 | 1): Column[] {
  const i = cols.findIndex((c) => c.id === id), j = i + by;
  if (i < 0 || j < 0 || j >= cols.length) return cols;
  const out = cols.slice(); [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** a new block of a kind at the end of a column — null when the column is full or unknown */
export function addBlock(cols: Column[], columnId: string, type: BlockType): { columns: Column[]; id: string } | null {
  const c = cols.find((x) => x.id === columnId);
  if (!c || c.blocks.length >= MAX_BLOCKS || !Object.hasOwn(BLOCKS, type)) return null;
  const b = block(cols, type);
  return { columns: cols.map((x) => (x === c ? { ...x, blocks: [...x.blocks, b] } : x)), id: b.id };
}
export function removeBlock(cols: Column[], id: string): Column[] {
  const at = findBlock(cols, id);
  return at ? cols.map((c) => (c === at.column ? { ...c, blocks: c.blocks.filter((b) => b.id !== id) } : c)) : cols;
}
/** a copy of a block, right after it */
export function duplicateBlock(cols: Column[], id: string): { columns: Column[]; id: string } | null {
  const at = findBlock(cols, id);
  if (!at || at.column.blocks.length >= MAX_BLOCKS) return null;
  const b = block(cols, at.block.type, at.block.settings);
  const blocks = at.column.blocks.slice(); blocks.splice(at.index + 1, 0, b);
  return { columns: cols.map((c) => (c === at.column ? { ...c, blocks } : c)), id: b.id };
}
/** one field of a block, checked as the storefront checks it — the same columns when the value is not taken */
export function setBlockField(cols: Column[], id: string, key: string, value: string): Column[] {
  const at = findBlock(cols, id);
  const f = at && BLOCKS[at.block.type].fields.find((x) => x.key === key);
  if (!at || !f) return cols;
  // a text and a link are kept as typed while typing (a link is checked by blockLinkOk in the panel, and by cleanColumns
  // before the storefront shows it: one that is not right is not shown); only their length is cut here
  const v = f.kind === 'text' || f.kind === 'longtext' ? value.slice(0, f.max ?? 120) : f.kind === 'link' ? value.trim().slice(0, 300) : cleanField(f, value);
  if (v === undefined || at.block.settings[key] === v) return cols;
  return cols.map((c) => (c === at.column ? { ...c, blocks: c.blocks.map((b) => (b.id === id ? { ...b, settings: { ...b.settings, [key]: v } } : b)) } : c));
}

/**
 * A block to a place: into a column (another, or its own) at an index among that column's blocks without it. Into a full
 * column — no; past the end — the end. The same columns when nothing moves.
 */
export function moveBlock(cols: Column[], id: string, toColumn: string, toIndex: number): Column[] {
  const at = findBlock(cols, id);
  const target = cols.find((c) => c.id === toColumn);
  if (!at || !target || !Number.isInteger(toIndex) || toIndex < 0) return cols;
  if (target !== at.column && target.blocks.length >= MAX_BLOCKS) return cols;
  const rest = target.blocks.filter((b) => b.id !== id);
  const index = Math.min(toIndex, rest.length);
  if (target === at.column && index === at.index) return cols;
  const blocks = [...rest.slice(0, index), at.block, ...rest.slice(index)];
  return cols.map((c) => (c === target ? { ...c, blocks } : c === at.column ? { ...c, blocks: c.blocks.filter((b) => b.id !== id) } : c));
}
/** a block one place up or down in its column */
export function stepBlock(cols: Column[], id: string, by: -1 | 1): Column[] {
  const at = findBlock(cols, id);
  return at ? moveBlock(cols, id, at.column.id, at.index + by < 0 ? 0 : at.index + by) : cols;
}

/** the draft with a free section's new columns (the same draft when they did not change) */
export function withColumns(d: Draft, section: string, cols: Column[]): Draft {
  const s = d.sections.find((x) => x.id === section);
  if (!s || s.type !== 'custom' || s.columns === cols) return d;
  return { ...d, sections: d.sections.map((x) => (x === s ? { ...x, columns: cols } : x)) };
}
