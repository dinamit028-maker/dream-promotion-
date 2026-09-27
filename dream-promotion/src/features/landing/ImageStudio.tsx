'use client';
import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { REELS } from './theme';

const SCENES = [
  { img: REELS[0].poster, t: 'בית קפה באירופה' },
  { img: REELS[1].poster, t: 'שדה תעופה' },
  { img: REELS[2].poster, t: 'מסלול המראה' },
  { img: REELS[3].poster, t: 'רחוב סואן' },
];

/** One brief, many worlds: a cover-flow of real frames. It advances by itself; tapping a frame brings it forward. */
export function ImageStudio() {
  const reduce = useReducedMotion();
  const [sel, setSel] = useState(1);
  const [hold, setHold] = useState(false);
  const [w, setW] = useState(230);
  useEffect(() => { setW(window.innerWidth < 640 ? 120 : 230); }, []);

  useEffect(() => {
    if (reduce || hold) return;
    const t = setInterval(() => setSel((v) => (v + 1) % SCENES.length), 3200);
    return () => clearInterval(t);
  }, [reduce, hold]);

  return (
    <section id="studio" className="scroll-mt-20 overflow-hidden py-28">
      <div className="mx-auto max-w-6xl px-5 text-center">
        <h2 className="font-display text-4xl font-black leading-tight sm:text-6xl">רעיון אחד.<br />עולם שלם של תוכן.</h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-white/65">
          אותו מסר, בכל מקום שתבחרו. אלה פריימים אמיתיים מסרטונים שנוצרו במערכת, מאותו תיאור של עסק.
        </p>
      </div>

      <div className="relative mx-auto mt-14 h-[380px] max-w-5xl [perspective:1400px] sm:h-[440px]"
        onPointerEnter={() => setHold(true)} onPointerLeave={() => setHold(false)}>
        {SCENES.map((s, i) => {
          let d = i - sel;
          if (d > 2) d -= SCENES.length;
          if (d < -1) d += SCENES.length;
          return (
            <div key={s.t} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ zIndex: 10 - Math.abs(d) }}>
              <motion.button
                type="button"
                onClick={() => setSel(i)}
                aria-pressed={d === 0}
                aria-label={`להציג: ${s.t}`}
                animate={{ x: -d * w, rotateY: d * 28, scale: 1 - Math.abs(d) * 0.14, opacity: Math.abs(d) > 1 ? 0.35 : 1 }}
                transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 90, damping: 18 }}
                className="relative block h-[300px] w-[170px] overflow-hidden rounded-[20px] border border-white/10 shadow-[0_30px_80px_rgba(0,0,0,.6)] sm:h-[400px] sm:w-[225px]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.img} alt="" className="h-full w-full object-cover" />
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 pt-10 text-right text-sm font-semibold">{s.t}</span>
              </motion.button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
