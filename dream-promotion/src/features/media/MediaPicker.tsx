'use client';
import { useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { MediaService } from '@/lib/services';
import { Button } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';

/**
 * Pick any image or clip already in the library — including paid AI images —
 * or upload a new one. The same picker is used in Create, the editor and the week plan.
 */
export function MediaPicker({
  open, onClose, onPick, selectedId,
}: { open: boolean; onClose: () => void; onPick: (mediaId: string) => void; selectedId?: string | null }) {
  const { media, addMedia } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError(null);
    try {
      const asset = await MediaService.upload(files[0]);
      addMedia(asset);
      onPick(asset.id);
      onClose();
    } catch (e: any) { setError(`ההעלאה נכשלה: ${e?.message ?? 'שגיאה לא ידועה'}`); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  return (
    <Modal open={open} onClose={onClose} wide>
      <div className="mb-5 flex items-center justify-between gap-3">
        <h3 className="font-display text-2xl font-extrabold">בחירה מספריית המדיה</h3>
        <CloseButton onClick={onClose} />
      </div>
      <input ref={input} type="file" accept="image/*,video/*" hidden onChange={(e) => onFiles(e.target.files)} />
      <Button variant="primary" className="mb-5" onClick={() => input.current?.click()} disabled={busy}>
        {busy ? <><Spinner />מעלה…</> : '+ העלאת תמונה חדשה'}
      </Button>
      {error && <p className="mb-4 text-sm text-[var(--danger)]">{error}</p>}
      {media.length ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(130px,1fr))]">
          {media.map((m) => (
            <button key={m.id} type="button" onClick={() => { onPick(m.id); onClose(); }}
              className={cx('overflow-hidden rounded-xl text-start ring-2 transition',
                m.id === selectedId ? 'ring-primary' : 'ring-transparent hover:ring-line')}>
              {m.kind === 'video'
                ? <video src={m.url} muted playsInline className="aspect-square w-full bg-black object-cover" />
                : <img src={m.url} alt="" className="aspect-square w-full object-cover" />}
              <p className="truncate bg-surface-2 px-2 py-1.5 text-xs">{m.name}</p>
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-2xl bg-surface-2 p-4 text-sm text-muted">הספרייה ריקה. העלו תמונה או צרו אחת במסך היצירה.</p>
      )}
    </Modal>
  );
}
