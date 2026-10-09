'use client';
import { useEffect, useState } from 'react';
import { SocialService, type SocialAccount } from '@/lib/services/social.service';
import { Button } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';

const STATUS_HE: Record<string, string> = {
  PROCESSING_UPLOAD: 'TikTok מעבד את הסרטון…',
  SEND_TO_USER_INBOX: 'נשלח! הסרטון מחכה בהתראות של אפליקציית TikTok.',
  PUBLISH_COMPLETE: 'פורסם ב-TikTok.',
  FAILED: 'TikTok דחה את הסרטון.',
};

/**
 * "Send to TikTok": uploads a library video to the creator's TikTok inbox.
 * The caption is copied for pasting — TikTok's upload mode does not take text for videos.
 */
export function TikTokSend({
  open, onClose, mediaId, contentId, caption,
}: { open: boolean; onClose: () => void; mediaId: string | null; contentId?: string | null; caption: string }) {
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStatus(null); setError(null); setCopied(false); setAccounts(null);
    SocialService.accounts()
      .then((r) => {
        const tt = r.accounts.filter((a) => a.provider === 'tiktok');
        setAccounts(tt); setAccountId(tt[0]?.id ?? null);
      })
      .catch((e) => { setAccounts([]); setError(e.message); });
  }, [open]);

  async function copy() {
    try { await navigator.clipboard.writeText(caption); setCopied(true); } catch { /* ignore */ }
  }

  async function send() {
    if (!accountId || !mediaId) return;
    setBusy(true); setError(null); setStatus('PROCESSING_UPLOAD');
    try {
      await copy();
      const { publishId, postId } = await SocialService.sendToTikTok(accountId, mediaId, contentId);
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await SocialService.tiktokStatus(accountId, publishId, postId).catch(() => null);
        if (!s) continue;
        setStatus(s.status);
        if (s.status === 'FAILED') { setError(s.failReason || 'TikTok לא קיבל את הסרטון.'); break; }
        if (s.status !== 'PROCESSING_UPLOAD') break;
      }
    } catch (e: any) {
      setStatus(null);
      const m = String(e?.message ?? '');
      setError(
        /reconnect_required|access_token_invalid/.test(m) ? 'החיבור ל-TikTok פג. חברו מחדש במסך החיבורים.'
          : /spam_risk_too_many_pending_share/.test(m) ? 'TikTok מגביל ל-5 טיוטות ממתינות ביום. פרסמו או מחקו טיוטות באפליקציה ונסו שוב.'
          : /spam_risk|rate_limit/.test(m) ? 'TikTok מגביל כרגע את קצב השליחה. נסו שוב מאוחר יותר.'
          : /scope_not_authorized/.test(m) ? 'לחשבון אין הרשאת העלאה. חברו מחדש ואשרו את ההרשאה.'
          : `השליחה נכשלה: ${m}`,
      );
    } finally { setBusy(false); }
  }

  const done = status === 'SEND_TO_USER_INBOX' || status === 'PUBLISH_COMPLETE';

  return (
    <Modal open={open} onClose={() => !busy && onClose()}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-display text-xl font-extrabold">שליחה ל-TikTok</h3>
        <CloseButton onClick={() => !busy && onClose()} />
      </div>

      {accounts === null ? <Spinner /> : accounts.length === 0 ? (
        <div className="rounded-2xl bg-surface-2 p-4 text-sm">
          <p className="mb-3">{error ? error : 'אין עדיין חשבון TikTok מחובר.'}</p>
          <a href="/integrations"><Button variant="primary" size="sm">לחיבור TikTok</Button></a>
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">
            הסרטון יישלח לחשבון ה-TikTok ויופיע בהתראות (Inbox) באפליקציה. משם לוחצים עליו, מדביקים את הטקסט, בוחרים מוזיקה אם רוצים, ומפרסמים.
          </p>
          {accounts.length > 1 ? (
            <div className="mb-4 flex flex-wrap gap-2">
              {accounts.map((a) => (
                <button key={a.id} type="button" onClick={() => setAccountId(a.id)}
                  className={cx('flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm', a.id === accountId ? 'border-primary bg-primary/10' : 'border-line')}>
                  {a.avatar && <img src={a.avatar} alt="" className="h-6 w-6 rounded-full" />}{a.name || 'TikTok'}
                </button>
              ))}
            </div>
          ) : (
            <p className="mb-4 flex items-center gap-2 text-sm">
              {accounts[0].avatar && <img src={accounts[0].avatar} alt="" className="h-7 w-7 rounded-full" />}
              <strong>{accounts[0].name || 'חשבון TikTok'}</strong>
            </p>
          )}
          <div className="mb-4 rounded-2xl bg-surface-2 p-3 text-sm">
            <div className="mb-1 flex items-center justify-between">
              <strong>הטקסט לפוסט</strong>
              <button type="button" className="text-xs font-semibold text-primary" onClick={copy}>{copied ? 'הועתק ✓' : 'העתקה'}</button>
            </div>
            <p className="line-clamp-4 whitespace-pre-line text-ink-2">{caption || '—'}</p>
          </div>
          {status && !error && (
            <p className={cx('mb-3 flex items-center gap-2 text-sm', done ? 'text-ok' : '')}>
              {!done && <Spinner />}{STATUS_HE[status] ?? status}
            </p>
          )}
          {error && <p className="mb-3 text-sm text-(--danger)">{error}</p>}
          <div className="flex gap-3">
            {done ? <Button variant="primary" onClick={onClose}>סגירה</Button> : (
              <Button variant="primary" onClick={send} disabled={busy || !accountId || !mediaId}>
                {busy ? <><Spinner />שולח…</> : 'שליחה לטיוטות TikTok'}
              </Button>
            )}
          </div>
          {!mediaId && <p className="mt-3 text-xs text-muted">אין סרטון מוכן לשליחה.</p>}
        </>
      )}
    </Modal>
  );
}
