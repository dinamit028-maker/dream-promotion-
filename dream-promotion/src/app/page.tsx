import Link from 'next/link';
import { Button } from '@/components/ui/primitives';
import { Visual } from '@/components/ui/Visual';
import { AuthButton, LandingRedirect } from '@/features/auth/LandingAuth';
import {
  Check, Sparkle, CalendarBlank, FilmSlate, Megaphone, UsersThree, PencilSimpleLine, Target,
  Diamond, Dress, ForkKnife, Barbell, HouseLine, Storefront,
} from '@/components/ui/Icon';

const FEED = [
  { kind: 'reel' as const, headline: '3 דברים שהעור שלך צריך אחרי הקיץ', palette: ['#D6336C', '#FF8FA3'] as [string, string], ratio: 'vertical' as const },
  { kind: 'post' as const, headline: 'טבעת אחת. סיפור שלם.', palette: ['#3B2A8C', '#6B3BF5'] as [string, string], ratio: 'portrait' as const },
  { kind: 'story' as const, headline: 'נשארו 4 תורים לשבוע הבא', palette: ['#2F6FDB', '#5BC8D6'] as [string, string], ratio: 'vertical' as const },
];

const STEPS = [
  { t: 'מספרים על העסק', d: 'שם, תחום, קהל ומטרה. ה-AI בונה פרופיל מותג עם טון דיבור ועמודי תוכן.' },
  { t: 'מאשרים כמה זוויות', d: 'לכל רעיון מתקבלות כמה גרסאות שונות באמת. בוחרים, מתקנים מילה, ממשיכים.' },
  { t: 'השבוע נכנס ליומן', d: 'לחיצה אחת ממלאת שבוע שלם — מה, מתי ובאיזו רשת. משנים יום בנגיעה.' },
];

const INDUSTRIES = [
  { I: Sparkle, t: 'קליניקות יופי' }, { I: Diamond, t: 'סטודיו לתכשיטים' }, { I: Dress, t: 'אופנה ובוטיקים' },
  { I: ForkKnife, t: 'מסעדות ובתי קפה' }, { I: Barbell, t: 'סטודיו כושר' }, { I: HouseLine, t: 'נדל״ן' },
];

const FEATURES = [
  { I: PencilSimpleLine, t: 'תוכן בעברית של עסק', d: 'קאפשן, כותרת, האשטגים וקריאה לפעולה — בטון שלכם, לא בתרגום.' },
  { I: FilmSlate, t: 'רילס מסטוריבורד', d: 'הוק, בעיה, פתרון, הוכחה, CTA. טקסט למסך וקריינות לכל סצנה.' },
  { I: CalendarBlank, t: 'יומן שמתכנן לבד', d: 'שבוע מאוזן בין חינוכי, מכירתי ואישי, בשעות שהקהל שלכם ער.' },
  { I: Megaphone, t: 'קמפיינים בלי Ads Manager', d: 'מטרה, קהל, תקציב. המודעה נכתבת, ההוצאה מוצגת בנפרד מכל תחזית.' },
  { I: UsersThree, t: 'כל פנייה במקום אחד', d: 'לידים מהקמפיינים ומהוואטסאפ, עם סטטוס לכל אחד.' },
  { I: Target, t: 'ערכת מותג קבועה', d: 'צבעים, טון וקריאה לפעולה שחוזרים בכל פוסט בלי להזכיר.' },
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
            <Logo /><span className="font-display text-lg font-bold">Dream Promotion</span>
          </Link>
          <nav aria-label="ניווט" className="hidden gap-7 text-[15px] font-semibold text-ink-2 md:flex">
            <a href="#how" className="hover:text-primary">איך זה עובד</a>
            <a href="#who" className="hover:text-primary">למי זה</a>
            <a href="#features" className="hover:text-primary">מה בפנים</a>
          </nav>
          <div className="flex items-center gap-2">
            <AuthButton mode="in" variant="ghost">כניסה</AuthButton>
            <AuthButton mode="up">התחלה חינם</AuthButton>
          </div>
        </div>
      </header>

      {/* HERO — the product's output is the picture: a feed of real-looking posts */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-12 lg:grid-cols-[1.05fr_.95fr] lg:gap-16 lg:pt-20">
        <div>
          <h1 className="font-display text-[44px] font-extrabold leading-[1.02] tracking-tight sm:text-7xl">
            השיווק שלך<br />רץ מעצמו.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-2 sm:text-xl">
            תארו את העסק, העלו כמה תמונות, וקבלו פוסטים, רילסים ושבוע שלם ביומן. בעברית שנשמעת כמוכם, בלי משרד פרסום.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <AuthButton mode="up" size="lg"><Sparkle size={20} weight="fill" aria-hidden />נסו עכשיו, בחינם</AuthButton>
            <a href="#how"><Button variant="ghost" size="lg">איך זה עובד</Button></a>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[15px] font-semibold text-ink-2">
            {['הכול בעברית', 'מוכן תוך 3 דקות', 'בלי ידע שיווקי'].map((t) => (
              <li key={t} className="flex items-center gap-1.5"><Check size={17} weight="bold" className="text-ok" aria-hidden />{t}</li>
            ))}
          </ul>
        </div>

        <div className="relative mx-auto w-full max-w-[460px]" aria-label="דוגמאות לתוכן שהמערכת מייצרת">
          <div className="grid grid-cols-3 items-end gap-3">
            {FEED.map((p, i) => (
              <div key={p.headline} className={i === 1 ? '-translate-y-8' : ''}>
                <Visual kind={p.kind} headline={p.headline} palette={p.palette} ratio={p.ratio} size="sm"
                  className="rounded-2xl shadow-lg ring-1 ring-black/5" />
              </div>
            ))}
          </div>
          <div className="absolute -bottom-6 right-4 flex items-center gap-2.5 rounded-2xl border border-line bg-surface px-4 py-3 shadow-md">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--ok-soft)] text-ok">
              <CalendarBlank size={20} weight="fill" aria-hidden />
            </span>
            <span className="text-sm leading-tight">
              <strong className="block">5 פוסטים שובצו</strong>
              <span className="text-muted">לשבוע הקרוב</span>
            </span>
          </div>
        </div>
      </section>

      {/* HOW — a real sequence, so numbering carries meaning */}
      <section id="how" className="border-y border-line bg-surface py-20">
        <div className="mx-auto max-w-6xl px-5">
          <h2 className="max-w-lg font-display text-3xl font-extrabold leading-tight sm:text-4xl">מהעסק שלכם לפיד, בשלושה צעדים</h2>
          <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
            {STEPS.map((s, i) => (
              <li key={s.t} className="border-t-2 border-primary pt-5">
                <span className="font-display text-sm font-bold text-primary">שלב {i + 1}</span>
                <h3 className="mt-1 font-display text-xl font-bold">{s.t}</h3>
                <p className="mt-2 leading-relaxed text-ink-2">{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* WHO — qualitative proof of fit; no invented testimonials or numbers */}
      <section id="who" className="py-20">
        <div className="mx-auto max-w-6xl px-5">
          <h2 className="font-display text-3xl font-extrabold sm:text-4xl">נבנה לעסקים שחיים מהמראה שלהם</h2>
          <p className="mt-3 max-w-2xl text-lg text-ink-2">עסקים שהלקוחות שלהם בוחרים לפי מה שהם רואים באינסטגרם — ושאין להם זמן לשבת על זה כל ערב.</p>
          <ul className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {INDUSTRIES.map(({ I, t }) => (
              <li key={t} className="flex flex-col items-start gap-3 rounded-2xl border border-line bg-surface p-4">
                <I size={26} className="text-primary" aria-hidden />
                <span className="font-semibold">{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* FEATURES — a list, not a wall of identical cards */}
      <section id="features" className="bg-bg-2 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <h2 className="max-w-xl font-display text-3xl font-extrabold leading-tight sm:text-4xl">כל מחלקת השיווק, במסך אחד</h2>
          <dl className="mt-12 grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ I, t, d }) => (
              <div key={t} className="flex gap-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface text-primary shadow-sm">
                  <I size={22} aria-hidden />
                </span>
                <div>
                  <dt className="font-display text-lg font-bold">{t}</dt>
                  <dd className="mt-1 leading-relaxed text-ink-2">{d}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="px-5 py-20">
        <div className="mx-auto max-w-6xl rounded-xl bg-primary px-6 py-14 text-center text-white sm:px-12 sm:py-20">
          <Storefront size={36} weight="fill" aria-hidden className="mx-auto opacity-90" />
          <h2 className="mt-4 font-display text-3xl font-extrabold sm:text-5xl">הפוסט הבא שלכם כבר כתוב.</h2>
          <p className="mx-auto mt-4 max-w-lg text-lg text-white/85">שלוש דקות של שאלות על העסק, ואתם רואים שבוע תוכן אמיתי.</p>
          <Link href="/auth?mode=up" className="mt-8 inline-block">
            <Button size="lg" variant="ghost" className="!border-0 !text-primary">יצירת התוכן הראשון</Button>
          </Link>
        </div>
      </section>

      <footer className="border-t border-line py-10 text-center text-sm text-muted">
        © {new Date().getFullYear()} Dream Promotion
      </footer>
    </main>
  );
}
