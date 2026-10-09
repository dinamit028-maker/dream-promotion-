'use client';
import {
  DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cx } from '@/lib/utils';
import { DEVICES, SECTION_DEFS, type Section } from './theme-fields';

/**
 * The home page's sections in the visual editor's panel (Dream Builder PR-3a, 2.65): a list that is dragged — a mouse at
 * once, a finger after holding the handle for 400ms (so a scroll is not a drag), a keyboard with space, the arrows and
 * Escape — with what happened said in Hebrew. The "▲ / ▼" buttons of a section stay, as the way that always works.
 */
const label = (sections: Section[], id: unknown) => { const s = sections.find((x) => x.id === id); return s ? SECTION_DEFS[s.type].label : 'החלק'; };

export function SectionList({ sections, onChoose, onMove }: { sections: Section[]; onChoose: (id: string) => void; onMove: (from: number, to: number) => void }) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const place = (id: unknown) => `${sections.findIndex((s) => s.id === id) + 1} מתוך ${sections.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `"${label(sections, active.id)}" הורם, מקום ${place(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `"${label(sections, active.id)}" מעל מקום ${place(over.id)}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `"${label(sections, active.id)}" הונח במקום ${place(over.id)}.` : `"${label(sections, active.id)}" הונח.`),
    onDragCancel: ({ active }) => `ההזזה של "${label(sections, active.id)}" בוטלה.`,
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onMove(sections.findIndex((s) => s.id === active.id), sections.findIndex((s) => s.id === over.id));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}
      accessibility={{ announcements, screenReaderInstructions: { draggable: 'כדי להזיז: רווח כדי להרים, חיצים כדי להזיז, רווח כדי להניח, Escape כדי לבטל.' } }}>
      <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <ol className="stack-y-1" aria-label="החלקים של עמוד הבית — אפשר לגרור כדי לשנות את הסדר">
          {sections.map((s) => <Row key={s.id} section={s} onChoose={onChoose} />)}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function Row({ section: s, onChoose }: { section: Section; onChoose: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  return (
    // the row moves with the drag (a transform, set through React — the dashboard has no CSP against it)
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('flex items-stretch gap-1 rounded-md border border-line bg-surface', s.hidden && 'opacity-60', isDragging && 'relative z-10 shadow-lg ring-2 ring-primary/50')}>
      <button type="button" className="flex w-11 shrink-0 cursor-grab touch-none items-center justify-center text-lg text-muted" aria-label={`גרירת "${SECTION_DEFS[s.type].label}"`} {...attributes} {...listeners}>⠿</button>
      <button type="button" className="flex min-h-11 flex-1 items-center justify-between px-2 text-start text-sm" onClick={() => onChoose(s.id)}>
        <span className="font-semibold">{SECTION_DEFS[s.type].label}</span>
        {s.hidden ? <span className="text-xs text-muted">מוסתר</span>
          : s.hiddenOn?.length ? <span className="text-xs text-muted">לא ב{DEVICES.filter((d) => s.hiddenOn!.includes(d.id)).map((d) => d.label).join(', ')}</span> : null}
      </button>
    </li>
  );
}
