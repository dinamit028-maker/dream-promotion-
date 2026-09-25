'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { Button, Card, Chip, Field } from '@/components/ui/primitives';
import { AdapterNote, CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { MediaPicker } from '@/features/media/MediaPicker';
import { PlatformPreview } from '@/features/preview/PlatformPreview';
import type { ReelProject } from '@/types';

export interface RenderScenePayload {
  url: string; kind: 'video' | 'image'; seconds?: number; narrationUrl?: string;
  cues?: { start: number; end: number; text: string }[];
}

const STAGE_HE = { download: 'אוסף את הקליפים והקריינות…', render: 'מרכיב את הריל…', upload: 'שומר בספריית המדיה…' } as const;

/**
 * The last step of the reel studio: background music, caption style, and one button
 * that turns the scenes into a single finished 9:16 MP4 — stored, in the media
 * library, and linked to this reel.
 */
export function FinalReelPanel({
  projectId, title, caption, payload, ready, missingNarration, music, setMusic, captions, setCaptions, final, onRendered,
}: {
  projectId: string | null; title: string; caption: string;
  payload: RenderScenePayload[]; ready: boolean; missingNarration: number;
  music: ReelProject['music']; setMusic: (m: ReelProject['music']) => void;
  captions: ReelProject['captions']; setCaptions: (c: ReelProject['captions']) => void;
  final: ReelProject['final']; onRendered: (f: NonNullable<ReelProject['final']>) => void;
}) {
  const router = useRouter();
  const { media, addMedia, duplicateContent, openEditor, content } = useApp();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<{ stage: keyof typeof STAGE_HE; pct?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  async function render() {
    setBusy(true); setError(null); setStage({ stage: 'download', pct: 0 });
    try {
      if (!isCloudConfigured) throw new Error('יצירת הריל הסופי דורשת חשבון מחובר.');
      const { data } = await supabase().auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('צריך להתחבר מחדש.');
      const res = await fetch('/api/reel/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ contentId: projectId, title, scenes: payload, music: music ? { url: music.url, volume: music.volume } : null, captions }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `השרת החזיר ${res.status}`);
      }
      // progress arrives as JSON lines
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', result: any = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const l of lines) {
          if (!l.trim()) continue;
          const m = JSON.parse(l);
          if (m.error) throw new Error(m.error);
          if (m.done) result = m; else if (m.stage) setStage({ stage: m.stage, pct: m.pct });
        }
      }
      if (!result) throw new Error('הרינדור הסתיים בלי קובץ.');
      addMedia({ id: result.mediaId, url: result.url, name: `${title} · ריל סופי`, kind: 'video', persistent: true });
      onRendered({ mediaId: result.mediaId, url: result.url, durationSec: result.durationSec, renderedAt: Date.now() });
    } catch (e: any) {
      setError(e?.message ?? 'הרינדור נכשל.');
    } finally { setBusy(false); setStage(null); }
  }

  function duplicate() {
    if (!projectId) return;
    const before = new Set(content.map((c) => c.id));
    duplicateContent(projectId);
    const copy = useApp.getState().content.find((c) => !before.has(c.id));
    if (copy) router.push(`/reels?id=${copy.id}`);
  }

  const musicName = music ? (media.find((m) => m.id === music.mediaId)?.name ?? music.name) : null;

  return (
    <Card className="mt-4">
      <h3 className="font-display text-xl font-bold">הריל הסופי</h3>
      <p className="mt-1 text-sm text-muted">כל הסצנות, הקריינות, הכתוביות והמוזיקה — בקובץ MP4 אנכי אחד.</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="מוזיקת רקע">
          {music ? (
            <div className="rounded-2xl bg-surface-2 p-3">
              <p className="truncate text-sm font-semibold">♪ {musicName}</p>
              <audio src={music.url} controls className="mt-2 h-9 w-full" />
              <label className="mt-3 block text-sm">
                עוצמת המוזיקה: <strong>{Math.round(music.volume * 100)}%</strong>
                <input type="range" min={0} max={100} value={Math.round(music.volume * 100)}
                  onChange={(e) => setMusic({ ...music, volume: +e.target.value / 100 })}
                  className="mt-1 w-full accent-[var(--primary)]" />
              </label>
              <p className="mt-1 text-xs text-muted">המוזיקה יורדת אוטומטית כשהקריין מדבר.</p>
              <div className="mt-2 flex gap-3 text-sm">
                <button type="button" className="font-semibold text-primary" onClick={() => setPicking(true)}>החלפה</button>
                <button type="button" className="text-muted" onClick={() => setMusic(null)}>בלי מוזיקה</button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" className="w-full" onClick={() => setPicking(true)}>+ הוספת מוזיקה (MP3)</Button>
          )}
        </Field>

        <Field label="כתוביות">
          <div className="flex flex-wrap gap-2">
            <Chip on={captions.enabled} onClick={() => setCaptions({ ...captions, enabled: !captions.enabled })}>
              {captions.enabled ? 'כתוביות פעילות' : 'בלי כתוביות'}
            </Chip>
            {captions.enabled && (
              <>
                <Chip on={captions.position === 'bottom'} onClick={() => setCaptions({ ...captions, position: 'bottom' })}>למטה</Chip>
                <Chip on={captions.position === 'middle'} onClick={() => setCaptions({ ...captions, position: 'middle' })}>באמצע</Chip>
                <Chip on={captions.size === 'lg'} onClick={() => setCaptions({ ...captions, size: 'lg' })}>גדול</Chip>
                <Chip on={captions.size === 'md'} onClick={() => setCaptions({ ...captions, size: 'md' })}>רגיל</Chip>
              </>
            )}
          </div>
          <p className="mt-2 text-xs text-muted">הכתוביות מציגות את הטקסט כפי שנכתב (eSIM, Tasimli), גם כשהקריין הוגה אותו אחרת.</p>
        </Field>
      </div>

      {!ready && <p className="mt-4 text-sm text-warn">כדי ליצור את הריל הסופי, כל הסצנות צריכות קליפ או תמונה מוכנים.</p>}
      {ready && missingNarration > 0 && (
        <p className="mt-4 text-sm text-muted">ל-{missingNarration} סצנות אין קריינות — הן יופיעו בלי קול ובלי כתוביות.</p>
      )}

      <div className="mt-4 border-t border-line pt-4">
        <Button variant="primary" size="lg" onClick={render} disabled={!ready || busy}>
          {busy ? <><Spinner />מרנדר…</> : final ? 'יצירת הריל הסופי מחדש' : 'יצירת הריל הסופי'}
        </Button>
        {stage && (
          <div className="mt-3">
            <p className="text-sm">{STAGE_HE[stage.stage]} {stage.pct !== undefined && <strong>{stage.pct}%</strong>}</p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-primary transition-[width]"
                style={{ width: `${stage.stage === 'download' ? (stage.pct ?? 0) * 0.15 : stage.stage === 'render' ? 15 + (stage.pct ?? 0) * 0.8 : 97}%` }} />
            </div>
          </div>
        )}
        {error && <div className="mt-3"><AdapterNote title="הרינדור נכשל.">{error}</AdapterNote></div>}
      </div>

      {final && (
        <div className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-[220px_1fr]">
          <video key={final.url} src={final.url} controls playsInline className="aspect-[9/16] w-full rounded-xl bg-black object-cover" />
          <div>
            <p className="font-semibold">הריל מוכן · {Math.round(final.durationSec)} שנ׳</p>
            <p className="mt-1 text-sm text-muted">נשמר בספריית המדיה ומשויך לפרויקט הזה.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => setPreviewing(true)}>תצוגה לפי פלטפורמה</Button>
              <a href={final.url} download={`${title}.mp4`} target="_blank" rel="noreferrer"
                className="inline-flex h-9 items-center rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2">הורדה</a>
              <Button size="sm" variant="ghost" onClick={() => document.getElementById('reel-scenes')?.scrollIntoView({ behavior: 'smooth' })}>עריכה</Button>
              <Button size="sm" variant="ghost" onClick={duplicate} disabled={!projectId}>שכפול</Button>
              <Button size="sm" variant="ghost" onClick={() => projectId && openEditor(projectId)} disabled={!projectId}>תזמון</Button>
            </div>
          </div>
        </div>
      )}

      <MediaPicker open={picking} onClose={() => setPicking(false)} accept="audio"
        onPick={(id) => {
          const m = useApp.getState().media.find((x) => x.id === id);
          if (m) setMusic({ mediaId: m.id, url: m.url, name: m.name, volume: music?.volume ?? 0.25 });
        }} selectedId={music?.mediaId} />

      <Modal open={previewing} onClose={() => setPreviewing(false)} wide>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="font-display text-xl font-extrabold">כך הריל ייראה</h3>
          <CloseButton onClick={() => setPreviewing(false)} />
        </div>
        {final && <PlatformPreview mediaId={final.mediaId} headline="" caption={caption} initial="ig-reel" />}
      </Modal>
    </Card>
  );
}
