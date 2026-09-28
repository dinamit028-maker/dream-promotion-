'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { motion, useMotionValue, useReducedMotion, useScroll, useSpring, useTransform, type MotionValue } from 'framer-motion';
import { AuthButton } from '@/features/auth/LandingAuth';
import { Button } from '@/components/ui/primitives';
import { Sparkle, InstagramLogo, TiktokLogo, Megaphone, WhatsappLogo, ChartBar, CalendarBlank, ImageGlyph } from '@/components/ui/Icon';
import { DashboardMock } from './DashboardMock';
import { ShowcaseVideo } from './ShowcaseVideo';
import { REELS } from './theme';

/** A card floating in the scene. `depth` sets how strongly it follows the mouse (closer = more). */
function Orbit({ mx, my, depth, className, delay = 0, children }: {
  mx: MotionValue<number>; my: MotionValue<number>; depth: number; className: string; delay?: number; children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const x = useTransform(mx, (v) => v * depth * 40);
  const y = useTransform(my, (v) => v * depth * 28);
  return (
    <motion.div style={{ x, y }} className={`absolute z-20 ${className}`}>
      <motion.div
        animate={reduce ? undefined : { y: [0, -12, 0] }}
        transition={{ duration: 6 + delay, repeat: Infinity, ease: 'easeInOut', delay }}
        className="rounded-2xl border border-line bg-[color:var(--glass)] p-3 text-right text-ink shadow-[0_24px_60px_rgba(0,0,0,.55)] backdrop-blur"
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const mx = useSpring(useMotionValue(0), { stiffness: 60, damping: 20 });
  const my = useSpring(useMotionValue(0), { stiffness: 60, damping: 20 });

  useEffect(() => {
    if (reduce) return;
    const onMove = (e: PointerEvent) => {
      mx.set((e.clientX / window.innerWidth - 0.5) * 2);
      my.set((e.clientY / window.innerHeight - 0.5) * 2);
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [mx, my, reduce]);

  // scrolling "moves the camera": the tilted dashboard straightens and comes toward the viewer
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const tilt = useTransform(scrollYProgress, [0, 0.6], [22, 0]);
  const lift = useTransform(scrollYProgress, [0, 0.6], [0, -60]);
  const zoom = useTransform(scrollYProgress, [0, 0.6], [0.92, 1.06]);
  const turnX = useTransform(my, (v) => v * -4);
  const turnY = useTransform(mx, (v) => v * 6);
  const rotateX = useTransform([tilt, turnX] as MotionValue<number>[], ([a, b]: number[]) => a + b);

  return (
    <section ref={ref} className="relative overflow-hidden pb-32 pt-12 sm:pt-16">
      {/* one soft light source behind the scene, not a decorative wash */}
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-[38%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-[#6B3BF5]/25 blur-[120px]" />

      <div className="relative mx-auto max-w-4xl px-5 text-center">
        <h1 className="font-display text-[46px] font-black leading-[.98] tracking-tight sm:text-[80px] lg:text-[92px]">
          השיווק שלך.<br />רץ מעצמו.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-ink-2 sm:text-xl">
          תארו את העסק פעם אחת.<br />מכאן ה-AI כבר יודע מה לעשות.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <AuthButton mode="up" size="lg"><Sparkle size={20} weight="fill" aria-hidden />נסו עכשיו בחינם</AuthButton>
          <a href="#brain"><Button variant="ghost" size="lg">ראו איך זה עובד</Button></a>
        </div>
      </div>

      <div className="relative mx-auto mt-14 max-w-6xl px-5 [perspective:1600px]">
        <motion.div
          style={reduce ? undefined : { rotateX, rotateY: turnY, y: lift, scale: zoom }}
          className="relative mx-auto max-w-[680px] [transform-style:preserve-3d]"
        >
          <DashboardMock />
        </motion.div>

        {/* content orbiting the dashboard; fewer cards on phones */}
        <Orbit mx={mx} my={my} depth={1.2} className="-right-2 top-[-10%] w-[112px] sm:right-[1%] sm:top-[-4%] sm:w-[150px]" delay={0}>
          <p className="mb-2 flex items-center gap-1 text-[11px] text-muted"><TiktokLogo size={12} />רילס</p>
          <ShowcaseVideo {...REELS[1]} className="aspect-[9/16] rounded-xl" />
        </Orbit>
        <Orbit mx={mx} my={my} depth={0.8} className="-left-2 top-[62%] w-[124px] sm:left-[1%] sm:top-[-2%] sm:w-[170px]" delay={1}>
          <p className="mb-2 flex items-center gap-1 text-[11px] text-muted"><InstagramLogo size={12} />פוסט</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={REELS[0].poster} alt="" className="aspect-square w-full rounded-xl object-cover" />
          <p className="mt-2 text-[11px] leading-snug text-ink">קפה, שמש ואינטרנט שעובד מהרגע הראשון.</p>
        </Orbit>
        <Orbit mx={mx} my={my} depth={0.5} className="bottom-[-14%] right-[20%] hidden w-[190px] sm:block" delay={2}>
          <p className="flex items-center gap-1.5 text-[12px] font-semibold"><Megaphone size={14} className="text-primary" />קמפיין קיץ</p>
          <p className="mt-1 text-[11px] text-muted">מטרה: יותר תורים</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full w-2/3 rounded-full bg-[#8B66FF]" /></div>
        </Orbit>
        <Orbit mx={mx} my={my} depth={1.4} className="bottom-[-18%] left-[22%] hidden w-[200px] sm:block" delay={0.5}>
          <p className="flex items-center gap-1.5 text-[12px] font-semibold"><WhatsappLogo size={14} className="text-ok" />ליד חדש</p>
          <p className="mt-1 text-[11px] text-ink-2">מיכל שאלה על טיפול פנים. ה-AI כבר ענה.</p>
        </Orbit>
        <Orbit mx={mx} my={my} depth={0.3} className="left-[3%] top-[62%] hidden w-[150px] lg:block" delay={3}>
          <p className="flex items-center gap-1.5 text-[12px] font-semibold"><ChartBar size={14} className="text-[#5BA4FF]" />ביצועים</p>
          <svg viewBox="0 0 120 36" className="mt-2 w-full" aria-hidden>
            <polyline points="0,30 20,26 40,28 60,18 80,20 100,10 120,6" fill="none" stroke="#5BA4FF" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </Orbit>
        <Orbit mx={mx} my={my} depth={0.9} className="right-[4%] top-[72%] hidden w-[140px] lg:block" delay={1.5}>
          <p className="flex items-center gap-1.5 text-[12px] font-semibold"><CalendarBlank size={14} className="text-[#FFAE7C]" />יום שלישי</p>
          <p className="mt-1 text-[11px] text-ink-2">רילס, 19:00</p>
        </Orbit>
        <Orbit mx={mx} my={my} depth={0.6} className="left-[16%] top-[-16%] hidden w-[110px] xl:block" delay={2.5}>
          <p className="mb-2 flex items-center gap-1 text-[11px] text-muted"><ImageGlyph size={12} />תמונת AI</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={REELS[3].poster} alt="" className="aspect-[4/5] w-full rounded-lg object-cover" />
        </Orbit>
      </div>
    </section>
  );
}
