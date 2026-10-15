'use client';
import { useEffect, useRef, useState } from 'react';
import { cameraProblem, phoneKind, siteFromScan, type CameraProblem } from './clock-app';

/**
 * The camera inside the clock page: reads the business's QR and hands back its code, so the employee never leaves
 * the clock — the phone's own camera opens Safari, and on iPhone a home-screen app has its own storage.
 * BarcodeDetector where the browser has one (Android Chrome), jsQR everywhere else (iPhone) and as a fallback.
 * Frames are read in the browser and dropped: nothing is recorded or sent.
 */
type Read = (video: HTMLVideoElement) => Promise<string[]>;

/** the square in the middle of the picture (where the frame on screen is), at most 720 px for a fast decode */
function middleSquare(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  const w = video.videoWidth, h = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!w || !h || !ctx) return null;
  const side = Math.min(w, h), size = Math.min(side, 720);
  canvas.width = size; canvas.height = size;
  ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

async function makeReader(): Promise<Read> {
  const canvas = document.createElement('canvas');
  let jsqr: typeof import('jsqr').default | null = null;
  const loadJsQr = async () => (jsqr ??= (await import('jsqr')).default);
  const withJsQr: Read = async (video) => {
    const decode = await loadJsQr();
    const img = middleSquare(video, canvas);
    const code = img && decode(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return code ? [code.data] : [];
  };
  const Detector = (globalThis as { BarcodeDetector?: any }).BarcodeDetector;
  let detector: { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } | null = null;
  try { if (Detector && (await Detector.getSupportedFormats()).includes('qr_code')) detector = new Detector({ formats: ['qr_code'] }); }
  catch { /* no usable detector */ }
  if (!detector) { await loadJsQr(); return withJsQr; }   // loaded now, so a failed download shows as a problem, not a camera that never reads
  const started = Date.now();
  let n = 0;
  return async (video) => {
    // a detector that never finds anything (some phones without Google services) — jsQR gets every other frame after 3 seconds
    if (detector && !(Date.now() - started > 3000 && ++n % 2 === 0)) {
      try { return (await detector.detect(video)).map((b) => b.rawValue); }
      catch { detector = null; }   // it does not work on this phone: jsQR from now on
    }
    return withJsQr(video);
  };
}

export function QrScanner({ onCode, onClose }: { onCode: (site: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const done = useRef(onCode);
  const close = useRef(onClose);
  useEffect(() => { done.current = onCode; close.current = onClose; });
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const [wrong, setWrong] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
    // the app went to the background: iPhone cuts the camera anyway — close, and "סריקה" opens it again
    const hidden = () => { if (document.visibilityState === 'hidden') { stop(); close.current(); } };
    document.addEventListener('visibilitychange', hidden);
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setProblem('unsupported'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      } catch (e) { if (!stopped) setProblem(cameraProblem(e)); return; }
      if (stopped || !video.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      const v = video.current;
      v.srcObject = stream;
      await v.play().catch(() => { /* autoplay + muted + playsInline: plays on every phone; the frames are read anyway */ });
      let read: Read;
      try { read = await makeReader(); } catch { if (!stopped) { stop(); setProblem('failed'); } return; }
      const tick = async () => {
        if (stopped) return;
        const found = await read(v).catch(() => [] as string[]);
        if (stopped) return;
        const site = found.map(siteFromScan).find(Boolean);
        if (site) { stop(); done.current(site); return; }
        if (found.length) setWrong(true);
        timer = setTimeout(tick, 120);
      };
      void tick();
    })();
    return () => { stop(); document.removeEventListener('visibilitychange', hidden); };
  }, [attempt]);

  return (
    <div role="dialog" aria-modal="true" aria-label="סריקת קוד ה-QR של העסק" className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      {problem ? <CameraHelp problem={problem} onRetry={() => { setProblem(null); setWrong(false); setAttempt((a) => a + 1); }} /> : (
        <>
          <video ref={video} playsInline muted autoPlay className="absolute inset-0 h-full w-full object-cover" />
          <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="aspect-square w-[70vmin] max-w-80 rounded-3xl border-4 border-white/90 shadow-[0_0_0_100vmax_rgba(0,0,0,.45)]" />
          </div>
          <div className="relative px-6 pt-[max(env(safe-area-inset-top),1.5rem)] text-center">
            <p className="text-lg font-bold">מכוונים את המצלמה לקוד שתלוי בעסק</p>
            {wrong && <p role="status" className="mt-3 rounded-2xl bg-amber-400 p-2 text-sm font-semibold text-black">זה לא הקוד של השעון. סרקו את הקוד שתלוי בעסק.</p>}
          </div>
        </>
      )}
      <div className="relative mt-auto px-6 pb-[max(env(safe-area-inset-bottom),1.5rem)] pt-4">
        <button type="button" onClick={onClose} className="min-h-12 w-full rounded-full bg-white/20 text-lg font-bold">סגירה</button>
      </div>
    </div>
  );
}

/** the camera did not open: what happened, and how to allow it on this phone */
function CameraHelp({ problem, onRetry }: { problem: CameraProblem; onRetry: () => void }) {
  const kind = typeof navigator === 'undefined' ? 'other' : phoneKind(navigator.userAgent, navigator.maxTouchPoints);
  return (
    <div className="relative overflow-y-auto px-6 pt-[max(env(safe-area-inset-top),2rem)]">
      <p className="text-center text-5xl" aria-hidden>📷</p>
      {problem === 'denied' ? (
        <>
          <h2 className="mt-3 text-center text-xl font-bold">אין הרשאה למצלמה</h2>
          <p className="mt-2 text-center text-sm text-white/80">כדי לסרוק את הקוד בתוך השעון, צריך לאשר לו להשתמש במצלמה:</p>
          {kind !== 'android' && (
            <ol className="mt-4 list-decimal stack-y-2 rounded-2xl bg-white/10 p-4 ps-8 text-sm">
              <li><strong>באייפון:</strong> פותחים את <strong>הגדרות</strong> ← <strong>Safari</strong> (באייפון חדש: הגדרות ← אפליקציות ← Safari) ← <strong>מצלמה</strong> ← בוחרים <strong>&quot;שאל&quot;</strong> או <strong>&quot;אפשר&quot;</strong>.</li>
              <li>אם השעון פתוח ב-Safari: אפשר גם ללחוץ על <strong>aA</strong> בשורת הכתובת ← <strong>הגדרות אתר</strong> ← <strong>מצלמה</strong> ← <strong>אפשר</strong>.</li>
              <li>חוזרים לשעון ולוחצים <strong>&quot;לנסות שוב&quot;</strong>. אם השעון נפתח מהאייקון במסך הבית ועדיין אין מצלמה — סוגרים אותו לגמרי ופותחים שוב מהאייקון.</li>
            </ol>
          )}
          {kind !== 'iphone' && (
            <ol className="mt-4 list-decimal stack-y-2 rounded-2xl bg-white/10 p-4 ps-8 text-sm">
              <li><strong>באנדרואיד (Chrome):</strong> לוחצים על הסמל שליד הכתובת למעלה ← <strong>הרשאות</strong> ← <strong>מצלמה</strong> ← <strong>אפשר</strong>.</li>
              <li>אם השעון נפתח מאייקון במסך הבית: לחיצה ארוכה על האייקון ← <strong>פרטי האפליקציה</strong> ← <strong>הרשאות</strong> ← <strong>מצלמה</strong> ← <strong>אפשר</strong>.</li>
              <li>חוזרים לשעון ולוחצים <strong>&quot;לנסות שוב&quot;</strong>.</li>
            </ol>
          )}
        </>
      ) : (
        <>
          <h2 className="mt-3 text-center text-xl font-bold">
            {problem === 'no_camera' ? 'לא נמצאה מצלמה במכשיר הזה' : problem === 'busy' ? 'המצלמה תפוסה' : problem === 'unsupported' ? 'הדפדפן הזה לא פותח מצלמה בתוך הדף' : 'המצלמה לא נפתחה'}
          </h2>
          <p className="mt-2 text-center text-sm text-white/80">
            {problem === 'busy' ? 'אפליקציה אחרת משתמשת במצלמה עכשיו. סוגרים אותה ולוחצים "לנסות שוב".'
              : problem === 'unsupported' ? 'פותחים את הקישור האישי ב-Safari (באייפון) או ב-Chrome (באנדרואיד).'
              : 'לוחצים "לנסות שוב". אם זה חוזר — סוגרים את השעון ופותחים אותו שוב.'}
          </p>
        </>
      )}
      <p className="mt-4 text-center text-xs text-white/70">אפשר גם לסרוק את הקוד עם אפליקציית המצלמה של הטלפון ולפתוח את הקישור שמופיע.</p>
      {problem !== 'unsupported' && problem !== 'no_camera' && (
        <button type="button" onClick={onRetry} className="mt-5 min-h-12 w-full rounded-full bg-white text-lg font-bold text-black">לנסות שוב</button>
      )}
    </div>
  );
}
