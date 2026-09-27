import Link from 'next/link';
import { Button } from '@/components/ui/primitives';
import { AuthButton, LandingRedirect } from '@/features/auth/LandingAuth';
import { ShowcaseVideo } from '@/features/landing/ShowcaseVideo';
import { VersionTag } from '@/components/system/VersionTag';
import {
  Sparkle, CalendarBlank, FilmSlate, Megaphone, UsersThree, PencilSimpleLine, TiktokLogo,
  Robot, CalendarCheck, AddressBook, CashRegister, ShoppingBag, IdentificationBadge,
  Diamond, Dress, ForkKnife, Barbell, HouseLine,
} from '@/components/ui/Icon';

/** Real reels made in the app (files live in /public/showcase). */
const REELS = [
  { src: '/showcase/1.mp4', poster: '/showcase/1.jpg', label: 'ריל שנוצר במערכת: תיירת בבית קפה באירופה' },
  { src: '/showcase/2.mp4', poster: '/showcase/2.jpg', label: 'ריל שנוצר במערכת: נוסע בשדה תעופה' },
  { src: '/showcase/3.mp4', poster: '/showcase/3.jpg', label: 'ריל שנוצר במערכת: איש עסקים יורד ממטוס פרטי' },
  { src: '/showcase/4.mp4', poster: '/showcase/4.jpg', label: 'ריל שנוצר במערכת: תייר ברחוב סואן' },
];

/** An illustrative day, not a statistic: what the system does while the owner works. */
const DAY = [
  { at: '06:00', t: 'ריל חדש נשלח ל-TikTok' },
  { at: '09:40', t: 'ליד מהקמפיין נכנס ללוח' },
  { at: '13:15', t: 'פוסט לאינסטגרם מחכה לאישור' },
  { at: '20:00', t: 'השבוע הבא כבר ביומן' },
];

/** A real sequence, so the numbers carry meaning. */
const FLOW = [
  { t: 'מספרים על העסק', d: 'שם, תחום וקהל. המערכת בונה פרופיל מותג עם טון דיבור משלכם.' },
  { t: 'מקבלים תסריט', d: 'הוק, בעיה, פתרון וקריאה לפעולה, עם טקסט למסך לכל סצנה.' },
  { t: 'הסרטון נוצר', d: 'וידאו אנכי באיכות קולנועית, בגודל שמתאים לרשתות.' },
  { t: 'שולחים ל-TikTok', d: 'לחיצה אחת, והסרטון מחכה באפליקציה עם הטקסט לפוסט.' },
];

const TOOLS_NOW = [
  { I: PencilSimpleLine, t: 'תוכן ופוסטים', d: 'קאפשן, כותרת והאשטגים בעברית, בטון של העסק.' },
  { I: FilmSlate, t: 'רילסים וסרטוני AI', d: 'מתסריט לסרטון מוכן, בלי צילומים ובלי עורך.' },
  { I: CalendarBlank, t: 'יומן תוכן', d: 'שבוע שלם מתוכנן בלחיצה, בשעות שהקהל ער.' },
  { I: Megaphone, t: 'קמפיינים', d: 'מטרה, קהל ותקציב. המודעה נכתבת בשבילכם.' },
  { I: UsersThree, t: 'לוח לידים', d: 'כל פנייה במקום אחד, עם סטטוס לכל לקוח.' },
  { I: TiktokLogo, t: 'חיבור ל-TikTok', d: 'הסרטונים נשלחים ישר לחשבון של העסק.' },
];

const TOOLS_NEXT = [
  { I: Robot, t: 'צ׳אטבוט AI ללידים', d: 'עונה לכל פנייה מיד ומחמם את הליד עד לשיחה.' },
  { I: CalendarCheck, t: 'זימון תורים', d: 'לקוחות קובעים לבד, והיומן מתעדכן.' },
  { I: AddressBook, t: 'CRM', d: 'כרטיס לכל לקוח: היסטוריה, רכישות ותזכורות.' },
  { I: CashRegister, t: 'קופה דיגיטלית', d: 'גבייה וקבלות, מחוברת לסליקה קיימת.' },
  { I: ShoppingBag, t: 'חנות אונליין', d: 'מוצרים, הזמנות ומלאי באותו מקום.' },
  { I: IdentificationBadge, t: 'שעון נוכחות', d: 'כניסה ויציאה לעובדים, כשהעסק גדל.' },
];

const INDUSTRIES = [
  { I: Sparkle, t: 'קליניקות יופי' }, { I: Diamond, t: 'סטודיו לתכשיטים' }, { I: Dress, t: 'אופנה ובוטיקים' },
  { I: ForkKnife, t: 'מסעדות ובתי קפה' }, { I: Barbell, t: 'סטודיו כושר' }, { I: HouseLine, t: 'נדל״ן' },
];

function Logo() {
  return (
    <span aria-hidden className="relative h-8 w-8 shrink-0 rounded-[11px] bg-primary">
      <span className="absolute inset-[27%] rounded-[5px] bg-white/90" />
    </span>
  );
}

export default function Landing() {
  return (
    <main className="overflow-x-hidden">
      <LandingRedirect />
      <header className="safe-t sticky top-0 z-50 border-b border-line/70 bg-bg/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo /><span className="whitespace-nowrap font-display text-lg font-bold">Dream Promotion</span>
          </Link>
          <nav aria-label="ניווט" className="hidden gap-7 text-[15px] font-semibold text-ink-2 md:flex">
            <a href="#made" className="hover:text-primary">מה המערכת יוצרת</a>
            <a href="#toolbox" className="hover:text-primary">ארגז הכלים</a>
            <a href="#who" className="hover:text-primary">למי זה</a>
          </nav>
          <div className="flex items-center gap-2">
            <AuthButton mode="in" variant="ghost">כניסה</AuthButton>
            <AuthButton mode="up">הרשמה</AuthButton>
          </div>
        </div>
      </header>

      {/* HERO — the page's one bold moment: a night panel of real reels and a day the system ran on its own */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-10 lg:grid-cols-[1fr_1fr] lg:gap-14 lg:pt-16">
        <div>
          <h1 className="font-display text-[34px] font-black leading-[1.05] tracking-tight sm:text-[52px] lg:text-[56px]">
            עסק של אדם אחד.<br />עבודה של צוות שלם.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-2 sm:text-xl">
            תארו את העסק, והמערכת כותבת, יוצרת סרטונים, ממלאת את היומן ושולחת ל-TikTok. אתם מאשרים ועוברים לדבר הבא.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <AuthButton mode="up" size="lg"><Sparkle size={20} weight="fill" aria-hidden />התחלה בחינם</AuthButton>
            <a href="#made"><Button variant="ghost" size="lg">לראות סרטונים מהמערכת</Button></a>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[440px] rounded-xl bg-[#1B1438] p-4 pb-5 text-white shadow-lg sm:p-6">
          <div className="grid grid-cols-2 gap-3 sm:gap-4" aria-label="סרטונים אמיתיים שנוצרו במערכת">
            {REELS.map((r, i) => (
              <ShowcaseVideo key={r.src} {...r}
                className={`aspect-[9/16] rounded-[18px] ring-1 ring-white/10 ${i % 2 === 1 ? 'translate-y-8' : ''}`} />
            ))}
          </div>
          <div className="relative -mt-4 rounded-md bg-[#261D4D]/95 p-4 ring-1 ring-white/10 backdrop-blur">
            <p className="flex items-center gap-2 text-sm font-semibold text-white/80">
              <span className="relative flex h-2.5 w-2.5" aria-hidden>
                <span className="absolute inset-0 animate-ping rounded-full bg-[#43D2AE] opacity-60 motion-reduce:hidden" />
                <span className="relative h-2.5 w-2.5 rounded-full bg-[#43D2AE]" />
              </span>
              יום רגיל של העסק, בזמן שאתם עובדים
            </p>
            <ol className="mt-3 space-y-1.5 text-[15px]">
              {DAY.map((e) => (
                <li key={e.at} className="flex gap-3">
                  <span className="w-11 shrink-0 font-display font-bold tabular-nums text-[#43D2AE]" dir="ltr">{e.at}</span>
                  <span className="text-white/90">{e.t}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* MADE — the flow behind the reels above */}
      <section id="made" className="scroll-mt-20 border-y border-line bg-surface py-20">
        <div className="mx-auto max-w-6xl px-5">
          <h2 className="max-w-xl font-display text-3xl font-extrabold leading-tight sm:text-4xl">מתיאור קצר לסרטון ב-TikTok</h2>
          <p className="mt-3 max-w-2xl text-lg text-ink-2">כל הסרטונים בראש העמוד נוצרו במערכת, בלי מצלמה, בלי שחקנים ובלי עורך וידאו.</p>
          <ol className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
            {FLOW.map((s, i) => (
              <li key={s.t} className="border-t-2 border-primary pt-5">
                <span className="font-display text-sm font-bold text-primary">שלב {i + 1}</span>
                <h3 className="mt-1 font-display text-xl font-bold">{s.t}</h3>
                <p className="mt-2 leading-relaxed text-ink-2">{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* TOOLBOX — two drawers: what works today, and what is coming. Honest status on every tool. */}
      <section id="toolbox" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <h2 className="max-w-2xl font-display text-3xl font-extrabold leading-tight sm:text-5xl">ארגז כלים לעסק של אדם אחד</h2>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-2">
            כל מה שצריך כדי לפתוח עסק מחר בבוקר ולנהל אותו לבד, בבית אחד. חלק מהכלים כבר עובדים, והשאר בדרך.
          </p>

          <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:gap-16">
            <div>
              <h3 className="flex items-center gap-2 font-display text-xl font-bold">
                <span className="h-2.5 w-2.5 rounded-full bg-ok" aria-hidden />כבר בארגז
              </h3>
              <ul className="mt-5 divide-y divide-line border-y border-line">
                {TOOLS_NOW.map(({ I, t, d }) => (
                  <li key={t} className="flex items-start gap-4 py-4">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm bg-primary-soft text-primary">
                      <I size={22} aria-hidden />
                    </span>
                    <div>
                      <p className="font-display text-lg font-bold">{t}</p>
                      <p className="mt-0.5 leading-relaxed text-ink-2">{d}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="flex items-center gap-2 font-display text-xl font-bold text-ink-2">
                <span className="h-2.5 w-2.5 rounded-full border-2 border-muted" aria-hidden />נכנס בקרוב
              </h3>
              <ul className="mt-5 divide-y divide-dashed divide-line border-y border-dashed border-line">
                {TOOLS_NEXT.map(({ I, t, d }) => (
                  <li key={t} className="flex items-start gap-4 py-4">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-dashed border-line text-muted">
                      <I size={22} aria-hidden />
                    </span>
                    <div>
                      <p className="font-display text-lg font-bold text-ink-2">{t}</p>
                      <p className="mt-0.5 leading-relaxed text-muted">{d}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* WHO — qualitative fit; no invented testimonials or numbers */}
      <section id="who" className="scroll-mt-20 bg-bg-2 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <h2 className="font-display text-3xl font-extrabold sm:text-4xl">נבנה לעסקים שחיים מהמראה שלהם</h2>
          <p className="mt-3 max-w-2xl text-lg text-ink-2">עסקים שהלקוחות שלהם בוחרים לפי מה שהם רואים ברשתות, ושאין להם זמן לשבת על זה כל ערב.</p>
          <ul className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {INDUSTRIES.map(({ I, t }) => (
              <li key={t} className="flex flex-col items-start gap-3 rounded-md border border-line bg-surface p-4">
                <I size={26} className="text-primary" aria-hidden />
                <span className="font-semibold">{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="px-5 py-20">
        <div className="mx-auto max-w-6xl rounded-xl bg-[#1B1438] px-6 py-14 text-center text-white sm:px-12 sm:py-20">
          <h2 className="font-display text-3xl font-black sm:text-5xl">העסק שלכם יכול להתחיל לעבוד מחר בבוקר.</h2>
          <p className="mx-auto mt-4 max-w-lg text-lg text-white/80">שלוש דקות של שאלות על העסק, ואתם רואים שבוע תוכן אמיתי.</p>
          <div className="mt-8 flex justify-center">
            <AuthButton mode="up" size="lg">התחלה בחינם</AuthButton>
          </div>
        </div>
      </section>

      <footer className="border-t border-line py-10 text-sm text-muted">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-6 gap-y-2 px-5">
          <span>© {new Date().getFullYear()} Dream Promotion</span>
          <VersionTag />
          <a href="/privacy" className="hover:underline">מדיניות פרטיות</a>
          <a href="/terms" className="hover:underline">תנאי שימוש</a>
        </div>
      </footer>
    </main>
  );
}
