'use client';
import { useEffect, useRef, useState } from 'react';
import { Play } from '@/components/ui/Icon';

/**
 * A real reel made in the app. Plays muted and looped while on screen, pauses when
 * scrolled away (saves battery on phones). Visitors who ask for reduced motion see the
 * poster and start it themselves.
 */
export function ShowcaseVideo({ src, poster, label, className = '' }: {
  src: string; poster: string; label: string; className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [reduced, setReduced] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReduced(still);
    if (still) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) v.play().catch(() => {});
      else v.pause();
    }, { threshold: 0.25 });
    io.observe(v);
    return () => io.disconnect();
  }, []);

  const start = () => { ref.current?.play().catch(() => {}); };

  return (
    <div className={`relative overflow-hidden bg-[#2A2150] ${className}`}>
      <video
        ref={ref}
        src={src}
        poster={poster}
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={label}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        className="block h-full w-full object-cover"
      />
      {reduced && !playing && (
        <button
          type="button"
          onClick={start}
          aria-label={`הפעלת הסרטון: ${label}`}
          className="absolute inset-0 flex items-center justify-center bg-black/20"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 text-[#1B1438]">
            <Play size={22} weight="fill" aria-hidden />
          </span>
        </button>
      )}
    </div>
  );
}
