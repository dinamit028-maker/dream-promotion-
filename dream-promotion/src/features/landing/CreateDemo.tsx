'use client';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion';
import { ArrowsClockwise, InstagramLogo, TiktokLogo, Megaphone, DeviceMobile, Sparkle } from '@/components/ui/Icon';
import { ShowcaseVideo } from './ShowcaseVideo';
import { REELS } from './theme';

const PROMPT = 'צור לי קמפיין לסוכנות נסיעות לקראת הקיץ';
type Phase = 'typing' | 'thinking' | 'done';

export function CreateDemo() {
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.4 });
  const reduce = useReducedMotion();
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase>('typing');
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (reduce) { setTyped(PROMPT); setPhase('done'); return; }
    setTyped(''); setPhase('typing');
    let i = 0;
    const t = setInterval(() => {
      i += 1; setTyped(PROMPT.slice(0, i));
      if (i >= PROMPT.length) {
        clearInterval(t); setPhase('thinking');
        setTimeout(() => setPhase('done'), 1400);
      }
    }, 45);
    return () => clearInterval(t);
  }, [seen, run, reduce]);

  const cards = [
    { k: 'post', I: InstagramLogo, t: 'פוסט לאינסטגרם', body: (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={REELS[0].poster} alt="" className="aspect-square w-full rounded-xl object-cover" />
        <p className="mt-2 text-[13px] leading-snug text-ink">הקיץ מתחיל בשדה התעופה. חבילות מוכנות, בלי כאבי ראש.</p>
      </>
    ) },
    { k: 'story', I: DeviceMobile, t: 'סטורי', body: (
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={REELS[1].poster} alt="" className="aspect-[9/16] w-full rounded-xl object-cover" />
        <p className="absolute inset-x-2 bottom-3 rounded-lg bg-black/55 px-2 py-1.5 text-center text-[12px] font-bold text-white">נשארו 6 מקומות ליולי</p>
      </div>
    ) },
    { k: 'reel', I: TiktokLogo, t: 'רילס', body: <ShowcaseVideo {...REELS[2]} className="aspect-[9/16] rounded-xl" /> },
    { k: 'ad', I: Megaphone, t: 'מודעה', body: (
      <div className="flex h-full flex-col justify-between gap-3">
        <p className="font-display text-lg font-bold leading-tight">טסים בקיץ? הכול סגור מראש.</p>
        <p className="text-[13px] text-ink-2">טיסה, מלון והעברות בחבילה אחת. מתאימים לכם מסלול בשיחה של 10 דקות.</p>
        <span className="self-start rounded-full bg-ink px-3 py-1.5 text-[12px] font-bold text-bg">לתיאום שיחה</span>
      </div>
    ) },
  ];

  return (
    <section id="create" ref={ref} className="mx-auto max-w-6xl scroll-mt-20 px-5 py-28">
      <h2 className="max-w-2xl font-display text-4xl font-black leading-tight sm:text-6xl">לא מסבירים. מראים.</h2>
      <p className="mt-4 max-w-xl text-lg text-ink-2">משפט אחד על מה שצריך, וכל הרשתות מקבלות תוכן מוכן.</p>

      <div className="mt-12 grid gap-8 lg:grid-cols-[.8fr_1.2fr]">
        <div className="self-start rounded-[22px] border border-line bg-surface-2 p-5">
          <p className="text-sm text-muted">מה ליצור היום?</p>
          <p className="mt-3 min-h-[64px] rounded-xl border border-line bg-bg p-4 text-lg" aria-live="polite">
            {typed}<span className={`inline-block w-[2px] bg-[#8B66FF] align-middle ${phase === 'typing' ? 'h-5 animate-pulse' : 'h-0'}`} />
          </p>
          <div className="mt-4 flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-ink-2">
              <Sparkle size={16} weight="fill" className={`text-primary ${phase === 'thinking' ? 'animate-pulse' : ''}`} aria-hidden />
              {phase === 'typing' ? 'מקליד…' : phase === 'thinking' ? 'ה-AI בונה את הקמפיין…' : '4 פריטים מוכנים'}
            </span>
            <button type="button" onClick={() => setRun((r) => r + 1)} className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">
              <ArrowsClockwise size={15} aria-hidden />להריץ שוב
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <AnimatePresence>
            {phase === 'done' && cards.map(({ k, I, t, body }, i) => (
              <motion.div
                key={`${k}-${run}`}
                initial={reduce ? false : { opacity: 0, y: 40, scale: 0.9, rotateX: 25 }}
                animate={{ opacity: 1, y: 0, scale: 1, rotateX: 0 }}
                transition={{ type: 'spring', stiffness: 160, damping: 18, delay: i * 0.12 }}
                className="rounded-2xl border border-line bg-surface p-3"
              >
                <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-muted"><I size={13} aria-hidden />{t}</p>
                {body}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
