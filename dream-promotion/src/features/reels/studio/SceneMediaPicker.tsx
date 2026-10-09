'use client';
import { useRef, useState } from 'react';
import { Button, Chip } from '@/components/ui/primitives';
import { CloseButton, Modal } from '@/components/ui/feedback';
import { UploadSimple } from '@/components/ui/Icon';
import { cx } from '@/lib/utils';
import type { MediaAsset } from '@/types';

/**
 * A scene's picture or video from the library, or uploaded from here (2.75 — moved out of app/(app)/reels/page.tsx as it
 * was): a video becomes the scene's clip as it is; a picture, the first frame of the clip that will be made.
 */
export function SceneMediaPicker({ picking, media, photoId, clipUrl, onClose, onVideo, onPhoto, onFiles }: {
  picking: number | null; media: MediaAsset[]; photoId: string | null | undefined; clipUrl: string | undefined;
  onClose: () => void; onVideo: (url: string) => void; onPhoto: (id: string | null) => void; onFiles: (files: FileList | null) => void;
}) {
  const [pickTab, setPickTab] = useState<'image' | 'video'>('image');
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <Modal open={picking !== null} onClose={onClose} wide>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-display text-xl font-bold">מדיה לקליפ {(picking ?? 0) + 1}</h3>
        <CloseButton onClick={onClose} />
      </div>
      <div className="mb-4 flex gap-2">
        <Chip on={pickTab === 'image'} onClick={() => setPickTab('image')}>
          תמונות ({media.filter((m) => m.kind === 'image').length})
        </Chip>
        <Chip on={pickTab === 'video'} onClick={() => setPickTab('video')}>
          סרטונים ({media.filter((m) => m.kind === 'video').length})
        </Chip>
      </div>
      <input ref={fileInput} type="file" accept={pickTab === 'video' ? 'video/*' : 'image/*'} hidden onChange={(e) => onFiles(e.target.files)} />
      <Button variant="ghost" className="mb-4 w-full" onClick={() => fileInput.current?.click()}>
        <UploadSimple size={18} aria-hidden />{pickTab === 'video' ? 'העלאת סרטון מהמחשב' : 'העלאת תמונה מהמחשב'}
      </Button>
      <p className="mb-3 text-xs text-muted">
        {pickTab === 'video'
          ? 'סרטון שנבחר ישובץ כקליפ של הסצנה כמו שהוא — בלי לייצר מחדש ובלי עלות.'
          : 'תמונה שנבחרה תשמש כפריים הפתיחה של הקליפ שייווצר.'}
      </p>
      {media.filter((m) => m.kind === pickTab).length ? (
        <div className="grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
          {media.filter((m) => m.kind === pickTab).map((m) => (
            <button key={m.id} type="button"
              onClick={() => (pickTab === 'video' ? onVideo(m.url) : onPhoto(m.id))}
              className={cx('overflow-hidden rounded-xl text-start ring-2 ring-offset-2 ring-offset-surface',
                (pickTab === 'image' ? photoId === m.id : clipUrl === m.url) ? 'ring-primary' : 'ring-transparent hover:ring-line')}>
              {m.kind === 'video'
                ? <video src={`${m.url}#t=1`} preload="metadata" muted playsInline className="aspect-[9/16] w-full bg-black object-cover" />
                : <img src={m.url} alt={m.name} className="aspect-square w-full object-cover" />}
              <p className="truncate bg-surface-2 px-2 py-1 text-[11px]" title={m.name}>{m.name}</p>
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-2xl bg-surface-2 p-4 text-sm text-muted">
          {pickTab === 'video' ? 'אין עדיין סרטונים בספרייה.' : 'אין עדיין תמונות בספרייה. העלו אחת מכאן, או השאירו בלי תמונה והמנוע ייצר את הסצנה מאפס.'}
        </p>
      )}
      {picking !== null && photoId && pickTab === 'image' && (
        <Button variant="ghost" className="mt-4 w-full"
          onClick={() => onPhoto(null)}>
          בלי תמונה — לייצר מטקסט בלבד
        </Button>
      )}
    </Modal>
  );
}
