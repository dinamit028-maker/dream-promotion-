'use client';
import { useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { MediaService } from '@/lib/services';
import { Button, PageHead } from '@/components/ui/primitives';
import { AdapterNote, EmptyState } from '@/components/ui/feedback';
import { Images } from '@/components/ui/Icon';

export default function MediaPage() {
  const { media, addMedia, removeMedia } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    setBusy(true); setError(null);
    for (const f of Array.from(files)) {
      try { addMedia(await MediaService.upload(f)); }
      catch { setError(`העלאת "${f.name}" נכשלה. נסו שוב.`); }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  }

  return (
    <>
      <PageHead title="ספריית המדיה" sub={`${media.length} קבצים`}
        action={<Button variant="primary" onClick={() => input.current?.click()} disabled={busy}>{busy ? 'מעלה…' : '+ העלאה'}</Button>} />
      <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      {!MediaService.persistent && (
        <div className="mb-6">
          <AdapterNote>
            אחסון קבצים מתמיד לא מוגדר, לכן הקבצים חיים בדפדפן עד רענון.
            <code> MediaService </code> מוכן להחלפה ב-S3 / Supabase Storage / Cloudinary.
          </AdapterNote>
        </div>
      )}
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {media.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
          {media.map((m) => (
            <div key={m.id} className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
              {m.kind === 'video'
                ? <video src={m.url} muted playsInline controls className="aspect-square w-full bg-black object-cover" />
                : <img src={m.url} alt="" className="aspect-square w-full object-cover" />}
              <div className="p-2.5">
                <p className="truncate text-sm">{m.name}</p>
                <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={() => removeMedia(m.id)}>הסרה</Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={<Images />} title="אין מדיה עדיין" body="העלו כמה תמונות ונהפוך אותן לתוכן."
          action={<Button variant="primary" onClick={() => input.current?.click()}>העלאת קבצים</Button>} />
      )}
    </>
  );
}
