'use client';
import { useEffect, useState } from 'react';
import { SocialService, type SocialAccount } from '@/lib/services/social.service';
import { useApp } from '@/lib/store';
import { Button, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';

type Result = { state: 'waiting' | 'working' | 'done' | 'failed'; text: string };

function errorText(m: string) {
  return /reconnect_required/.test(m) ? `החיבור ל-Meta פג. חברו מחדש במסך החיבורים.${m.split('reconnect_required:')[1]?.trim() ? ` (Meta: ${m.split('reconnect_required:')[1].trim()})` : ''}`
    : /read_only/.test(m) ? 'החשבון הזה מחובר למשיכה בלבד.'
    : /permission_denied/.test(m) ? 'אין הרשאת פרסום. חברו מחדש עם "חיבור לפרסום ומשיכה".'
    : m;
}

/**
 * Publish a library image or video to Instagram and the Facebook Page — one or several at once.
 * Each destination gets its own status line, so a failure on one never hides behind the other.
 * Only accounts connected for publishing are offered; "read only" connections never appear here.
 */
export function MetaSend({
  open, onClose, mediaId, caption: initialCaption,
}: { open: boolean; onClose: () => void; mediaId: string | null; caption: string }) {
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [target, setTarget] = useState<'feed' | 'story'>('feed');
  const [caption, setCaption] = useState(initialCaption);
  const [cover, setCover] = useState(0.5);
  const [videoLen, setVideoLen] = useState(0);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [error, setError] = useState<string | null>(null);
  const media = useApp((s) => s.media.find((m) => m.id === mediaId));

  useEffect(() => {
    if (!open) return;
    setCaption(initialCaption); setResults({}); setError(null); setAccounts(null); setTarget('feed'); setCover(0.5);
    SocialService.accounts()
      .then((r) => {
        const list = r.accounts.filter((a) => (a.provider === 'instagram' || a.provider === 'facebook') && !a.readOnly);
        setAccounts(list);
        // default: every connected destination (Instagram + the Facebook Page)
        setChosen(list.map((a) => a.id));
      })
      .catch((e) => { setAccounts([]); setError(e.message); });
  }, [open, initialCaption]);

  const isVideo = media?.kind === 'video';
  const picked = (accounts ?? []).filter((a) => chosen.includes(a.id));
  const anyIg = picked.some((a) => a.provider === 'instagram');
  const onlyStory = anyIg && target === 'story';
  const allDone = picked.length > 0 && picked.every((a) => results[a.id]?.state === 'done');
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const put = (id: string, r: Result) => setResults((all) => ({ ...all, [id]: r }));

  async function sendOne(a: SocialAccount) {
    const isIg = a.provider === 'instagram';
    put(a.id, { state: 'working', text: isIg ? 'אינסטגרם מקבלת את הקובץ…' : 'מפרסם בעמוד…' });
    try {
      const r = await SocialService.sendToMeta(a.id, mediaId!, caption, isIg ? target : 'feed', isVideo ? Math.round(cover * 1000) : undefined);
      if (r.state === 'published') { put(a.id, { state: 'done', text: 'פורסם בעמוד הפייסבוק.' }); return; }
      // Instagram processes videos for a while; check every 5 seconds for up to ~4 minutes
      for (let i = 0; i < 48; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        const s = await SocialService.metaStatus(a.id, r.containerId!).catch(() => null);
        if (!s) continue;
        if (s.state === 'published') { put(a.id, { state: 'done', text: target === 'story' ? 'הסטורי עלה.' : 'פורסם באינסטגרם.' }); return; }
        if (s.state === 'failed') throw new Error(s.reason || 'אינסטגרם לא קיבלה את הקובץ.');
        put(a.id, { state: 'working', text: isVideo ? 'אינסטגרם מעבדת את הסרטון… זה יכול לקחת כמה דקות.' : 'אינסטגרם מעבדת את התמונה…' });
      }
      throw new Error('העיבוד באינסטגרם לוקח יותר מהרגיל. בדקו באפליקציה בעוד כמה דקות.');
    } catch (e: any) {
      put(a.id, { state: 'failed', text: errorText(String(e?.message ?? e)) });
    }
  }

  async function send() {
    if (!mediaId || !picked.length) return;
    setBusy(true); setError(null);
    const todo = picked.filter((a) => results[a.id]?.state !== 'done'); // a retry never posts twice where it already worked
    todo.forEach((a) => put(a.id, { state: 'waiting', text: 'ממתין…' }));
    await Promise.all(todo.map(sendOne));
    setBusy(false);
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-display text-xl font-extrabold">פרסום באינסטגרם ובפייסבוק</h3>
        <CloseButton onClick={() => !busy && onClose()} />
      </div>

      {accounts === null ? <Spinner /> : accounts.length === 0 ? (
        <div className="rounded-2xl bg-surface-2 p-4 text-sm">
          <p className="mb-3">{error ?? 'אין עדיין חשבון שמחובר לפרסום.'}</p>
          <a href="/integrations"><Button variant="primary" size="sm">לחיבור Instagram ו-Facebook</Button></a>
        </div>
      ) : (
        <>
          <p className="mb-2 text-sm font-semibold">לאן לפרסם</p>
          <div className="mb-4 grid gap-2">
            {accounts.map((a) => {
              const r = results[a.id];
              return (
                <label key={a.id} className={cx('flex cursor-pointer items-center gap-3 rounded-2xl border px-3 py-2 text-sm', chosen.includes(a.id) ? 'border-primary bg-primary-soft' : 'border-line')}>
                  <input type="checkbox" className="h-5 w-5 accent-(--primary)" checked={chosen.includes(a.id)} disabled={busy} onChange={() => toggle(a.id)} />
                  {a.avatar && <img src={a.avatar} alt="" className="h-7 w-7 rounded-full" />}
                  <span className="min-w-0 flex-1">
                    <span className="text-muted">{a.provider === 'instagram' ? 'Instagram' : 'Facebook'} · </span>{a.name}
                    {r && (
                      <span className={cx('mt-0.5 flex items-center gap-1.5 text-xs', r.state === 'done' ? 'text-ok' : r.state === 'failed' ? 'text-(--danger)' : 'text-muted')}>
                        {(r.state === 'working' || r.state === 'waiting') && <Spinner />}{r.state === 'done' ? '✓ ' : r.state === 'failed' ? '✗ ' : ''}{r.text}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>

          {anyIg && (
            <div className="mb-4 flex gap-2" role="radiogroup" aria-label="סוג הפרסום באינסטגרם">
              {([['feed', isVideo ? 'רילס' : 'פוסט'], ['story', 'סטורי']] as const).map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={target === id} disabled={busy} onClick={() => setTarget(id)}
                  className={cx('rounded-full border px-4 py-1.5 text-sm font-semibold', target === id ? 'border-primary bg-primary-soft text-ink' : 'border-line text-ink-2')}>
                  {label}
                </button>
              ))}
              <span className="self-center text-xs text-muted">באינסטגרם</span>
            </div>
          )}

          {isVideo && anyIg && target === 'feed' && media && (
            <div className="mb-4 rounded-2xl bg-surface-2 p-3">
              <p className="mb-2 text-sm font-semibold">תמונת השער של הרילס</p>
              <div className="flex items-center gap-3">
                <video key={`${media.url}-${cover}`} src={`${media.url}#t=${cover}`} preload="metadata" muted playsInline
                  onLoadedMetadata={(e) => setVideoLen(e.currentTarget.duration || 0)}
                  className="aspect-9/16 w-20 shrink-0 rounded-lg bg-black object-cover" />
                <label className="flex-1 text-sm">
                  מהשנייה <strong>{cover.toFixed(1)}</strong>
                  <input type="range" min={0} max={Math.max(0.5, videoLen - 0.1)} step={0.1} value={cover} disabled={busy}
                    onChange={(e) => setCover(+e.target.value)} className="mt-1 w-full accent-(--primary)" />
                </label>
              </div>
            </div>
          )}

          {!onlyStory || picked.some((a) => a.provider === 'facebook') ? (
            <label className="mb-4 block text-sm">
              <span className="mb-1 block font-semibold">הטקסט לפוסט</span>
              <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} className="min-h-[110px]" disabled={busy} />
            </label>
          ) : null}
          {onlyStory && <p className="mb-4 text-sm text-muted">בסטורי באינסטגרם אין טקסט מתחת לתמונה. אם צריך טקסט, הוא צריך להיות חלק מהתמונה או מהסרטון.</p>}
          {error && <p className="mb-3 text-sm text-(--danger)">{error}</p>}

          <div className="flex gap-3">
            {allDone ? <Button variant="primary" onClick={onClose}>סגירה</Button> : (
              <Button variant="primary" onClick={send} disabled={busy || !picked.length || !mediaId || media?.kind === 'audio'}>
                {busy ? <><Spinner />מפרסם…</> : Object.values(results).some((r) => r.state === 'failed') ? 'ניסיון חוזר' : `פרסום עכשיו${picked.length > 1 ? ` (${picked.length})` : ''}`}
              </Button>
            )}
          </div>
          {!mediaId && <p className="mt-3 text-xs text-muted">אין קובץ לפרסום. בחרו תמונה או סרטון.</p>}
        </>
      )}
    </Modal>
  );
}
