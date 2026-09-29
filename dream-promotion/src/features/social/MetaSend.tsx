'use client';
import { useEffect, useState } from 'react';
import { SocialService, type SocialAccount } from '@/lib/services/social.service';
import { useApp } from '@/lib/store';
import { Button, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';

/**
 * Publish a library image or video to a connected Facebook Page or Instagram account.
 * Only accounts connected for publishing are offered; "read only" connections never appear here.
 */
export function MetaSend({
  open, onClose, mediaId, caption: initialCaption,
}: { open: boolean; onClose: () => void; mediaId: string | null; caption: string }) {
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [target, setTarget] = useState<'feed' | 'story'>('feed');
  const [caption, setCaption] = useState(initialCaption);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const media = useApp((s) => s.media.find((m) => m.id === mediaId));

  useEffect(() => {
    if (!open) return;
    setCaption(initialCaption); setStatus(null); setError(null); setDone(false); setAccounts(null); setTarget('feed');
    SocialService.accounts()
      .then((r) => {
        const list = r.accounts.filter((a) => (a.provider === 'instagram' || a.provider === 'facebook') && !a.readOnly);
        setAccounts(list); setAccountId(list[0]?.id ?? null);
      })
      .catch((e) => { setAccounts([]); setError(e.message); });
  }, [open, initialCaption]);

  const account = accounts?.find((a) => a.id === accountId);
  const isIg = account?.provider === 'instagram';
  const isVideo = media?.kind === 'video';

  async function send() {
    if (!accountId || !mediaId) return;
    setBusy(true); setError(null); setDone(false);
    setStatus(isIg ? 'אינסטגרם מקבלת את הקובץ…' : 'מפרסם בעמוד…');
    try {
      const r = await SocialService.sendToMeta(accountId, mediaId, caption, isIg ? target : 'feed');
      if (r.state === 'published') { setDone(true); setStatus('פורסם בעמוד הפייסבוק.'); return; }
      // Instagram processes videos for a while; check every 5 seconds for up to ~3 minutes
      for (let i = 0; i < 36; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        const s = await SocialService.metaStatus(accountId, r.containerId!).catch(() => null);
        if (!s) continue;
        if (s.state === 'published') { setDone(true); setStatus(target === 'story' ? 'הסטורי עלה לאינסטגרם.' : 'פורסם באינסטגרם.'); return; }
        if (s.state === 'failed') throw new Error(s.reason || 'אינסטגרם לא קיבלה את הקובץ.');
        setStatus(isVideo ? 'אינסטגרם מעבדת את הסרטון… זה יכול לקחת כמה דקות.' : 'אינסטגרם מעבדת את התמונה…');
      }
      throw new Error('העיבוד באינסטגרם לוקח יותר מהרגיל. בדקו באפליקציה בעוד כמה דקות.');
    } catch (e: any) {
      setStatus(null);
      const m = String(e?.message ?? '');
      setError(
        /reconnect_required/.test(m) ? 'החיבור ל-Meta פג. חברו מחדש במסך החיבורים.'
          : /read_only/.test(m) ? 'החשבון הזה מחובר למשיכה בלבד.'
          : /permission_denied/.test(m) ? 'לחשבון אין הרשאת פרסום. חברו מחדש עם "חיבור לפרסום ומשיכה".'
          : `הפרסום נכשל: ${m}`,
      );
    } finally { setBusy(false); }
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
          <div className="mb-4 flex flex-wrap gap-2">
            {accounts.map((a) => (
              <button key={a.id} type="button" onClick={() => setAccountId(a.id)} disabled={busy}
                className={cx('flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm', a.id === accountId ? 'border-primary bg-primary-soft' : 'border-line')}>
                {a.avatar && <img src={a.avatar} alt="" className="h-6 w-6 rounded-full" />}
                <span className="text-muted">{a.provider === 'instagram' ? 'IG' : 'FB'}</span>{a.name}
              </button>
            ))}
          </div>

          {isIg && (
            <div className="mb-4 flex gap-2" role="radiogroup" aria-label="סוג הפרסום">
              {([['feed', isVideo ? 'רילס' : 'פוסט'], ['story', 'סטורי']] as const).map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={target === id} disabled={busy} onClick={() => setTarget(id)}
                  className={cx('rounded-full border px-4 py-1.5 text-sm font-semibold', target === id ? 'border-primary bg-primary-soft text-ink' : 'border-line text-ink-2')}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {!(isIg && target === 'story') && (
            <label className="mb-4 block text-sm">
              <span className="mb-1 block font-semibold">הטקסט לפוסט</span>
              <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} className="min-h-[110px]" disabled={busy} />
            </label>
          )}
          {isIg && target === 'story' && <p className="mb-4 text-sm text-muted">בסטורי אין טקסט מתחת לתמונה. אם צריך טקסט, הוא צריך להיות חלק מהתמונה או מהסרטון.</p>}

          {status && !error && <p className={cx('mb-3 flex items-center gap-2 text-sm', done && 'text-ok')}>{!done && <Spinner />}{status}</p>}
          {error && <p className="mb-3 text-sm text-[var(--danger)]">{error}</p>}

          <div className="flex gap-3">
            {done ? <Button variant="primary" onClick={onClose}>סגירה</Button> : (
              <Button variant="primary" onClick={send} disabled={busy || !accountId || !mediaId || media?.kind === 'audio'}>
                {busy ? <><Spinner />מפרסם…</> : 'פרסום עכשיו'}
              </Button>
            )}
          </div>
          {!mediaId && <p className="mt-3 text-xs text-muted">אין קובץ לפרסום. בחרו תמונה או סרטון.</p>}
        </>
      )}
    </Modal>
  );
}
