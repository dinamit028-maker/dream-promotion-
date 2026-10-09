'use client';
import { useEffect, useRef, useState } from 'react';
import { LayoutGroup, motion, useInView, useReducedMotion } from 'framer-motion';
import { InstagramLogo, FacebookLogo, WhatsappLogo, Globe } from '@/components/ui/Icon';

const STAGES = ['ליד חדש', 'נוצר קשר', 'מתעניין', 'פגישה', 'לקוח'];
const LEADS = [
  { id: 'a', n: 'מיכל', I: WhatsappLogo, src: 'וואטסאפ' },
  { id: 'b', n: 'רון', I: InstagramLogo, src: 'אינסטגרם' },
  { id: 'c', n: 'דנה', I: FacebookLogo, src: 'פייסבוק' },
  { id: 'd', n: 'עומר', I: Globe, src: 'אתר' },
];
// each lead's stage over time: a living pipeline, looping
const TIMELINE = [[0, 0, 0, 0], [1, 0, 0, 0], [2, 1, 0, 0], [3, 2, 1, 0], [4, 2, 2, 1], [4, 3, 2, 1], [4, 4, 3, 2]];

export function Leads() {
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(reduce ? TIMELINE.length - 1 : 0);

  useEffect(() => {
    if (!seen || reduce) return;
    const t = setInterval(() => setTick((v) => (v + 1) % TIMELINE.length), 1500);
    return () => clearInterval(t);
  }, [seen, reduce]);

  const at = TIMELINE[tick];
  return (
    <section ref={ref} className="mx-auto max-w-6xl px-5 py-28">
      <h2 className="max-w-2xl font-display text-4xl font-black leading-tight sm:text-6xl">כל פנייה.<br />עד שהיא הופכת ללקוח.</h2>
      <p className="mt-4 max-w-xl text-lg text-ink-2">לידים מאינסטגרם, פייסבוק, וואטסאפ והאתר נכנסים ללוח אחד, וכל אחד מתקדם בשלבים.</p>

      <LayoutGroup>
        <div className="scrollbar-thin mt-12 flex gap-3 overflow-x-auto pb-2">
          {STAGES.map((stage, si) => (
            <div key={stage} className={`min-w-[150px] flex-1 rounded-2xl border p-3 ${si === 4 ? 'border-[#43D2AE]/30 bg-[#43D2AE]/5' : 'border-line bg-surface-2'}`}>
              <p className={`mb-3 text-sm font-semibold ${si === 4 ? 'text-ok' : 'text-muted'}`}>{stage}</p>
              <div className="min-h-[180px] stack-y-2">
                {LEADS.map((l, li) => at[li] === si && (
                  <motion.div key={l.id} layoutId={reduce ? undefined : l.id} transition={{ type: 'spring', stiffness: 200, damping: 24 }}
                    className="rounded-xl border border-line bg-surface p-2.5">
                    <p className="font-semibold">{l.n}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-[12px] text-muted"><l.I size={13} aria-hidden />{l.src}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </LayoutGroup>
    </section>
  );
}
