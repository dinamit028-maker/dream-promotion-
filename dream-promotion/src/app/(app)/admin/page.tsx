'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeaders } from '@/lib/services/http';
import { Button, Card, Chip, Input, PageHead, Textarea } from '@/components/ui/primitives';
import { AdapterNote, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';

/**
 * Internal admin screen — costs, provider health and the provider benchmark.
 * Visible only to ADMIN_EMAILS (checked again by every API it calls). Supplier costs never
 * reach regular users.
 */
type Group = { key: string; cost: number; calls: number; failed: number; unknown: number };
type Report = {
  period: { from: string; to: string };
  summary: {
    today: number; month: number; total: number; reels: number; avgPerReel: number | null; activeUsers: number;
    avgPerUser: number | null; failedCost: number; retryCost: number; unknownPriceCalls: number; benchmarkCost: number; calls: number;
  };
  byType: Group[]; byProvider: Group[]; byModel: Group[]; byQuality: Group[]; byUser: Group[];
  topReels: { contentId: string; title: string; user: string; total: number; video: number; image: number; voice: number; text: number; transcribe: number; render: number; retry: number; calls: number }[];
  health: { provider: string; model: string; type: string; calls: number; succeeded: number; failed: number; running: number; successRate: number | null; avgSeconds: number | null; retries: number; fallbacks: number; spend: number; costPerSuccess: number | null; recentErrors: { at: string; error: string }[] }[];
};

const $ = (n: number | null | undefined, d = 2) => (n == null ? '—' : `$${n.toFixed(n !== 0 && Math.abs(n) < 0.1 ? 4 : d)}`);
const TYPE_HE: Record<string, string> = { video: 'וידאו', image: 'תמונות', voice: 'קול', text: 'טקסט', transcribe: 'תמלול', render: 'רינדור' };

const RANGES = [
  { id: 'today', label: 'היום' }, { id: '7d', label: '7 ימים' }, { id: '30d', label: '30 יום' }, { id: 'month', label: 'החודש' }, { id: 'custom', label: 'טווח' },
] as const;
function rangeDates(id: string, custom: { from: string; to: string }) {
  const now = new Date();
  if (id === 'today') return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), to: now };
  if (id === '7d') return { from: new Date(+now - 7 * 864e5), to: now };
  if (id === '30d') return { from: new Date(+now - 30 * 864e5), to: now };
  if (id === 'custom' && custom.from && custom.to) return { from: new Date(custom.from), to: new Date(`${custom.to}T23:59:59`) };
  return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
}

export default function AdminPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<'costs' | 'health' | 'bench'>('costs');
  const [range, setRange] = useState<string>('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try { const r = await fetch('/api/admin/me', { headers: await authHeaders() }); setAllowed(Boolean((await r.json()).admin)); }
      catch { setAllowed(false); }
    })();
  }, []);

  const load = useCallback(async () => {
    const { from, to } = rangeDates(range, custom);
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/admin/costs?from=${from.toISOString()}&to=${to.toISOString()}`, { headers: await authHeaders() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      setReport(j);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [range, custom]);
  useEffect(() => { if (allowed) void load(); }, [allowed, load]);

  if (allowed === null) return <div className="flex items-center gap-2 text-muted"><Spinner />בודק הרשאה…</div>;
  if (!allowed) return (
    <>
      <PageHead title="ניהול" sub="" />
      <AdapterNote title="אין הרשאה.">המסך הזה למנהלי המערכת בלבד (ADMIN_EMAILS ב-Vercel).</AdapterNote>
    </>
  );

  const s = report?.summary;
  return (
    <>
      <PageHead title="ניהול · עלויות וספקים" sub="פנימי — עלויות ספקים לא מוצגות ללקוחות." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Chip on={tab === 'costs'} onClick={() => setTab('costs')}>עלויות</Chip>
        <Chip on={tab === 'health'} onClick={() => setTab('health')}>מצב הספקים</Chip>
        <Chip on={tab === 'bench'} onClick={() => setTab('bench')}>השוואת ספקים</Chip>
      </div>

      {tab !== 'bench' && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center gap-2">
            {RANGES.map((r) => <Chip key={r.id} on={range === r.id} onClick={() => setRange(r.id)}>{r.label}</Chip>)}
            {range === 'custom' && (
              <span className="flex flex-wrap items-center gap-2">
                <Input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="h-9 w-auto py-1" aria-label="מתאריך" />
                <Input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="h-9 w-auto py-1" aria-label="עד תאריך" />
              </span>
            )}
            <Button size="sm" variant="ghost" onClick={load} disabled={loading}>{loading ? <><Spinner />טוען…</> : 'רענון'}</Button>
          </div>
          {error && <p className="mt-3 text-sm text-warn">{error}</p>}
        </Card>
      )}

      {tab === 'costs' && s && report && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="היום" value={$(s.today)} />
            <Stat label="החודש" value={$(s.month)} />
            <Stat label="בתקופה" value={$(s.total)} sub={`${s.calls} קריאות`} />
            <Stat label="ממוצע לריל" value={$(s.avgPerReel)} sub={`${s.reels} רילים`} strong />
            <Stat label="ממוצע למשתמש פעיל" value={$(s.avgPerUser)} sub={`${s.activeUsers} משתמשים`} />
            <Stat label="עלות כישלונות" value={$(s.failedCost)} />
            <Stat label="עלות ניסיונות חוזרים" value={$(s.retryCost)} />
            <Stat label="השוואות ספקים" value={$(s.benchmarkCost)} />
          </div>
          {s.unknownPriceCalls > 0 && (
            <p className="mt-3 text-sm text-warn">
              {s.unknownPriceCalls} קריאות בלי מחיר (למשל קול, תמלול או רינדור) — הן לא נספרות. הגדירו את המחירים ב-Vercel (VOICE_USD_PER_1K_CHARS, FAL_WHISPER_USD_PER_MIN, RENDER_USD_PER_MINUTE).
            </p>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <GroupTable title="לפי סוג" rows={report.byType} label={(k) => TYPE_HE[k] ?? k} />
            <GroupTable title="לפי ספק" rows={report.byProvider} />
            <GroupTable title="לפי מודל" rows={report.byModel} />
            <GroupTable title="לפי מצב איכות" rows={report.byQuality} />
            <GroupTable title="משתמשים היקרים ביותר" rows={report.byUser} />
          </div>

          <Card className="mt-4">
            <strong className="block">הרילים היקרים ביותר</strong>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-xs text-muted"><tr className="text-start">
                  {['ריל', 'משתמש', 'סה״כ', 'וידאו', 'תמונות', 'קול', 'טקסט', 'רינדור', 'ניסיונות חוזרים'].map((h) => <th key={h} className="px-2 py-1.5 text-start font-semibold">{h}</th>)}
                </tr></thead>
                <tbody>
                  {report.topReels.map((r) => (
                    <tr key={r.contentId} className="border-t border-line">
                      <td className="max-w-[180px] truncate px-2 py-1.5"><a className="text-primary hover:underline" href={`/reels?id=${r.contentId}`}>{r.title}</a></td>
                      <td className="max-w-[140px] truncate px-2 py-1.5" dir="ltr">{r.user}</td>
                      <td className="px-2 py-1.5 font-bold">{$(r.total)}</td>
                      <td className="px-2 py-1.5">{$(r.video)}</td><td className="px-2 py-1.5">{$(r.image)}</td>
                      <td className="px-2 py-1.5">{$(r.voice)}</td><td className="px-2 py-1.5">{$(r.text)}</td>
                      <td className="px-2 py-1.5">{$(r.render)}</td><td className="px-2 py-1.5">{$(r.retry)}</td>
                    </tr>
                  ))}
                  {!report.topReels.length && <tr><td colSpan={9} className="px-2 py-3 text-muted">אין עדיין רילים בתקופה.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {tab === 'health' && report && (
        <Card>
          <strong className="block">אחוז הצלחה, זמן ועלות לתוצאה שימושית — לפי ספק ומודל</strong>
          <p className="mt-1 text-xs text-muted">"עלות לתוצאה מוצלחת" = כל ההוצאה (כולל כישלונות וניסיונות חוזרים) חלקי מספר התוצאות שהצליחו. ספק זול שנכשל הרבה יכול לצאת יקר יותר.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-xs text-muted"><tr>
                {['ספק', 'מודל', 'סוג', 'קריאות', 'הצלחה', 'נכשלו', 'חוזרים / גיבוי', 'זמן ממוצע', 'הוצאה', 'עלות לתוצאה מוצלחת'].map((h) => <th key={h} className="px-2 py-1.5 text-start font-semibold">{h}</th>)}
              </tr></thead>
              <tbody>
                {report.health.map((h) => (
                  <tr key={`${h.provider}${h.model}${h.type}`} className="border-t border-line align-top">
                    <td className="px-2 py-1.5 font-semibold">{h.provider}</td>
                    <td className="max-w-[200px] truncate px-2 py-1.5" dir="ltr">{h.model}</td>
                    <td className="px-2 py-1.5">{TYPE_HE[h.type] ?? h.type}</td>
                    <td className="px-2 py-1.5">{h.calls}</td>
                    <td className={cx('px-2 py-1.5 font-bold', h.successRate != null && h.successRate < 90 ? 'text-warn' : 'text-ok')}>{h.successRate == null ? '—' : `${h.successRate}%`}</td>
                    <td className="px-2 py-1.5">{h.failed}</td>
                    <td className="px-2 py-1.5">{h.retries} / {h.fallbacks}</td>
                    <td className="px-2 py-1.5">{h.avgSeconds == null ? '—' : `${h.avgSeconds} שנ׳`}</td>
                    <td className="px-2 py-1.5" dir="ltr">{$(h.spend)}</td>
                    <td className="px-2 py-1.5 font-bold" dir="ltr">{$(h.costPerSuccess)}</td>
                  </tr>
                ))}
                {!report.health.length && <tr><td colSpan={10} className="px-2 py-3 text-muted">אין קריאות בתקופה.</td></tr>}
              </tbody>
            </table>
          </div>
          {report.health.some((h) => h.recentErrors.length) && (
            <div className="mt-4 grid gap-2">
              <strong className="text-sm">שגיאות אחרונות</strong>
              {report.health.flatMap((h) => h.recentErrors.map((e) => ({ ...e, who: `${h.provider} · ${h.model}` }))).slice(0, 10).map((e, k) => (
                <p key={k} className="rounded-xl bg-surface-2 px-3 py-2 text-xs"><strong>{e.who}</strong> · {new Date(e.at).toLocaleString('he-IL')}<br /><span dir="ltr">{e.error}</span></p>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'bench' && <Benchmark />}
    </>
  );
}

function Stat({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <Card className={cx('p-4', strong && 'ring-2 ring-primary')}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-extrabold tabular-nums" dir="ltr">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </Card>
  );
}

function GroupTable({ title, rows, label }: { title: string; rows: Group[]; label?: (k: string) => string }) {
  const max = Math.max(0.0001, ...rows.map((r) => r.cost));
  return (
    <Card>
      <strong className="block">{title}</strong>
      <div className="mt-3 grid gap-2">
        {rows.slice(0, 12).map((r) => (
          <div key={r.key} className="text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate" dir="auto">{label ? label(r.key) : r.key}</span>
              <span className="shrink-0 tabular-nums"><strong>{$(r.cost)}</strong> <span className="text-xs text-muted">· {r.calls}{r.failed ? ` · ${r.failed} נכשלו` : ''}{r.unknown ? ` · ${r.unknown} בלי מחיר` : ''}</span></span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-primary" style={{ width: `${(r.cost / max) * 100}%` }} /></div>
          </div>
        ))}
        {!rows.length && <p className="text-sm text-muted">אין נתונים בתקופה.</p>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- benchmark --
type BenchRun = { provider: string; ok: boolean; handle?: string; jobId?: string; model?: string; estimate?: number | null; error?: string; startedAt?: number; state?: string; url?: string; seconds?: number };
const PRICE_HINT: Record<string, Record<string, number | null>> = { fal: { '480p': 0.05, '720p': 0.10, '1080p': 0.20 } };

function Benchmark() {
  const [providers, setProviders] = useState<{ id: string; available: boolean }[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('A woman smiles at the camera in a bright beauty clinic, soft window light, slow push-in, 35mm lens.');
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState<'480p' | '720p' | '1080p'>('720p');
  const [confirm, setConfirm] = useState(false);
  const [runs, setRuns] = useState<BenchRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    (async () => {
      const r = await fetch('/api/admin/benchmark', { headers: await authHeaders() });
      const j = await r.json().catch(() => ({}));
      setProviders(j.providers ?? []);
      setChosen((j.providers ?? []).filter((p: any) => p.available).map((p: any) => p.id));
    })();
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const poll = useCallback(async (list: BenchRun[]) => {
    const next = await Promise.all(list.map(async (r) => {
      if (!r.ok || r.state === 'succeeded' || r.state === 'failed') return r;
      const res = await fetch('/api/admin/benchmark', { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ action: 'status', handle: r.handle, jobId: r.jobId }) });
      const st = await res.json().catch(() => ({}));
      const seconds = Math.round((Date.now() - (r.startedAt ?? Date.now())) / 1000);
      if (st.state === 'succeeded') return { ...r, state: 'succeeded', url: st.url, seconds };
      if (st.state === 'failed') return { ...r, state: 'failed', error: st.error, seconds };
      return { ...r, state: st.state ?? r.state, seconds };
    }));
    setRuns(next);
    if (next.every((r) => !r.ok || r.state === 'succeeded' || r.state === 'failed') && timer.current) { clearInterval(timer.current); timer.current = null; }
    return next;
  }, []);

  async function run() {
    setBusy(true); setError(null); setRuns([]);
    try {
      const r = await fetch('/api/admin/benchmark', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ action: 'submit', prompt, duration, resolution, providers: chosen, confirm: true }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      let list: BenchRun[] = j.results.map((x: any) => ({ ...x, state: x.ok ? 'queued' : 'failed' }));
      setRuns(list);
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(async () => { list = await poll(list); }, 8000);
      setConfirm(false);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  const estimate = chosen.reduce((a, id) => a + (PRICE_HINT[id]?.[resolution] ?? 0) * duration, 0);
  return (
    <Card>
      <strong className="block">השוואת ספקי וידאו</strong>
      <p className="mt-1 text-sm text-muted">אותו פרומפט לכל ספק שנבחר — בלי ניסיון חוזר ובלי גיבוי, כדי שההשוואה תהיה הוגנת. כל הרצה נרשמת בעלויות (תחת "השוואות ספקים").</p>
      <div className="mt-4 grid gap-3">
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-[90px]" dir="ltr" aria-label="פרומפט" />
        <div className="flex flex-wrap items-center gap-2">
          {providers.map((p) => (
            <label key={p.id} className={cx('flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm', !p.available && 'opacity-50')}>
              <input type="checkbox" disabled={!p.available} checked={chosen.includes(p.id)} className="h-4 w-4 accent-[var(--primary)]"
                onChange={() => setChosen((c) => (c.includes(p.id) ? c.filter((x) => x !== p.id) : [...c, p.id]))} />
              {p.id}{!p.available && ' · לא מוגדר'}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {[5, 10].map((d) => <Chip key={d} on={duration === d} onClick={() => setDuration(d)}>{d} שנ׳</Chip>)}
          {(['480p', '720p', '1080p'] as const).map((r) => <Chip key={r} on={resolution === r} onClick={() => setResolution(r)}>{r}</Chip>)}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5 h-5 w-5 accent-[var(--primary)]" />
          <span>אני מאשר/ת הוצאה{estimate > 0 ? ` של כ-$${estimate.toFixed(2)}` : ''}{chosen.some((c) => !PRICE_HINT[c]) ? ' (ועוד ספקים שמחירם לא מוגדר)' : ''}.</span>
        </label>
        <div><Button variant="primary" onClick={run} disabled={!confirm || busy || !chosen.length || !prompt.trim()}>{busy ? <><Spinner />שולח…</> : 'הרצת השוואה'}</Button></div>
        {error && <p className="text-sm text-warn">{error}</p>}
      </div>

      {runs.length > 0 && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {runs.map((r, k) => (
            <div key={k} className="rounded-2xl border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <strong>{r.provider}</strong>
                <span className={cx('text-xs font-bold', r.state === 'succeeded' ? 'text-ok' : r.state === 'failed' ? 'text-[var(--danger)]' : 'text-muted')}>
                  {r.state === 'succeeded' ? '✓ הצליח' : r.state === 'failed' ? '✗ נכשל' : <span className="inline-flex items-center gap-1"><Spinner />{r.state === 'queued' ? 'בתור' : 'נוצר'}</span>}
                </span>
              </div>
              {r.model && <p className="mt-1 truncate text-xs text-muted" dir="ltr">{r.model}</p>}
              <p className="mt-1 text-xs">זמן: {r.seconds ?? 0} שנ׳ · עלות משוערת: {r.estimate == null ? 'לא ידועה' : `$${r.estimate.toFixed(2)}`}</p>
              {r.error && <p className="mt-1 text-xs text-[var(--danger)]" dir="ltr">{r.error}</p>}
              {r.url && <video src={r.url} controls playsInline className="mt-2 aspect-[9/16] w-full rounded-xl bg-black object-cover" />}
            </div>
          ))}
        </div>
      )}
      {runs.some((r) => r.url) && <p className="mt-3 text-xs text-muted">קישורי התוצאה זמניים (אצל Alibaba: 24 שעות). להורדה — דרך נגן הווידאו.</p>}
    </Card>
  );
}
