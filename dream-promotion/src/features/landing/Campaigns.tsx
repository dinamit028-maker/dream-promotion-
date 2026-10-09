'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import { Target, UsersThree, Lightning } from '@/components/ui/Icon';
import { REELS } from './theme';

const CHOICES = [
  { I: Target, k: 'מטרה', v: 'יותר פניות לחבילות קיץ' },
  { I: UsersThree, k: 'קהל', v: 'זוגות 25–40, מרכז הארץ' },
  { I: Lightning, k: 'תקציב', v: '₪60 ליום' },
];

/** What the numbers mean is always labelled, so a forecast is never read as a promise. */
const LEDGER = [
  { t: 'הוצאה בפועל', d: 'מה שנגבה בפועל, מתעדכן אחרי העלייה לאוויר.' },
  { t: 'נתוני ביצועים', d: 'חשיפות ופניות, ישירות מהרשת עצמה.' },
  { t: 'המלצות AI', d: 'מה כדאי לשנות, עם הסבר למה.' },
  { t: 'הערכה', d: 'תחזית בלבד, לא התחייבות לתוצאה.' },
];

export function Campaigns() {
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.35 });
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (reduce) { setStep(4); return; }
    let n = 0;
    const t = setInterval(() => { n += 1; setStep(n); if (n >= 4) clearInterval(t); }, 700);
    return () => clearInterval(t);
  }, [seen, reduce]);

  const rise = (i: number) => ({
    initial: reduce ? false : { opacity: 0, y: 24 },
    animate: step >= 4 ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 },
    transition: { type: 'spring' as const, stiffness: 170, damping: 20, delay: i * 0.1 },
  });

  return (
    <section id="campaigns" ref={ref} className="mx-auto max-w-6xl scroll-mt-20 px-5 py-28">
      <h2 className="max-w-2xl font-display text-4xl font-black leading-tight sm:text-6xl">קמפיין שמרכיב את עצמו</h2>
      <p className="mt-4 max-w-xl text-lg text-ink-2">בוחרים שלושה דברים. ה-AI כותב, מעצב ומחלק את התקציב.</p>

      <div className="mt-12 grid gap-6 lg:grid-cols-[.8fr_1.2fr]">
        <ul className="stack-y-3">
          {CHOICES.map(({ I, k, v }, i) => (
            <li key={k} className={`flex items-center gap-3 rounded-2xl border p-4 transition-colors duration-300 ${step > i ? 'border-[#8B66FF]/50 bg-[#8B66FF]/10' : 'border-line bg-surface-2'}`}>
              <I size={22} className={step > i ? 'text-primary' : 'text-muted'} aria-hidden />
              <div>
                <p className="text-[12px] text-muted">{k}</p>
                <p className={`font-semibold ${step > i ? 'text-ink' : 'text-muted'}`}>{v}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <motion.div {...rise(0)} className="col-span-2 row-span-2 overflow-hidden rounded-2xl border border-line bg-surface sm:col-span-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={REELS[1].poster} alt="" className="h-40 w-full object-cover sm:h-52" />
            <div className="p-3">
              <p className="text-[11px] text-muted">קריאייטיב וכותרת</p>
              <p className="font-display font-bold leading-snug">הקיץ שלכם כבר מחכה בשער 4.</p>
            </div>
          </motion.div>
          <motion.div {...rise(1)} className="rounded-2xl border border-line bg-surface p-3">
            <p className="text-[11px] text-muted">טקסט</p>
            <p className="mt-1 text-[13px] leading-snug">חבילה אחת: טיסה, מלון והעברות. אתם רק אורזים.</p>
          </motion.div>
          <motion.div {...rise(2)} className="rounded-2xl border border-line bg-surface p-3">
            <p className="text-[11px] text-muted">קריאה לפעולה</p>
            <span className="mt-2 inline-block rounded-full bg-ink px-3 py-1.5 text-[12px] font-bold text-bg">לבדיקת מחיר</span>
          </motion.div>
          <motion.div {...rise(3)} className="rounded-2xl border border-line bg-surface p-3">
            <p className="text-[11px] text-muted">קהל</p>
            <p className="mt-1 text-[13px]">זוגות 25–40 · מתעניינים בטיסות</p>
          </motion.div>
          <motion.div {...rise(4)} className="rounded-2xl border border-line bg-surface p-3">
            <p className="text-[11px] text-muted">חלוקת תקציב</p>
            <div className="mt-2 flex h-2.5 overflow-hidden rounded-full">
              <span className="w-[60%] bg-[#8B66FF]" /><span className="w-[40%] bg-[#FF7FA8]" />
            </div>
            <p className="mt-1.5 flex justify-between text-[11px] text-muted"><span>רילס 60%</span><span>סטורי 40%</span></p>
          </motion.div>
        </div>
      </div>

      <dl className="mt-10 grid gap-3 sm:grid-cols-4">
        {LEDGER.map((l) => (
          <div key={l.t} className="rounded-2xl border border-line p-4">
            <dt className="font-display font-bold">{l.t}</dt>
            <dd className="mt-1 text-sm leading-relaxed text-muted">{l.d}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
