'use client';
import { useEffect, useState } from 'react';
import { ClockView, DEVICE_KEY, Shell } from '@/features/timeclock/ClockView';
import { Spinner } from '@/components/ui/feedback';

/**
 * The QR printed at the business points here: /c/<site>. The phone already knows who the employee is
 * (from the personal link opened once), so scanning shows that employee's clock-in / clock-out button.
 */
export default function ScanPage({ params }: { params: { site: string } }) {
  const [people, setPeople] = useState<{ token: string; name: string }[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    try { const list = JSON.parse(localStorage.getItem(DEVICE_KEY) || '[]'); setPeople(list); if (list.length === 1) setChosen(list[0].token); }
    catch { setPeople([]); }
  }, []);
  if (people === null) return <Shell><div className="flex justify-center py-16"><Spinner /></div></Shell>;
  if (chosen) return <ClockView token={chosen} site={params.site} />;
  if (!people.length) return (
    <Shell>
      <div className="mt-10 rounded-3xl bg-surface-2 p-6 text-center">
        <p className="text-4xl" aria-hidden>🔗</p>
        <h1 className="mt-2 text-xl font-bold">הטלפון הזה עוד לא מחובר לשעון</h1>
        <p className="mt-2 text-sm text-ink-2">פתחו פעם אחת את הקישור האישי שקיבלתם מהמנהל/ת, ואז סרקו את הקוד שוב.</p>
      </div>
    </Shell>
  );
  return (
    <Shell>
      <h1 className="mt-6 text-center text-xl font-bold">מי מחתים/ה?</h1>
      <div className="mt-4 grid gap-2">
        {people.map((p) => <button key={p.token} type="button" onClick={() => setChosen(p.token)} className="rounded-2xl border border-line bg-surface p-4 text-lg font-semibold">{p.name}</button>)}
      </div>
    </Shell>
  );
}
