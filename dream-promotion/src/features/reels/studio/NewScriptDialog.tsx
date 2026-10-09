'use client';
import { Button } from '@/components/ui/primitives';
import { CloseButton, Modal } from '@/components/ui/feedback';

/** "תסריט חדש" on a project that already has clips or narration: a new project, or this one's script replaced (2.75). */
export function NewScriptDialog({ open, onClose, onFresh, onReplace }: { open: boolean; onClose: () => void; onFresh: () => void; onReplace: () => void }) {
  return (
    <Modal open={open} onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-xl font-bold">תסריט חדש</h3>
        <CloseButton onClick={onClose} />
      </div>
      <p className="mb-5 text-sm text-muted">בפרויקט הזה כבר יש קליפים וקריינות. הקבצים עצמם שמורים בספריית המדיה בכל מקרה.</p>
      <div className="grid gap-3">
        <Button variant="primary" onClick={onFresh}>פרויקט חדש (הנוכחי נשמר)</Button>
        <Button variant="ghost" onClick={onReplace}>
          החלפת התסריט בפרויקט הזה
        </Button>
      </div>
    </Modal>
  );
}
