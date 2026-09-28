import { House, PencilSimpleLine, FilmSlate, SquaresFour, CalendarBlank, UsersThree, Sparkle, TiktokLogo, InstagramLogo } from '@/components/ui/Icon';

const NAV = [
  { I: House, t: 'בית', on: true }, { I: PencilSimpleLine, t: 'יצירה' }, { I: FilmSlate, t: 'אולפן רילס' },
  { I: SquaresFour, t: 'תוכן' }, { I: CalendarBlank, t: 'יומן' }, { I: UsersThree, t: 'לידים' },
];

const WEEK = [
  { d: 'א׳', c: 'פוסט', tone: 'bg-[#8B66FF]' }, { d: 'ב׳', c: 'סטורי', tone: 'bg-[#FF7FA8]' },
  { d: 'ג׳', c: 'רילס', tone: 'bg-[#43D2AE]' }, { d: 'ד׳', c: 'טיפ', tone: 'bg-[#5BA4FF]' }, { d: 'ה׳', c: 'מבצע', tone: 'bg-[#FFAE7C]' },
];

/** A static but believable picture of the real app's home screen. Decorative: hidden from screen readers. */
export function DashboardMock({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden className={`flex overflow-hidden rounded-[22px] border border-line bg-surface text-right text-ink shadow-[0_40px_120px_rgba(80,40,200,.35)] ${className}`}>
      <aside className="hidden w-40 shrink-0 border-l border-line bg-surface-2 p-3 sm:block">
        <div className="mb-4 flex items-center gap-2 px-1">
          <span className="relative h-6 w-6 rounded-[8px] bg-[#8B66FF]"><span className="absolute inset-[27%] rounded-[3px] bg-white/90" /></span>
          <span className="font-display text-[13px] font-bold">Dream Promotion</span>
        </div>
        <ul className="space-y-1 text-[12px]">
          {NAV.map(({ I, t, on }) => (
            <li key={t} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${on ? 'bg-surface-2 text-ink' : 'text-muted'}`}>
              <I size={14} />{t}
            </li>
          ))}
        </ul>
      </aside>
      <div className="min-w-0 flex-1 p-4 sm:p-5">
        <p className="font-display text-[15px] font-bold sm:text-lg">בוקר טוב, סטודיו נועה</p>
        <p className="text-[11px] text-muted sm:text-xs">5 פריטים מתוכננים לשבוע הזה</p>

        <div className="mt-4 grid grid-cols-5 gap-1.5 sm:gap-2">
          {WEEK.map((w) => (
            <div key={w.d} className="rounded-lg border border-line bg-surface-2 p-1.5 sm:p-2">
              <p className="text-[10px] text-muted">{w.d}</p>
              <p className={`mt-1.5 truncate rounded-md px-1.5 py-1 text-[10px] font-semibold text-[#0A0814] sm:text-[11px] ${w.tone}`}>{w.c}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-[1.4fr_1fr]">
          <div className="rounded-xl border border-[#8B66FF]/30 bg-[#8B66FF]/10 p-3">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-primary"><Sparkle size={12} weight="fill" />הצעת ה-AI להיום</p>
            <p className="mt-1 text-[12px] leading-snug text-ink sm:text-[13px]">ריל ״3 טעויות בטיפוח אחרי הקיץ״, בשעה 19:00, כשהקהל שלכם הכי פעיל.</p>
          </div>
          <div className="hidden rounded-xl border border-line bg-surface-2 p-3 sm:block">
            <p className="text-[11px] text-muted">נשלח לאחרונה</p>
            <p className="mt-1.5 flex items-center gap-1.5 text-[12px]"><TiktokLogo size={13} />ריל לטיוטות</p>
            <p className="mt-1 flex items-center gap-1.5 text-[12px]"><InstagramLogo size={13} />פוסט ממתין לאישור</p>
          </div>
        </div>
      </div>
    </div>
  );
}
