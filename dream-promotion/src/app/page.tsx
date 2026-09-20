import Link from 'next/link';
import { Button, Card, Pill } from '@/components/ui/primitives';

/** Public marketing homepage. The interactive live demo lives in
 *  features/marketing/LiveDemo.tsx once /api/ai has a key — it calls the
 *  same AIService the product uses, so the demo is never a canned recording. */
export default function Landing() {
  return (
    <main>
      <nav className="safe-t sticky top-0 z-50 border-b border-transparent bg-bg/80 py-3.5 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <span className="relative h-8 w-8 rounded-[11px] bg-brand">
              <span className="absolute inset-[28%] rounded-[5px] bg-white/90" /></span>
            <span className="font-display text-lg font-extrabold">Dream Promotion</span>
          </div>
          <div className="hidden gap-6 text-[15px] font-semibold text-ink-2 md:flex">
            <a href="#how">איך זה עובד</a><a href="#features">מה יש בפנים</a><a href="#pricing">מחירים</a>
          </div>
          <Link href="/onboarding"><Button variant="primary" size="sm">התחלה חינם</Button></Link>
        </div>
      </nav>

      <header className="mx-auto max-w-6xl px-6 pb-24 pt-16">
        <div className="grid items-center gap-16 lg:grid-cols-2">
          <div>
            <Pill tone="ai">✦ מחלקת שיווק שלמה, בלי לגייס אף אחד</Pill>
            <h1 className="mt-4 font-display text-5xl font-extrabold leading-[1.05] tracking-tight sm:text-7xl">
              השיווק שלך<br /><span className="grad-text">רץ מעצמו.</span>
            </h1>
            <p className="mt-6 text-xl leading-relaxed text-ink-2">
              תארו את העסק, העלו כמה תמונות — ותקבלו פוסטים, רילסים, תוכנית שבועית וקמפיינים שמביאים פניות.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/onboarding"><Button variant="primary" size="lg">נסו עכשיו — בחינם</Button></Link>
              <a href="#how"><Button variant="ghost" size="lg">איך זה עובד</Button></a>
            </div>
          </div>
          <div className="rounded-xl border border-line bg-surface p-6 shadow-lg">
            <div className="grid grid-cols-4 gap-2.5">
              {['✧', '◆', '❋', '✦'].map((e, i) => (
                <div key={e} className="flex aspect-square items-center justify-center rounded-2xl text-2xl"
                  style={{ background: `linear-gradient(135deg, ${['#6B3BF5', '#FF7FA8', '#5BA4FF', '#43D2AE'][i]}, transparent)` }}>{e}</div>
              ))}
            </div>
            <div className="mt-6 space-y-2.5">
              {['מנתח את העסק…', 'כותב את הפוסט…', 'משבץ ליומן…', 'פורסם · 19:30'].map((s, i) => (
                <div key={s} className={i === 3 ? 'rounded-md bg-[rgba(23,169,127,.12)] p-3 font-bold text-ok' : 'text-muted'}>
                  {i === 3 ? `✓ ${s}` : s}
                </div>
              ))}
            </div>
          </div>
        </div>
      </header>

      <section id="how" className="bg-bg-2 py-24">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="mb-12 text-center font-display text-4xl font-extrabold">מהעסק שלכם לפיד תוך דקות</h2>
          <div className="grid gap-6 md:grid-cols-3">
            {[['1', 'מספרים על העסק', 'ה-AI בונה פרופיל מותג עם טון דיבור ועמודי תוכן.'],
              ['2', 'מעלים תמונות', 'הן הופכות לפוסטים, סטוריז ורילסים.'],
              ['3', 'מאשרים ומשחררים', 'שבוע תוכן מוכן ביומן, מתפרסם בזמנים הנכונים.']].map(([n, t, d]) => (
              <Card key={n}>
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand font-display font-extrabold text-white">{n}</div>
                <h3 className="font-display text-xl font-extrabold">{t}</h3>
                <p className="mt-2 text-muted">{d}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="py-24">
        <div className="mx-auto grid max-w-6xl gap-6 px-6 md:grid-cols-2 lg:grid-cols-3">
          {[['✎', 'תוכן AI', 'כמה זוויות לכל רעיון — כדי שתבחרו, לא תתקנו.'],
            ['▶', 'אולפן רילס', 'סטוריבורד מלא: הוק, בעיה, פתרון, CTA.'],
            ['◫', 'יומן ואוטופיילוט', 'שבוע שלם בלחיצה, עם גרירה בין ימים.'],
            ['◉', 'קמפיינים', 'ארבע שאלות במקום Ads Manager.'],
            ['☺', 'לידים', 'CRM קליל לכל פנייה שנכנסת.'],
            ['◈', 'ערכת מותג', 'צבעים, טון דיבור ו-CTA שחוזרים בכל תוכן.']].map(([i, t, d]) => (
            <Card key={t} hover>
              <div className="mb-4 flex h-13 w-13 items-center justify-center rounded-2xl bg-primary-soft p-3 text-xl text-primary">{i}</div>
              <h3 className="font-display text-xl font-extrabold">{t}</h3>
              <p className="mt-2 text-muted">{d}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="pricing" className="bg-bg-2 py-24">
        <div className="mx-auto max-w-6xl px-6 text-center">
          <h2 className="font-display text-4xl font-extrabold">פחות מיום עבודה של פרילנסר</h2>
          <p className="mt-4 text-lg text-muted">TODO: החליפו את המחירים בתמחור האמיתי לפני העלייה לאוויר.</p>
          <div className="mt-12">
            <Link href="/onboarding"><Button variant="primary" size="lg">יצירת התוכן הראשון</Button></Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line py-12 text-center text-sm text-muted">
        © {new Date().getFullYear()} Dream Promotion · מחלקת השיווק שלך, מונעת AI
      </footer>
    </main>
  );
}
