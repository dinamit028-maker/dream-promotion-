'use client';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { Button, Field, Input, Pill, Textarea } from '@/components/ui/primitives';
import { CloseButton, IntegrationDialog, Modal } from '@/components/ui/feedback';
import { Visual } from '@/components/ui/Visual';
import { ScheduleFields } from '@/features/calendar/ScheduleFields';
import { MediaPicker } from '@/features/media/MediaPicker';
import { KIND_HE, today } from '@/lib/utils';

/** One editor for every piece of content — opened from cards, calendar and strategy. */
export function ContentEditor() {
  const { editingId, closeEditor, content, updateContent, removeContent, duplicateContent } = useApp();
  const item = content.find((c) => c.id === editingId);
  const [headline, setHeadline] = useState('');
  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [cta, setCta] = useState('');
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState({ date: '', time: '19:30' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publishDialog, setPublishDialog] = useState(false);

  useEffect(() => {
    if (!item) return;
    setHeadline(item.headline);
    setCaption(item.caption);
    setHashtags((item.hashtags || []).join(' '));
    setCta(item.cta || '');
    setMediaId(item.mediaId);
    setWhen({ date: item.date ?? '', time: item.time ?? '19:30' });
    setConfirmDelete(false);
  }, [editingId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;

  const save = () => {
    updateContent(item.id, {
      headline, caption, cta, mediaId,
      hashtags: hashtags.split(/\s+/).filter(Boolean),
      date: when.date || null,
      time: when.date ? when.time : null,
      status: item.status === 'published' ? 'published' : when.date ? 'scheduled' : 'draft',
    });
    closeEditor();
  };

  const unschedule = () => {
    updateContent(item.id, { date: null, time: null, status: 'draft' });
    closeEditor();
  };

  return (
    <>
      <Modal open onClose={closeEditor} wide>
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex gap-2">
            <Pill tone="ai">{KIND_HE[item.kind]}</Pill>
            {item.status === 'scheduled' && <Pill tone="warn">מתוזמן</Pill>}
            {item.status === 'draft' && <Pill>טיוטה</Pill>}
            {item.status === 'published' && <Pill tone="ok">פורסם</Pill>}
          </div>
          <CloseButton onClick={closeEditor} />
        </div>

        <div className="grid items-start gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
          <div>
            <Visual kind={item.kind} headline={headline} palette={item.palette} mediaId={mediaId}
              ratio={item.kind === 'reel' || item.kind === 'story' ? 'vertical' : 'square'} className="max-md:mx-auto max-md:w-40" />
            <Button variant="ghost" size="sm" className="mt-3 w-full" onClick={() => setPicking(true)}>
              {mediaId ? 'החלפת תמונה' : 'הוספת תמונה'}
            </Button>
            {mediaId && (
              <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setMediaId(null)}>הסרת התמונה מהפוסט</Button>
            )}
          </div>
          <div>
            <Field label="טקסט על התמונה"><Input value={headline} onChange={(e) => setHeadline(e.target.value)} /></Field>
            <Field label="טקסט הפוסט"><Textarea className="min-h-36" value={caption} onChange={(e) => setCaption(e.target.value)} /></Field>
            <Field label="האשטגים"><Input value={hashtags} onChange={(e) => setHashtags(e.target.value)} /></Field>
            <Field label="קריאה לפעולה"><Input value={cta} onChange={(e) => setCta(e.target.value)} /></Field>
            <div className="my-5 h-px bg-line" />
            <ScheduleFields date={when.date} time={when.time} onChange={setWhen} />
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Button variant="primary" onClick={save}>{when.date ? 'שמירה ותזמון' : 'שמירה כטיוטה'}</Button>
          {item.date && <Button variant="ghost" onClick={unschedule}>הוצאה מהיומן</Button>}
          <Button variant="ghost" onClick={() => { duplicateContent(item.id); closeEditor(); }}>שכפול</Button>
          <Button variant="ghost" onClick={() => setPublishDialog(true)}>פרסום עכשיו</Button>
          {confirmDelete ? (
            <Button variant="ghost" className="text-[var(--danger)]" onClick={() => { removeContent(item.id); closeEditor(); }}>
              בטוח? מחיקה סופית
            </Button>
          ) : (
            <Button variant="ghost" className="text-[var(--danger)]" onClick={() => setConfirmDelete(true)}>מחיקה</Button>
          )}
        </div>
        {when.date && when.date < today() && (
          <p className="mt-3 text-sm text-warn">התאריך שבחרת כבר עבר.</p>
        )}
      </Modal>
      <MediaPicker open={picking} onClose={() => setPicking(false)} onPick={setMediaId} selectedId={mediaId} />
      <IntegrationDialog open={publishDialog} onClose={() => setPublishDialog(false)} provider={item.platform} what="פרסום" />
    </>
  );
}
