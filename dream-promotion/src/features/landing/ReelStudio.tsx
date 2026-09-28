'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from 'framer-motion';
import { ShowcaseVideo } from './ShowcaseVideo';
import { REELS } from './theme';

const SCENES = [
  { n: 'הוק', d: 'שלוש שניות שעוצרות את הגלילה', c: '#FF7FA8', x: 1, y: -1 },
  { n: 'בעיה', d: 'מה שהלקוח מרגיש עכשיו', c: '#FFAE7C', x: 1, y: 0 },
  { n: 'פתרון', d: 'איך העסק שלכם עוזר', c: '#43D2AE', x: 1, y: 1 },
  { n: 'הוכחה', d: 'תוצאה, לקוח, רגע אמיתי', c: '#5BA4FF', x: -1, y: -0.5 },
  { n: 'קריאה לפעולה', d: 'מה עושים עכשיו', c: '#B9A2FF', x: -1, y: 0.6 },
];

function Scene({ p, i, s, w }: { p: MotionValue<number>; i: number; s: typeof SCENES[number]; w: number }) {
  const start = 0.1 + i * 0.13;
  const range = [start, start + 0.14];
  const x = useTransform(p, range, [s.x * w, 0]);
  const y = useTransform(p, range, [s.y * 150, 0]);
  const scale = useTransform(p, range, [1, 0.3]);
  const opacity = useTransform(p, [range[0], range[1] - 0.02, range[1]], [1, 1, 0]);
  return (
    <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
    <motion.div style={{ x, y, scale, opacity }}
      className="w-[150px] rounded-2xl border border-line bg-surface p-3 text-right shadow-[0_20px_50px_rgba(0,0,0,.5)] sm:w-[190px]">
      <p className="text-[11px] font-bold" style={{ color: s.c }}>סצנה {i + 1}</p>
      <p className="font-display text-base font-bold sm:text-lg">{s.n}</p>
      <p className="mt-0.5 text-[12px] leading-snug text-muted">{s.d}</p>
    </motion.div>
    </div>
  );
}

function Segment({ p, i, c }: { p: MotionValue<number>; i: number; c: string }) {
  const start = 0.1 + i * 0.13;
  const scaleX = useTransform(p, [start, start + 0.14], [0, 1]);
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
      <motion.div style={{ scaleX, backgroundColor: c }} className="h-full origin-right rounded-full" />
    </div>
  );
}

export function ReelStudio() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress: p } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const phoneScale = useTransform(p, [0, 0.85, 1], [0.92, 1, 1.04]);
  const done = useTransform(p, [0.8, 0.9], [0, 1]);
  const [w, setW] = useState(300);
  useEffect(() => { setW(window.innerWidth < 640 ? 110 : 300); }, []);

  return (
    <section ref={ref} className={reduce ? 'py-28' : 'relative h-[280vh]'}>
      <div className={reduce ? 'px-5' : 'sticky top-0 flex h-[100svh] flex-col items-center justify-center overflow-hidden px-5'}>
        <h2 className="text-center font-display text-4xl font-black leading-tight sm:text-6xl">מסטוריבורד לרילס מוכן</h2>
        <p className="mt-3 text-center text-lg text-ink-2">חמש סצנות, טקסט למסך וקריינות. ה-AI מרכיב, אתם מאשרים.</p>

        <div className="relative mt-8 flex w-full max-w-4xl justify-center">
          {!reduce && SCENES.map((s, i) => <Scene key={s.n} p={p} i={i} s={s} w={w} />)}
          <motion.div style={reduce ? undefined : { scale: phoneScale }}
            className="relative w-[190px] rounded-[34px] border-[6px] border-[#2A2350] bg-black p-1 shadow-[0_40px_100px_rgba(107,59,245,.35)] sm:w-[230px]">
            <ShowcaseVideo {...REELS[2]} className="aspect-[9/16] rounded-[26px]" />
            <motion.span style={reduce ? undefined : { opacity: done }}
              className="absolute -bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#43D2AE] px-3 py-1 text-[12px] font-bold text-[#0A0814]">
              הרילס מוכן
            </motion.span>
          </motion.div>
        </div>

        <div className="mt-10 w-full max-w-md">
          <div className="flex gap-1.5" aria-hidden>
            {SCENES.map((s, i) => (reduce
              ? <div key={s.n} className="h-2 flex-1 rounded-full" style={{ backgroundColor: s.c }} />
              : <Segment key={s.n} p={p} i={i} c={s.c} />))}
          </div>
          <div className="mt-2 flex justify-between text-[11px] text-muted"><span>0:00</span><span dir="ltr">0:15</span></div>
        </div>
      </div>
    </section>
  );
}
