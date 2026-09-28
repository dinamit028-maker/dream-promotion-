'use client';
import { useRef } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import { AuthButton } from '@/features/auth/LandingAuth';
import { InstagramLogo, TiktokLogo, Megaphone, CalendarBlank, UsersThree, ChartBar, ImageGlyph, FilmSlate } from '@/components/ui/Icon';
import { DashboardMock } from './DashboardMock';

const MODULES = [
  { I: InstagramLogo, t: 'פוסטים', x: -380, y: -160 }, { I: FilmSlate, t: 'רילסים', x: 360, y: -190 },
  { I: Megaphone, t: 'קמפיינים', x: -420, y: 60 }, { I: CalendarBlank, t: 'יומן', x: 420, y: 40 },
  { I: UsersThree, t: 'לידים', x: -260, y: 220 }, { I: ChartBar, t: 'ביצועים', x: 280, y: 230 },
  { I: ImageGlyph, t: 'תמונות AI', x: -60, y: -250 }, { I: TiktokLogo, t: 'TikTok', x: 60, y: 270 },
];

/** The modules drift in from around the screen and settle into one dashboard. */
export function FinalScene() {
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.4 });
  const reduce = useReducedMotion();
  const gather = seen || reduce;

  return (
    <section ref={ref} className="relative overflow-hidden px-5 py-32">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[420px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#6B3BF5]/25 blur-[120px]" />
      <div className="relative mx-auto h-[300px] max-w-3xl sm:h-[420px]">
        {MODULES.map(({ I, t, x, y }, i) => (
          <motion.span key={t} aria-hidden
            initial={reduce ? false : { x, y, opacity: 1, scale: 1 }}
            animate={gather ? { x: 0, y: 0, opacity: 0, scale: 0.5 } : undefined}
            transition={{ duration: 1.1, delay: i * 0.06, ease: [0.22, 0.8, 0.3, 1] }}
            className="absolute left-1/2 top-1/2 z-10 -ml-12 -mt-5 hidden items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-2 text-sm sm:flex">
            <I size={15} />{t}
          </motion.span>
        ))}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2">
          <motion.div
            initial={reduce ? false : { opacity: 0, scale: 0.85 }}
            animate={gather ? { opacity: 1, scale: 1 } : undefined}
            transition={{ duration: 0.9, delay: reduce ? 0 : 0.8, ease: [0.22, 0.8, 0.3, 1] }}
          >
            <DashboardMock />
          </motion.div>
        </div>
      </div>

      <div className="relative mt-16 text-center">
        <h2 className="font-display text-4xl font-black leading-tight sm:text-6xl">מחלקת השיווק שלכם<br />כבר מוכנה.</h2>
        <p className="mx-auto mt-5 max-w-md text-lg text-ink-2">אתם מנהלים את העסק.<br />Dream Promotion מנהלת את השיווק.</p>
        <div className="relative mt-9 inline-flex">
          <span aria-hidden className="absolute -inset-4 animate-pulse rounded-full bg-[#8B66FF]/35 blur-2xl motion-reduce:animate-none" />
          <AuthButton mode="up" size="lg">התחילו בחינם</AuthButton>
        </div>
      </div>
    </section>
  );
}
