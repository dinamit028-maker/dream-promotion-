import Link from 'next/link';
import { AuthButton, LandingRedirect } from '@/features/auth/LandingAuth';
import { VersionTag } from '@/components/system/VersionTag';
import { Hero } from '@/features/landing/Hero';
import { Brain } from '@/features/landing/Brain';
import { CreateDemo } from '@/features/landing/CreateDemo';
import { ImageStudio } from '@/features/landing/ImageStudio';
import { ReelStudio } from '@/features/landing/ReelStudio';
import { CalendarAuto } from '@/features/landing/CalendarAuto';
import { Campaigns } from '@/features/landing/Campaigns';
import { Leads } from '@/features/landing/Leads';
import { FinalScene } from '@/features/landing/FinalScene';
import { LANDING_THEME } from '@/features/landing/theme';
import {
  CalendarBlank, FilmSlate, Megaphone, UsersThree, PencilSimpleLine, TiktokLogo,
  Robot, CalendarCheck, AddressBook, CashRegister, ShoppingBag, IdentificationBadge,
} from '@/components/ui/Icon';

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

const NAV = [
  { h: '#brain', t: 'איך זה עובד' }, { h: '#create', t: 'יכולות' }, { h: '#studio', t: 'AI Studio' },
  { h: '#calendar', t: 'יומן' }, { h: '#campaigns', t: 'קמפיינים' }, { h: '#toolbox', t: 'ארגז הכלים' },
];

export default function Landing() {
  return (
    <main style={LANDING_THEME} className="min-h-screen overflow-x-clip bg-[#0A0814] text-[#F4F1FA]">
      <LandingRedirect />

      {/* floating glass navigation */}
      <header className="safe-t sticky top-3 z-50 px-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 rounded-full border border-white/10 bg-[#0A0814]/70 px-3 py-2 shadow-[0_10px_40px_rgba(0,0,0,.4)] backdrop-blur-xl sm:px-4">
          <Link href="/" className="flex items-center gap-2.5 ps-1">
            <span aria-hidden className="relative h-8 w-8 shrink-0 rounded-[11px] bg-[#8B66FF]"><span className="absolute inset-[27%] rounded-[5px] bg-white/90" /></span>
            <span className="whitespace-nowrap font-display text-lg font-bold">Dream Promotion</span>
          </Link>
          <nav aria-label="ניווט" className="hidden gap-6 text-[14px] font-semibold text-white/65 lg:flex">
            {NAV.map((n) => <a key={n.h} href={n.h} className="transition-colors hover:text-white">{n.t}</a>)}
          </nav>
          <div className="flex items-center gap-2">
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

      {/* the bigger vision: an honest status on every tool */}
      <section id="toolbox" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-28">
        <h2 className="max-w-3xl font-display text-4xl font-black leading-tight sm:text-6xl">ארגז כלים לעסק של אדם אחד</h2>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-white/65">
          כל מה שצריך כדי לפתוח עסק מחר בבוקר ולנהל אותו לבד, בבית אחד. חלק מהכלים כבר עובדים, והשאר בדרך.
        </p>
        <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <h3 className="flex items-center gap-2 font-display text-xl font-bold"><span className="h-2.5 w-2.5 rounded-full bg-[#43D2AE]" aria-hidden />כבר בארגז</h3>
            <ul className="mt-5 divide-y divide-white/10 border-y border-white/10">
              {TOOLS_NOW.map(({ I, t, d }) => (
                <li key={t} className="flex items-start gap-4 py-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[#8B66FF]/15 text-[#B9A2FF]"><I size={22} aria-hidden /></span>
                  <div><p className="font-display text-lg font-bold">{t}</p><p className="mt-0.5 leading-relaxed text-white/65">{d}</p></div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="flex items-center gap-2 font-display text-xl font-bold text-white/75"><span className="h-2.5 w-2.5 rounded-full border-2 border-white/40" aria-hidden />נכנס בקרוב</h3>
            <ul className="mt-5 divide-y divide-dashed divide-white/10 border-y border-dashed border-white/10">
              {TOOLS_NEXT.map(({ I, t, d }) => (
                <li key={t} className="flex items-start gap-4 py-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-dashed border-white/20 text-white/50"><I size={22} aria-hidden /></span>
                  <div><p className="font-display text-lg font-bold text-white/80">{t}</p><p className="mt-0.5 leading-relaxed text-white/50">{d}</p></div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <FinalScene />

      <footer className="border-t border-white/10 py-10 text-sm text-white/50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-6 gap-y-2 px-5">
          <span>© {new Date().getFullYear()} Dream Promotion</span>
          <VersionTag />
          <a href="/privacy" className="hover:text-white">מדיניות פרטיות</a>
          <a href="/terms" className="hover:text-white">תנאי שימוש</a>
        </div>
      </footer>
    </main>
  );
}
