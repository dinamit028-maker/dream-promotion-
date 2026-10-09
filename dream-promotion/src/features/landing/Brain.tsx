'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from 'framer-motion';

const INPUTS = ['קהל יעד', 'שפה', 'צבעי מותג', 'שירותים', 'מוצרים', 'סגנון כתיבה', 'מטרות', 'תוכן קודם', 'ביצועים'];
const OUTPUTS = ['פוסט', 'רילס', 'סטורי', 'קמפיין', 'תוכנית תוכן'];

/** One chip travelling between its resting place and the core. */
function Node({ p, from, to, label, range, tone }: {
  p: MotionValue<number>; from: [number, number]; to: [number, number]; label: string; range: [number, number]; tone: string;
}) {
  const x = useTransform(p, range, [from[0], to[0]]);
  const y = useTransform(p, range, [from[1], to[1]]);
  const opacity = useTransform(p, [range[0], range[0] + 0.02, range[1] - 0.03, range[1]], tone === 'in' ? [1, 1, 1, 0] : [0, 1, 1, 1]);
  const scale = useTransform(p, range, tone === 'in' ? [1, 0.4] : [0.4, 1]);
  return (
    <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
    <motion.span
      style={{ x, y, opacity, scale }}
      className={`block whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold sm:text-[15px] ${
        tone === 'in' ? 'border border-line bg-surface-2 text-ink' : 'bg-[#8B66FF] text-white shadow-[0_8px_30px_rgba(139,102,255,.5)]'}`}
    >
      {label}
    </motion.span>
    </span>
  );
}

export function Brain() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress: p } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const glow = useTransform(p, [0, 0.45, 0.55, 1], [0.6, 1.25, 1.25, 0.9]);
  const stage = useTransform(p, [0, 0.5, 0.52, 1], [0, 0, 1, 1]);
  const inOpacity = useTransform(stage, [0, 1], [1, 0.35]);
  const outOpacity = useTransform(stage, [0, 1], [0.35, 1]);

  // inputs rest in an arc on the right (the start side in RTL), outputs land on the left
  const [w, setW] = useState(1200);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    on(); window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  return (
    <section id="brain" ref={ref} className="relative h-[260vh] scroll-mt-10">
      <div className="sticky top-0 flex h-svh flex-col items-center justify-center overflow-hidden px-5">
        <h2 className="text-center font-display text-4xl font-black leading-tight sm:text-6xl">ה-AI שמכיר את העסק שלכם</h2>
        <p className="mt-4 flex items-center gap-3 text-lg text-muted">
          <motion.span style={{ opacity: inOpacity }}>העסק</motion.span><span aria-hidden>←</span>
          <span className="text-primary">AI</span><span aria-hidden>←</span>
          <motion.span style={{ opacity: outOpacity }}>שיווק</motion.span>
        </p>

        <div className="relative mt-8 h-[440px] w-full max-w-5xl sm:h-[480px]">
          {/* the core: a sphere of light, not a literal brain */}
          <motion.div
            aria-hidden
            style={{ scale: reduce ? 1 : glow }}
            className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full sm:h-52 sm:w-52"
          >
            <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_40%_35%,#E5DBFF_0%,#8B66FF_35%,#3A1F9E_70%,transparent_72%)] blur-[1px]" />
            <div className="absolute -inset-10 rounded-full bg-[#8B66FF]/30 blur-3xl" />
            <div className="absolute inset-3 animate-[spin_18s_linear_infinite] rounded-full border border-dashed border-line motion-reduce:animate-none" />
          </motion.div>

          {reduce ? (
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-center gap-2">
              {OUTPUTS.map((o) => <span key={o} className="rounded-full bg-[#8B66FF] px-3.5 py-1.5 text-sm font-semibold">{o}</span>)}
            </div>
          ) : (
            <>
              {INPUTS.map((t, i) => (
                <Node key={t} p={p} label={t} tone="in" from={[ringX(i, INPUTS.length, 1, w), ringY(i, INPUTS.length, w)]}
                  to={[0, 0]} range={[0.05 + i * 0.035, 0.42 + i * 0.012]} />
              ))}
              {OUTPUTS.map((t, i) => (
                <Node key={t} p={p} label={t} tone="out" from={[0, 0]} to={[ringX(i, OUTPUTS.length, -1, w), ringY(i, OUTPUTS.length, w)]}
                  range={[0.55 + i * 0.05, 0.8 + i * 0.03]} />
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Resting positions on an arc; side 1 = right half, -1 = left half. Tighter on phones. */
function ringX(i: number, n: number, side: 1 | -1, w: number) {
  const r = w < 640 ? 110 : 320;
  const a = (-60 + (120 / Math.max(n - 1, 1)) * i) * (Math.PI / 180);
  return side * (Math.cos(a) * r + (w < 640 ? 30 : 60));
}
function ringY(i: number, n: number, w: number) {
  const r = w < 640 ? 185 : 200;
  const a = (-60 + (120 / Math.max(n - 1, 1)) * i) * (Math.PI / 180);
  return Math.sin(a) * r;
}
