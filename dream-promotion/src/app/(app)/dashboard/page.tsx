'use client';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { Button, Card, Chip, Pill, Textarea } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/feedback';
import { ContentCard } from '@/features/content/ContentCard';
import { greeting, today } from '@/lib/utils';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus, Sparkle, SunHorizon } from '@/components/ui/Icon';
import { followupState } from '@/features/crm/crm';

export default function Dashboard() {
  const router = useRouter();
  const { brand, content, analysis, leads } = useApp();
  // CRM: people waiting for a call back today (or overdue)
  const dueLeads = leads.filter((l) => { const s = followupState(l); return s === 'overdue' || s === 'today'; });
  const [prompt, setPrompt] = useState('');
  const todays = content.filter((c) => c.date === today());
  const upcoming = content.filter((c) => c.date && c.date > today()).sort((a, b) => a.date!.localeCompare(b.date!)).slice(0, 6);

  return (
    <>
      <div className="mb-8 pt-2 sm:pt-6">
        <h1 className="font-display text-[40px] font-black leading-[1.02] tracking-tight sm:text-7xl">
          {greeting()}{brand.name ? `, ${brand.name.split(' ')[0]}` : ''}.
        </h1>
        <p className="mt-3 text-lg text-ink-2 sm:text-xl">מה ניצור היום?</p>
      </div>

      {dueLeads.length > 0 && (
        <Link href="/leads" className="mb-6 flex items-center justify-between gap-3 rounded-2xl bg-amber-500/15 px-4 py-3">
          <span>
            <strong>{dueLeads.length === 1 ? `${dueLeads[0].name} מחכה שתחזרו אליו/ה` : `${dueLeads.length} אנשי קשר מחכים שתחזרו אליהם`}</strong>
            <span className="block text-xs text-ink-2">{dueLeads.slice(0, 3).map((l) => l.name).join(' · ')}</span>
          </span>
          <span className="text-sm font-bold">ללקוחות ←</span>
        </Link>
      )}

      {/* the command bar: one sentence in, content out */}
      <div className="relative mb-10">
        <div aria-hidden className="pointer-events-none absolute -inset-6 rounded-[40px] bg-[#8B66FF]/15 blur-3xl" />
        <div className="relative rounded-[26px] border border-[#8B66FF]/30 bg-(--glass) p-4 shadow-[0_24px_70px_rgba(0,0,0,.45)] backdrop-blur-xl sm:p-5">
        <Textarea className="min-h-[84px] border-line bg-(--glass-bg) text-[17px]" value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="תארו מה בא לכם לפרסם — למשל: ריל שמסביר את הטיפול החדש שלנו" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {([['post', 'פוסט'], ['reel', 'ריל'], ['story', 'סטורי'], ['ad', 'מודעה']] as [string, string][]).map(([k, label]) => (
              <Chip key={k} onClick={() => router.push(k === 'reel' ? `/reels?brief=${encodeURIComponent(prompt)}` : `/create?kind=${k}&brief=${encodeURIComponent(prompt)}`)}>
                {label}
              </Chip>
            ))}
          </div>
          <Button variant="primary" onClick={() => router.push(`/create?brief=${encodeURIComponent(prompt)}`)}><Sparkle size={18} weight="fill" aria-hidden />צרו עכשיו</Button>
        </div>
        </div>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-2xl font-black">התוכן של היום</h3>
        <Link href="/calendar"><Button variant="ghost" size="sm">ליומן</Button></Link>
      </div>
      {todays.length ? (
        <div className="mb-8 grid gap-4 grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
          {todays.map((c) => <ContentCard key={c.id} item={c} />)}
        </div>
      ) : (
        <div className="mb-8">
          <EmptyState icon={<SunHorizon />} title="היום עוד ריק" body="הפוסט הבא שלכם מתחיל כאן."
            action={<Link href="/create"><Button variant="primary">יצירת תוכן</Button></Link>} />
        </div>
      )}

      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-2xl font-black">בהמשך השבוע</h3>
        <Link href="/calendar"><Button variant="ghost" size="sm"><Sparkle size={18} weight="fill" aria-hidden />תכנון שבועי</Button></Link>
      </div>
      {upcoming.length ? (
        <div className="mb-8 grid gap-4 grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
          {upcoming.map((c) => <ContentCard key={c.id} item={c} />)}
        </div>
      ) : (
        <div className="mb-8">
          <EmptyState icon={<CalendarPlus />} title="אין תוכן מתוזמן" body="תנו ל-AI לבנות לכם שבוע שלם."
            action={<Link href="/calendar"><Button variant="primary">בניית תוכנית שבועית</Button></Link>} />
        </div>
      )}

      <h3 className="mb-3 font-display text-2xl font-black">תובנות המותג</h3>
      {analysis ? (
        <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
          <Card><Pill tone="ai">טון</Pill><p className="mt-2.5">{analysis.voice}</p></Card>
          {analysis.pillars?.slice(0, 3).map((p) => (
            <Card key={p.name}><strong>{p.name}</strong><p className="mt-1.5 text-sm text-muted">{p.why}</p></Card>
          ))}
        </div>
      ) : (
        <Card><p className="text-muted">עוד לא בוצע ניתוח מותג.</p>
          <Link href="/settings"><Button variant="ghost" size="sm" className="mt-3">להגדרות המותג</Button></Link></Card>
      )}
    </>
  );
}
