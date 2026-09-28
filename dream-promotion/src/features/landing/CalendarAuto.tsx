'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import { InstagramLogo, FacebookLogo, TiktokLogo, Check, Sparkle } from '@/components/ui/Icon';

const DAYS = [
  { d: 'ראשון', item: 'פוסט', I: InstagramLogo, c: '#8B66FF' },
  { d: 'שני', item: 'סטורי', I: InstagramLogo, c: '#FF7FA8' },
  { d: 'שלישי', item: 'רילס', I: TiktokLogo, c: '#43D2AE' },
  { d: 'רביעי', item: 'פוסט חינוכי', I: FacebookLogo, c: '#5BA4FF' },
  { d: 'חמישי', item: 'מבצע', I: InstagramLogo, c: '#FFAE7C' },
];

export function CalendarAuto() {
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.45 });
  const reduce = useReducedMotion();
  const [filled, setFilled] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (reduce) { setFilled(DAYS.length); return; }
    let n = 0;
    const t = setInterval(() => { n += 1; setFilled(n); if (n >= DAYS.length) clearInterval(t); }, 520);
    return () => clearInterval(t);
  }, [seen, reduce]);

  const ready = filled >= DAYS.length;
  return (
    <section id="calendar" ref={ref} className="mx-auto max-w-6xl scroll-mt-20 px-5 py-28">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 className="font-display text-4xl font-black leading-tight sm:text-6xl">השבוע שלכם<br />כבר מתוכנן.</h2>
        <p className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold ${ready ? 'border-[#43D2AE]/40 text-ok' : 'border-line text-ink-2'}`} aria-live="polite">
          {ready ? <><Check size={16} weight="bold" aria-hidden />השבוע מוכן</> : <><Sparkle size={16} weight="fill" className="animate-pulse text-primary" aria-hidden />ה-AI בונה את השבוע שלכם…</>}
        </p>
      </div>

      <ol className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-5">
        {DAYS.map(({ d, item, I, c }, i) => (
          <li key={d} className="flex min-h-[64px] items-center gap-3 rounded-2xl border border-dashed border-line bg-surface-2 p-3 sm:min-h-[170px] sm:flex-col sm:items-stretch">
            <span className="w-14 shrink-0 text-sm text-muted sm:w-auto">{d}</span>
            {i < filled && (
              <motion.div
                initial={reduce ? false : { opacity: 0, y: -60, scale: 0.8, rotate: -6 }}
                animate={{ opacity: 1, y: 0, scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 220, damping: 17 }}
                className="flex flex-1 items-center justify-between rounded-xl p-3 text-[#0A0814] sm:flex-col sm:items-start sm:justify-end sm:gap-4"
                style={{ backgroundColor: c }}
              >
                <span className="font-display text-base font-bold">{item}</span>
                <I size={18} weight="bold" aria-label={I === TiktokLogo ? 'TikTok' : I === FacebookLogo ? 'Facebook' : 'Instagram'} />
              </motion.div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
