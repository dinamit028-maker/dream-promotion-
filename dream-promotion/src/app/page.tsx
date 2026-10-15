import Link from 'next/link';
import { AuthButton, LandingRedirect } from '@/features/auth/LandingAuth';
import { VersionTag } from '@/components/system/VersionTag';
import { ThemeToggle } from '@/components/system/ThemeToggle';
import { Hero } from '@/features/landing/Hero';
import { Brain } from '@/features/landing/Brain';
import { CreateDemo } from '@/features/landing/CreateDemo';
import { ImageStudio } from '@/features/landing/ImageStudio';
import { ReelStudio } from '@/features/landing/ReelStudio';
import { CalendarAuto } from '@/features/landing/CalendarAuto';
import { Campaigns } from '@/features/landing/Campaigns';
import { Leads } from '@/features/landing/Leads';
import { FinalScene } from '@/features/landing/FinalScene';
import {
  CalendarBlank, FilmSlate, Megaphone, UsersThree, PencilSimpleLine, TiktokLogo,
  Robot, CalendarCheck, AddressBook, CashRegister, ShoppingBag, IdentificationBadge,
  WhatsappLogo, ClipboardText, Receipt, Storefront, Wallet,
} from '@/components/ui/Icon';

// the toolbox: what is built and in use is "כבר בארגז" (in three groups, so the list reads on a phone);
// what is not ready yet is "נכנס בקרוב"
const TOOLS_NOW = [
  { g: 'שיווק', items: [
    { I: PencilSimpleLine, t: 'תוכן ופוסטים', d: 'קאפשן, כותרת והאשטגים בעברית, בטון של העסק.' },
    { I: FilmSlate, t: 'רילסים וסרטוני AI', d: 'מתסריט לסרטון מוכן, בלי צילומים ובלי עורך.' },
    { I: CalendarBlank, t: 'יומן תוכן', d: 'שבוע שלם של תוכן, מתוכנן בלחיצה.' },
    { I: Megaphone, t: 'קמפיינים', d: 'מטרה, קהל ותקציב. המודעה נכתבת בשבילכם.' },
    { I: TiktokLogo, t: 'חיבור ל-TikTok', d: 'הסרטונים נשלחים לטיוטות בחשבון של העסק.' },
  ] },
  { g: 'לקוחות', items: [
    { I: UsersThree, t: 'לוח לידים', d: 'כל פנייה במקום אחד, עם סטטוס לכל לקוח.' },
    { I: AddressBook, t: 'CRM', d: 'כרטיס לכל לקוח: היסטוריה, רכישות ותזכורות.' },
    { I: WhatsappLogo, t: 'ניתוב לידים לאחראי', d: 'כל ליד מטופס מגיע למחלקה שלו ונשלח בוואטסאפ לעובד האחראי.' },
    { I: CalendarCheck, t: 'זימון תורים', d: 'לקוחות קובעים לבד, והיומן מתעדכן.' },
    { I: ClipboardText, t: 'הצהרות בריאות', d: 'הלקוח חותם בטלפון לפני הטיפול, וההצהרה נשמרת בכרטיס.' },
  ] },
  { g: 'ניהול העסק', items: [
    { I: CashRegister, t: 'קופה דיגיטלית', d: 'מכירות, החזרים וסגירת יום, עם מסמך לכל מכירה.' },
    { I: Receipt, t: 'חשבוניות וכספים', d: 'הצעות מחיר, חשבוניות, קבלות, הוצאות ודוחות.' },
    { I: ShoppingBag, t: 'חנות אונליין', d: 'אתר לעסק עם מוצרים ומלאי, ועיצוב בלחיצה.' },
    { I: IdentificationBadge, t: 'שעון נוכחות', d: 'כניסה ויציאה לעובדים מהטלפון, ודוח חודשי.' },
    { I: Storefront, t: 'ניהול סניפים', d: 'כמה סניפים וקופות, ומלאי לכל סניף.' },
  ] },
];
const TOOLS_NEXT = [
  { I: Robot, t: 'צ׳אטבוט AI ללידים', d: 'עונה לכל פנייה מיד ומחמם את הליד עד לשיחה.' },
  { I: Wallet, t: 'תשלום אונליין', d: 'תשלום בכרטיס בחנות, בקישור לתשלום ובמקדמה על תור.' },
];

const NAV = [
  { h: '#brain', t: 'איך זה עובד' }, { h: '#create', t: 'יכולות' }, { h: '#studio', t: 'AI Studio' },
  { h: '#calendar', t: 'יומן' }, { h: '#campaigns', t: 'קמפיינים' }, { h: '#toolbox', t: 'ארגז הכלים' },
];

export default function Landing() {
  return (
    <main className="min-h-screen overflow-x-clip text-ink">
      <LandingRedirect />

      {/* floating glass navigation */}
      <header className="safe-t sticky top-3 z-50 px-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 rounded-full border border-line bg-(--glass-bg) px-2 py-2 shadow-[0_10px_40px_rgba(0,0,0,.4)] backdrop-blur-xl sm:gap-4 sm:px-4">
          <Link href="/" className="flex min-w-0 items-center gap-2 ps-1">
            <span aria-hidden className="relative h-8 w-8 shrink-0 rounded-[11px] bg-[#8B66FF]"><span className="absolute inset-[27%] rounded-[5px] bg-white/90" /></span>
            {/* on the smallest phones the name shrinks instead of pushing the buttons off screen */}
            <span className="truncate whitespace-nowrap font-display text-base font-bold min-[380px]:text-lg">Dream Promotion</span>
          </Link>
          <nav aria-label="ניווט" className="hidden gap-6 text-[14px] font-semibold text-ink-2 lg:flex">
            {NAV.map((n) => <a key={n.h} href={n.h} className="transition-colors hover:text-ink">{n.t}</a>)}
          </nav>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <ThemeToggle className="max-sm:hidden" />
            <AuthButton mode="in" variant="ghost">כניסה</AuthButton>
            <AuthButton mode="up">הרשמה</AuthButton>
          </div>
        </div>
      </header>

      <Hero />
      <Brain />
      <CreateDemo />
      <ImageStudio />
      <ReelStudio />
      <CalendarAuto />
      <Campaigns />
      <Leads />

      {/* the bigger vision: an honest status on every tool — what is in use, and what is on the way */}
      <section id="toolbox" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-28">
        <h2 className="max-w-3xl font-display text-4xl font-black leading-tight sm:text-6xl">ארגז כלים לעסק של אדם אחד</h2>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-2">
          כל מה שצריך כדי לפתוח עסק מחר בבוקר ולנהל אותו לבד, בבית אחד. רוב הכלים כבר עובדים, והשאר בדרך.
        </p>

        <h3 className="mt-12 flex items-center gap-2 font-display text-xl font-bold"><span className="h-2.5 w-2.5 rounded-full bg-[#43D2AE]" aria-hidden />כבר בארגז</h3>
        <div className="mt-6 grid gap-10 md:grid-cols-3 md:gap-8">
          {TOOLS_NOW.map(({ g, items }) => (
            <div key={g}>
              <h4 className="font-display text-sm font-bold text-primary">{g}</h4>
              <ul className="mt-2 divide-y divide-line border-y border-line">
                {items.map(({ I, t, d }) => (
                  <li key={t} className="flex items-start gap-4 py-4">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[#8B66FF]/15 text-primary"><I size={22} aria-hidden /></span>
                    <div><p className="font-display text-lg font-bold">{t}</p><p className="mt-0.5 leading-relaxed text-ink-2">{d}</p></div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <h3 className="mt-14 flex items-center gap-2 font-display text-xl font-bold text-ink-2"><span className="h-2.5 w-2.5 rounded-full border-2 border-(--muted)" aria-hidden />נכנס בקרוב</h3>
        <ul className="mt-5 grid border-y border-dashed border-line md:grid-cols-2 md:gap-x-8">
          {TOOLS_NEXT.map(({ I, t, d }, i) => (
            <li key={t} className={`flex items-start gap-4 py-4 ${i ? 'max-md:border-t max-md:border-dashed max-md:border-line' : ''}`}>
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-dashed border-line text-muted"><I size={22} aria-hidden /></span>
              <div><p className="font-display text-lg font-bold text-ink">{t}</p><p className="mt-0.5 leading-relaxed text-muted">{d}</p></div>
            </li>
          ))}
        </ul>
      </section>

      <FinalScene />

      <footer className="border-t border-line py-10 text-sm text-muted">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-6 gap-y-2 px-5">
          <span>© {new Date().getFullYear()} Dream Promotion</span>
          <VersionTag />
          <a href="/privacy" className="hover:text-ink">מדיניות פרטיות</a>
          <a href="/data-deletion" className="hover:text-ink">מחיקת מידע</a>
          <a href="/terms" className="hover:text-ink">תנאי שימוש</a>
          <ThemeToggle />
        </div>
      </footer>
    </main>
  );
}
