'use client';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { Button, Card, PageHead, Pill } from '@/components/ui/primitives';
import { AdapterNote } from '@/components/ui/feedback';

export default function AnalyticsPage() {
  const { content, media } = useApp();
  const stats: [string, number][] = [
    ['תוכן שנוצר', content.length],
    ['מתוזמן', content.filter((c) => c.status === 'scheduled').length],
    ['פורסם', content.filter((c) => c.status === 'published').length],
    ['קבצי מדיה', media.length],
  ];
  return (
    <>
      <PageHead title="ביצועים" sub="נתוני רשתות אמיתיים דורשים חשבון מחובר" />
      <div className="mb-6 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
        {stats.map(([l, v]) => (
          <Card key={l}>
            <p className="text-sm text-muted">{l}</p>
            <p className="mt-1 font-display text-4xl font-extrabold">{v}</p>
          </Card>
        ))}
      </div>
      <Card>
        <div className="flex items-center justify-between">
          <h3 className="font-display text-xl font-extrabold">חשיפות, מעורבות ועוקבים</h3>
          <Pill tone="warn">לא מחובר</Pill>
        </div>
        <div className="mt-4">
          <AdapterNote>
            כאן ייכנסו נתוני Instagram Graph API ו-Meta Insights. לא מוצגים כאן מספרי דמו שנראים כמו נתונים אמיתיים.
            <div className="mt-3"><Link href="/integrations"><Button size="sm" variant="ghost">למסך החיבורים</Button></Link></div>
          </AdapterNote>
        </div>
      </Card>
    </>
  );
}
