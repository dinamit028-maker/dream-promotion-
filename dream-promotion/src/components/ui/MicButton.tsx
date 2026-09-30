'use client';
import { useEffect, useRef, useState } from 'react';
import { TranscribeService } from '@/lib/services/transcribe.service';
import { cx } from '@/lib/utils';

/**
 * Talk instead of typing: records from the microphone, turns the speech into Hebrew text,
 * and hands it back (the field adds it to what is already written).
 */
export function MicButton({ onText, className, label = 'הקלטה' }: { onText: (text: string) => void; className?: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'recording' | 'working'>('idle');
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); rec.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('הדפדפן הזה לא תומך בהקלטה.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) clearInterval(timer.current);
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
        if (blob.size < 1500) { setState('idle'); setError('ההקלטה קצרה מדי.'); return; }
        setState('working');
        try {
          const text = (await TranscribeService.recording(blob)).trim();
          if (text) onText(text); else setError('לא נשמע דיבור בהקלטה.');
        } catch (e: any) {
          setError(e.code === 'no_fal_key' ? 'תמלול לא מוגדר (חסר FAL_KEY).' : 'התמלול נכשל. נסו שוב.');
        } finally { setState('idle'); }
      };
      rec.current = r;
      r.start(250);
      setSecs(0); setState('recording');
      timer.current = setInterval(() => setSecs((s) => {
        if (s + 1 >= 120) r.state === 'recording' && r.stop(); // two minutes at most
        return s + 1;
      }), 1000);
    } catch {
      setError('אין גישה למיקרופון. אשרו הרשאה בדפדפן.');
    }
  }
  const stop = () => { if (rec.current?.state === 'recording') rec.current.stop(); };

  return (
    <span className={cx('inline-flex flex-col', className)}>
      <button type="button" onClick={state === 'recording' ? stop : start} disabled={state === 'working'}
        aria-label={state === 'recording' ? 'עצירת ההקלטה' : 'הקלטה במקום הקלדה'}
        className={cx('inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-semibold transition-colors',
          state === 'recording' ? 'border-[var(--danger)] bg-[var(--danger)] text-white' : 'border-line hover:bg-surface-2')}>
        {state === 'recording' ? (
          <><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-white" />עצירה · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</>
        ) : state === 'working' ? (
          <><span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />מתמלל…</>
        ) : (
          <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" /></svg>{label}</>
        )}
      </button>
      {error && <span className="mt-1 text-xs text-warn">{error}</span>}
    </span>
  );
}
