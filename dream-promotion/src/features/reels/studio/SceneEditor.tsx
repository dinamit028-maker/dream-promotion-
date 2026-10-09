'use client';
import { Button, Field, Input, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal } from '@/components/ui/feedback';
import { MicButton } from '@/components/ui/MicButton';
import type { ReelScene } from '@/types';
import { roleLabel } from './parts';

/** A scene's texts, its length and its prompt (2.75 — moved out of app/(app)/reels/page.tsx as it was). */
export function SceneEditor({ editing, scenes, setScenes, onClose }: {
  editing: number | null; scenes: ReelScene[]; setScenes: (next: ReelScene[]) => void; onClose: () => void;
}) {
  return (
    <Modal open={editing !== null} onClose={() => onClose()}>
      {editing !== null && scenes[editing] && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-display text-xl font-bold">עריכת {roleLabel(scenes[editing].role, editing)}</h3>
            <CloseButton onClick={() => onClose()} />
          </div>
          <Field label="כיתוב על המסך">
            <Input value={scenes[editing].onScreen}
              onChange={(e) => setScenes(scenes.map((s, n) => (n === editing ? { ...s, onScreen: e.target.value } : s)))} />
          </Field>
          <Field label="טקסט הקריינות — זה מה שייאמר בקול">
            <Textarea className="min-h-24" value={scenes[editing].voiceover}
              onChange={(e) => setScenes(scenes.map((s, n) => (n === editing ? { ...s, voiceover: e.target.value } : s)))} />
            <MicButton className="mt-2" label="הכתבה בקול"
              onText={(t) => { const i = editing; setScenes(scenes.map((s, n) => (n === i ? { ...s, voiceover: s.voiceover?.trim() ? `${s.voiceover.trim()} ${t}` : t } : s))); }} />
          </Field>
          <Field label="אורך הקליפ (שניות)">
            <Input type="number" min={2} max={30} value={scenes[editing].seconds}
              onChange={(e) => setScenes(scenes.map((s, n) => (n === editing ? { ...s, seconds: Math.min(30, Math.max(2, +e.target.value || 15)) } : s)))} />
          </Field>
          <Field label="הפרומפט שנשלח למנוע הווידאו (אנגלית)">
            <Textarea className="min-h-28 text-left" dir="ltr" value={scenes[editing].videoPrompt || ''}
              onChange={(e) => setScenes(scenes.map((s, n) => (n === editing ? { ...s, videoPrompt: e.target.value } : s)))} />
          </Field>
          <p className="mb-4 text-sm text-muted">
            סצנות של אנשים, מקומות ומוצרים עוברות כמעט תמיד. הפשטות טכנולוגיות, מפות עולם ומסכים עם ממשקים נחסמות בבדיקת התוכן.
          </p>
          <Button variant="primary" onClick={() => onClose()}>סיום</Button>
        </>
      )}
    </Modal>
  );
}
