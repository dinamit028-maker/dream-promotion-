'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { ContentCard } from '@/features/content/ContentCard';
import { Button, Chip, PageHead } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/feedback';

const FILTERS = [['all', 'הכול'], ['draft', 'טיוטות'], ['scheduled', 'מתוזמן'], ['published', 'פורסם'], ['reel', 'רילס'], ['ad', 'מודעות']] as const;

export default function ContentPage() {
  const content = useApp((s) => s.content);
  const [filter, setFilter] = useState<string>('all');
  const list = content.filter((c) => filter === 'all' || c.status === filter || c.kind === filter);

  return (
    <>
      <PageHead title="ספריית התוכן" sub={`${content.length} פריטים`}
        action={<Link href="/create"><Button variant="primary">+ תוכן חדש</Button></Link>} />
      <div className="mb-6 flex gap-2 overflow-x-auto">
        {FILTERS.map(([k, l]) => <Chip key={k} on={filter === k} onClick={() => setFilter(k)}>{l}</Chip>)}
      </div>
      {list.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(215px,1fr))]">
          {list.map((c) => <ContentCard key={c.id} item={c} />)}
        </div>
      ) : (
        <EmptyState emoji="▦" title="אין כאן עדיין כלום" body="כל מה שתייצרו יישמר כאן, מוכן לעריכה ולתזמון."
          action={<Link href="/create"><Button variant="primary">יצירת התוכן הראשון</Button></Link>} />
      )}
    </>
  );
}
