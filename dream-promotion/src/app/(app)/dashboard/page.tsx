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

export default function Dashboard() {
  const router = useRouter();
  const { brand, content, analysis } = useApp();
  const [prompt, setPrompt] = useState('');
  const todays = content.filter((c) => c.date === today());
  const upcoming = content.filter((c) => c.date && c.date > today()).sort((a, b) => a.date!.localeCompare(b.date!)).slice(0, 6);

  return (
    <>
      <div className="mb-6">
        <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-5xl">
          {greeting()}{brand.name ? `, ${brand.name.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-1.5 text-lg text-muted">מה ניצור היום?</p>
      </div>

      <div className="mb-8 rounded-lg bg-brand-soft p-4">
        <Textarea className="min-h-[74px] bg-surface" value={prompt} onChange={(e) => setPrompt(e.target.value)}
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

      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-xl font-extrabold">התוכן של היום</h3>
        <Link href="/calendar"><Button variant="ghost" size="sm">ליומן</Button></Link>
      </div>
      {todays.length ? (
        <div className="mb-8 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
          {todays.map((c) => <ContentCard key={c.id} item={c} />)}
        </div>
      ) : (
        <div className="mb-8">
          <EmptyState icon={<SunHorizon />} title="היום עוד ריק" body="הפוסט הבא שלכם מתחיל כאן."
            action={<Link href="/create"><Button variant="primary">יצירת תוכן</Button></Link>} />
        </div>
      )}

      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-xl font-extrabold">בהמשך השבוע</h3>
        <Link href="/calendar"><Button variant="ghost" size="sm"><Sparkle size={18} weight="fill" aria-hidden />תכנון שבועי</Button></Link>
      </div>
      {upcoming.length ? (
        <div className="mb-8 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
          {upcoming.map((c) => <ContentCard key={c.id} item={c} />)}
        </div>
      ) : (
        <div className="mb-8">
          <EmptyState icon={<CalendarPlus />} title="אין תוכן מתוזמן" body="תנו ל-AI לבנות לכם שבוע שלם."
            action={<Link href="/calendar"><Button variant="primary">בניית תוכנית שבועית</Button></Link>} />
        </div>
      )}

      <h3 className="mb-3 font-display text-xl font-extrabold">תובנות המותג</h3>
      {analysis ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
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
