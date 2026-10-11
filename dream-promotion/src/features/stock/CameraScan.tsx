'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/feedback';

/**
 * "📷 סריקה" — a barcode read by the phone's camera, where the browser can (BarcodeDetector: Chrome on Android, and others).
 * Where it can not, there is no button: a barcode scanner that types (USB / Bluetooth) works in the field next to it anyway.
 */
export function CameraScan({ onCode }: { onCode: (code: string) => void }) {
  const [can, setCan] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { setCan(typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia)); }, []);
  if (!can) return null;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>📷 סריקה</Button>
      {open && <CameraModal onClose={() => setOpen(false)} onCode={(c) => { setOpen(false); onCode(c); }} />}
    </>
  );
}

function CameraModal({ onClose, onCode }: { onClose: () => void; onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const found = useRef(onCode);
  useEffect(() => { found.current = onCode; });
  useEffect(() => {
    let stream: MediaStream | null = null, stop = false, timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const Detector = (window as any).BarcodeDetector;
        const supported: string[] = await Detector.getSupportedFormats?.() ?? [];
        const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'].filter((f) => !supported.length || supported.includes(f));
        const detector = new Detector({ formats: want });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stop || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const tick = async () => {
          if (stop || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            const code = codes?.[0]?.rawValue;
            if (code) { found.current(String(code)); return; }
          } catch { /* a frame that could not be read: the next one */ }
          timer = setTimeout(tick, 250);
        };
        void tick();
      } catch { setErr('אין גישה למצלמה. אפשר להקליד את הברקוד בשדה.'); }
    })();
    return () => { stop = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-3 font-display text-xl font-extrabold">סריקת ברקוד</h3>
      {err ? <p role="alert" className="mb-3 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>
        : <video ref={video} muted playsInline className="mb-3 aspect-[4/3] w-full rounded-2xl bg-black object-cover" />}
      <Button variant="ghost" onClick={onClose}>סגירה</Button>
    </Modal>
  );
}
