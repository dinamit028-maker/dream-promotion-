'use client';
import { useState } from 'react';
import {
  DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCorners, useDroppable, useSensor, useSensors, type Announcements, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cx } from '@/lib/utils';
import { Button, Select } from '@/components/ui/primitives';
import { BLOCK_TYPES, BLOCKS, blockLinkOk, MAX_BLOCKS, MAX_COLUMNS, SPANS, type Block, type BlockType, type Column } from './builder-registry';
import {
  addBlock, addColumn, duplicateBlock, findBlock, moveBlock, removeBlock, removeColumn, setBlockField, setSpan, spanShown, stepBlock, stepColumn, type ColumnDevice,
} from './blocks';
import { FieldInput } from './StoreDesign';
import { Notice } from './ui';

/**
 * The free section in the panel (Dream Builder PR-3c, 2.67): its columns — a width from the list, to the side, removed,
 * added up to 4 — and their blocks, dragged within a column and between columns (an empty one too): a mouse at once, a
 * finger after holding the handle, a keyboard with space and the arrows; what happened is said in Hebrew. A block opens
 * its fields here (also when it is clicked on the page); "▲ / ▼" stay as the way that always works.
 */
const SPAN_LABEL: Record<number, string> = { 3: 'רבע', 4: 'שליש', 6: 'חצי', 8: 'שני שלישים', 9: 'שלושה רבעים', 12: 'כל הרוחב' };
const COL = 'col:';
const summary = (b: Block) => {
  const t = b.settings.text || b.settings.label || b.settings.alt || '';
  return t.length > 28 ? `${t.slice(0, 28)}…` : t;
};

const DEVICE_LABEL: Record<ColumnDevice, string> = { base: 'טלפון', md: 'טאבלט', lg: 'מחשב' };

export function ColumnsEditor({ columns, block, onChange, onBlock, device = 'md' }: {
  columns: Column[]; block: string | null;
  /** 2.70: the screen whose widths are shown and set (the editor's screen switch) */
  device?: ColumnDevice;
  onChange: (cols: Column[], key?: string | null) => void;
  onBlock: (id: string | null) => void;
}) {
  const open = block ? findBlock(columns, block) : null;
  if (open) return <BlockFields columns={columns} at={open} onChange={onChange} onBlock={onBlock} />;
  const total = columns.reduce((n, c) => n + spanShown(c, device), 0);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{`הרוחב של כל עמודה — ב${DEVICE_LABEL[device]} (מחליפים מסך למעלה). בטלפון, בלי בחירה, העמודות אחת מתחת לשנייה; במחשב — כמו בטאבלט. בכל עמודה בלוקים, שאפשר לגרור גם לעמודה אחרת.`}</p>
      {total > 12 && <Notice tone="info">{`ב${DEVICE_LABEL[device]}: סך הרוחב ${total} מתוך 12 — מה שלא נכנס בשורה יורד לשורה הבאה.`}</Notice>}
      <BlockBoard columns={columns} onChange={onChange} onBlock={onBlock} device={device} />
      <Button size="sm" variant="soft" disabled={columns.length >= MAX_COLUMNS} onClick={() => onChange(addColumn(columns))}>
        {columns.length >= MAX_COLUMNS ? `עד ${MAX_COLUMNS} עמודות` : '+ עמודה'}
      </Button>
    </div>
  );
}

/** the classic editor: the same panel, the open block kept here (there is no page to click on) */
export function ColumnsField({ columns, onChange }: { columns: Column[]; onChange: (cols: Column[]) => void }) {
  const [block, setBlock] = useState<string | null>(null);
  const [device, setDevice] = useState<ColumnDevice>('md');
  return (
    <div className="space-y-2">
      <div className="flex gap-1" role="group" aria-label="הרוחב של העמודות — לאיזה מסך">
        {(['base', 'md', 'lg'] as const).map((dv) => <Button key={dv} size="sm" variant={device === dv ? 'primary' : 'ghost'} aria-pressed={device === dv}
          onClick={() => setDevice(dv)}>{DEVICE_LABEL[dv]}</Button>)}
      </div>
      <ColumnsEditor columns={columns} block={block} onChange={(cols) => onChange(cols)} onBlock={setBlock} device={device} />
    </div>
  );
}

function BlockBoard({ columns, onChange, onBlock, device }: { columns: Column[]; onChange: (cols: Column[]) => void; onBlock: (id: string) => void; device: ColumnDevice }) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const name = (id: unknown) => { const at = findBlock(columns, String(id)); return at ? BLOCKS[at.block.type].label : 'הבלוק'; };
  const where = (id: unknown) => {
    const s = String(id);
    if (s.startsWith(COL)) { const n = columns.findIndex((c) => c.id === s.slice(COL.length)); return `סוף עמודה ${n + 1}`; }
    const at = findBlock(columns, s);
    return at ? `עמודה ${columns.indexOf(at.column) + 1}, מקום ${at.index + 1}` : '';
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `"${name(active.id)}" הורם, ${where(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `"${name(active.id)}" מעל ${where(over.id)}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `"${name(active.id)}" הונח: ${where(over.id)}.` : `"${name(active.id)}" הונח.`),
    onDragCancel: ({ active }) => `ההזזה של "${name(active.id)}" בוטלה.`,
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const id = String(active.id), to = String(over.id);
    if (to.startsWith(COL)) { const c = columns.find((x) => x.id === to.slice(COL.length)); if (c) onChange(moveBlock(columns, id, c.id, c.blocks.length)); return; }
    const at = findBlock(columns, to);
    if (at) onChange(moveBlock(columns, id, at.column.id, at.index));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}
      accessibility={{ announcements, screenReaderInstructions: { draggable: 'כדי להזיז בלוק: רווח כדי להרים, חיצים כדי להזיז (גם לעמודה אחרת), רווח כדי להניח, Escape כדי לבטל.' } }}>
      <div className="space-y-3">
        {columns.map((c, n) => (
          <ColumnBox key={c.id} column={c} n={n} count={columns.length} onBlock={onBlock} device={device}
            onSpan={(span) => onChange(setSpan(columns, c.id, span, device))}
            onStep={(by) => onChange(stepColumn(columns, c.id, by))}
            onRemove={() => { if (!c.blocks.length || window.confirm(`למחוק את עמודה ${n + 1} עם הבלוקים שבה?`)) onChange(removeColumn(columns, c.id)); }}
            onAdd={(type) => { const r = addBlock(columns, c.id, type); if (r) { onChange(r.columns); onBlock(r.id); } }} />
        ))}
      </div>
    </DndContext>
  );
}

function ColumnBox({ column: c, n, count, onBlock, device, onSpan, onStep, onRemove, onAdd }: {
  column: Column; n: number; count: number; onBlock: (id: string) => void; device: ColumnDevice;
  onSpan: (span: number) => void; onStep: (by: -1 | 1) => void; onRemove: () => void; onAdd: (type: BlockType) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COL}${c.id}` });
  const [type, setType] = useState<BlockType>('paragraph');
  return (
    <fieldset className="rounded-md border border-line p-2" aria-label={`עמודה ${n + 1}`}>
      <legend className="px-1 text-sm font-bold">{`עמודה ${n + 1}`}</legend>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 flex gap-1 text-xs font-semibold text-ink-2">{`רוחב (${DEVICE_LABEL[device]})`}
            {device === 'base' && c.spanBase && <span className="text-primary">• לא אחת מתחת לשנייה</span>}
            {device === 'lg' && c.spanLg && <span className="text-primary">• רק במחשב</span>}</span>
          <Select value={String(spanShown(c, device))} onChange={(e) => onSpan(Number(e.target.value))} aria-label={`הרוחב של עמודה ${n + 1} (${DEVICE_LABEL[device]})`}>
            {SPANS.map((s) => <option key={s} value={s}>{`${SPAN_LABEL[s]} (${s}/12)`}</option>)}
          </Select>
        </label>
        <Button size="sm" variant="ghost" disabled={n <= 0} aria-label={`להזיז את עמודה ${n + 1} ימינה`} onClick={() => onStep(-1)}>→</Button>
        <Button size="sm" variant="ghost" disabled={n >= count - 1} aria-label={`להזיז את עמודה ${n + 1} שמאלה`} onClick={() => onStep(1)}>←</Button>
        <Button size="sm" variant="ghost" className="text-red-700" aria-label={`למחוק את עמודה ${n + 1}`} onClick={onRemove}>מחיקה</Button>
      </div>
      <SortableContext id={`${COL}${c.id}`} items={c.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        <ol ref={setNodeRef} className={cx('min-h-11 space-y-1 rounded-md', isOver && 'bg-primary/5 ring-2 ring-primary/40')} aria-label={`הבלוקים של עמודה ${n + 1}`}>
          {c.blocks.map((b) => <BlockRow key={b.id} block={b} onOpen={() => onBlock(b.id)} />)}
          {!c.blocks.length && <li className="p-2 text-xs text-muted">עמודה ריקה — מוסיפים בלוק או גוררים אליה אחד.</li>}
        </ol>
      </SortableContext>
      <div className="mt-2 flex items-end gap-2">
        <label className="block flex-1">
          <span className="mb-1 block text-xs font-semibold text-ink-2">בלוק חדש</span>
          <Select value={type} onChange={(e) => setType(e.target.value as BlockType)} aria-label={`בלוק חדש בעמודה ${n + 1}`}>
            {BLOCK_TYPES.map((t) => <option key={t} value={t}>{BLOCKS[t].label}</option>)}
          </Select>
        </label>
        <Button size="sm" variant="soft" disabled={c.blocks.length >= MAX_BLOCKS} onClick={() => onAdd(type)} aria-label={`הוספת בלוק לעמודה ${n + 1}`}>+ הוספה</Button>
      </div>
    </fieldset>
  );
}

function BlockRow({ block: b, onOpen }: { block: Block; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: b.id });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('flex items-stretch gap-1 rounded-md border border-line bg-surface', isDragging && 'relative z-10 shadow-lg ring-2 ring-primary/50')}>
      <button type="button" className="flex w-11 shrink-0 cursor-grab touch-none items-center justify-center text-lg text-muted" aria-label={`גרירת "${BLOCKS[b.type].label}"`} {...attributes} {...listeners}>⠿</button>
      <button type="button" className="flex min-h-11 flex-1 items-center gap-2 px-2 text-start text-sm" onClick={onOpen}>
        <span className="font-semibold">{BLOCKS[b.type].label}</span>
        <span className="truncate text-xs text-muted">{summary(b)}</span>
      </button>
    </li>
  );
}

function BlockFields({ columns, at, onChange, onBlock }: {
  columns: Column[]; at: NonNullable<ReturnType<typeof findBlock>>;
  onChange: (cols: Column[], key?: string | null) => void; onBlock: (id: string | null) => void;
}) {
  const b = at.block, def = BLOCKS[b.type];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">{`בלוק: ${def.label}`}</h3>
        <Button size="sm" variant="ghost" onClick={() => onBlock(null)}>← לעמודות</Button>
      </div>
      <div className="flex flex-wrap gap-2" role="toolbar" aria-label="פעולות על הבלוק">
        <Button size="sm" variant="soft" disabled={at.index <= 0} onClick={() => onChange(stepBlock(columns, b.id, -1))}>▲ למעלה</Button>
        <Button size="sm" variant="soft" disabled={at.index >= at.column.blocks.length - 1} onClick={() => onChange(stepBlock(columns, b.id, 1))}>▼ למטה</Button>
        <Button size="sm" variant="soft" disabled={at.column.blocks.length >= MAX_BLOCKS} onClick={() => { const r = duplicateBlock(columns, b.id); if (r) { onChange(r.columns); onBlock(r.id); } }}>שכפול</Button>
        <Button size="sm" variant="ghost" className="text-red-700" onClick={() => { onChange(removeBlock(columns, b.id)); onBlock(null); }}>מחיקה</Button>
      </div>
      {def.fields.map((f) => {
        const value = b.settings[f.key] ?? '';
        const set = (v: unknown) => onChange(setBlockField(columns, b.id, f.key, typeof v === 'string' ? v : ''), `block:${b.id}:${f.key}`);
        if (f.kind === 'choice') {
          return (
            <label key={f.key} className="block max-w-56">
              <span className="mb-1 block text-sm font-semibold text-ink-2">{f.label}</span>
              <Select value={value} onChange={(e) => set(e.target.value)}>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
            </label>
          );
        }
        return (
          <div key={f.key}>
            <FieldInput f={{ key: f.key, label: f.label, kind: f.kind, max: f.max, hint: f.kind === 'link' ? 'דף באתר (/collections/all), כתובת https, או whatsapp' : undefined }}
              value={value} collections={[]} onChange={set} />
            {f.kind === 'link' && !blockLinkOk(value) && <Notice tone="warn">הקישור לא תקין — הכפתור לא יופיע עד שיתוקן.</Notice>}
          </div>
        );
      })}
    </div>
  );
}
