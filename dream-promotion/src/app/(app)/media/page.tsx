'use client';
import { useRef } from 'react';
import { useApp } from '@/lib/store';
import { MediaService } from '@/lib/services';
import { Button, PageHead } from '@/components/ui/primitives';
import { AdapterNote, EmptyState } from '@/components/ui/feedback';

export default function MediaPage() {
  const { media, addMedia, removeMedia } = useApp();
  const input = useRef<HTMLInputElement>(null);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      try { addMedia(await MediaService.upload(f)); } catch { /* surfaced by the UI below */ }
    }
  }

  return (
    <>
      <PageHead title="ספריית המדיה" sub={`${media.length} קבצים`}
        action={<Button variant="primary" onClick={() => input.current?.click()}>+ העלאה</Button>} />
      <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      {!MediaService.persistent && (
        <div className="mb-6">
          <AdapterNote>
            אחסון קבצים מתמיד לא מוגדר, לכן הקבצים חיים בדפדפן עד רענון.
            <code> MediaService </code> מוכן להחלפה ב-S3 / Supabase Storage / Cloudinary.
          </AdapterNote>
        </div>
      )}
      {media.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
          {media.map((m) => (
            <div key={m.id} className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
              <img src={m.url} alt="" className="aspect-square w-full object-cover" />
              <div className="p-2.5">
                <p className="truncate text-sm">{m.name}</p>
                <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={() => removeMedia(m.id)}>הסרה</Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState emoji="⬚" title="אין מדיה עדיין" body="העלו כמה תמונות ונהפוך אותן לתוכן."
          action={<Button variant="primary" onClick={() => input.current?.click()}>העלאת קבצים</Button>} />
      )}
    </>
  );
}
