'use client';
import { useState } from 'react';
import { Button, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { checkTerminal, type TerminalInfo } from './checkout';
import { checkTerminalNow, connectTerminal, disconnectTerminal } from './data';
import { Block, Notice, TextRow } from './ui';

type Msg = { tone: 'ok' | 'error' | 'warn' | 'info'; text: string } | null;

/**
 * The business's payment terminal (PayPlus) — one per business: the site's checkout and the payment links (2.88) use the
 * same one. Shown in "מכירה באתר" and in the money settings (a business without a store sends payment links too).
 * The keys go to the server and are sealed there; this block never sees them again — only "מחובר" and 4 characters.
 * "בדיקת חיבור" (2.88): the storefront's server makes a payment page of ₪1 with the keys (nobody pays it) — accepted →
 * "מאומת"; new keys are checked again. A payment link is sent only from a verified terminal.
 */
export function PaymentTerminal({ terminal, error, onChange }: { terminal: TerminalInfo | null; error: string; onChange: (t: TerminalInfo) => void }) {
  const [f, setF] = useState({ apiKey: '', secretKey: '', pageUid: '' });
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const connect = async () => {
    const t = checkTerminal(f);
    if (!t.ok) { setMsg({ tone: 'error', text: t.error }); return; }
    setBusy(true); setMsg(null);
    if (live && !window.confirm('מסוף אמיתי: כל הזמנה באתר תחייב את הקונה באמת, תירשם כמכירה ויופק לה מסמך. להמשיך?')) { setBusy(false); return; }
    const r = await connectTerminal(t.keys.api_key, t.keys.secret_key, t.pageUid, live ? 'live' : 'test');
    setBusy(false);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    setF({ apiKey: '', secretKey: '', pageUid: '' });
    onChange(r.data);
    setMsg({ tone: 'ok', text: 'המסוף נשמר. עכשיו "בדיקת חיבור" — כדי לוודא ש-PayPlus מקבל את המפתחות.' });
  };
  // before migration 4300 the server sends no verifiedAt: nothing to check yet (the block reads as it did)
  const checkable = terminal?.verifiedAt !== undefined;
  const check = async () => {
    setBusy(true); setMsg(null);
    const r = await checkTerminalNow();
    setBusy(false);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    onChange(r.data);
    setMsg({ tone: 'ok', text: 'PayPlus קיבל את המפתחות — המסוף מאומת. אפשר לשלוח לינקים לתשלום.' });
  };
  return (
    <Block title={`מסוף סליקה — PayPlus${terminal?.liveOpen ? '' : ' (סביבת בדיקה)'}`} id="terminal" sub="הקונה מזין את הכרטיס בעמוד של PayPlus, לא אצלנו. PayPlus לא מפיק חשבונית — המסמכים יוצאים מהמערכת.">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {!terminal && !error ? <p className="flex items-center gap-2 text-muted"><Spinner /> בודק…</p> : terminal?.connected ? (
        <div className="stack-y-3">
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            <Pill tone="ok">מחובר</Pill>
            {checkable && (terminal.verifiedAt ? <Pill tone="ok">מאומת</Pill> : <Pill tone="warn">לא נבדק</Pill>)}
            <span className="text-muted">PayPlus · {terminal.mode === 'test' ? 'סביבת בדיקה' : 'אמיתי'} · מפתח שמסתיים ב-<bdi dir="ltr">{terminal.hint}</bdi></span>
          </p>
          <p className="text-xs text-muted">
            {!checkable ? '"מחובר" = המפתחות נשמרו. עוד לא נבדק מול PayPlus — זה קורה בהזמנת הבדיקה הראשונה.'
              : terminal.verifiedAt ? `נבדק מול PayPlus ב-${formatIL(terminal.verifiedAt)}. מפתחות חדשים — בודקים שוב.`
              : '"מחובר" = המפתחות נשמרו. "בדיקת חיבור" יוצרת עמוד תשלום של ₪1 ב-PayPlus (אף אחד לא משלם בו) — כך יודעים שהמפתחות עובדים. לינק לתשלום נשלח רק ממסוף מאומת.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {checkable && <Button variant={terminal.verifiedAt ? 'ghost' : 'primary'} disabled={busy} onClick={() => void check()}>{busy ? <><Spinner /> בודק…</> : 'בדיקת חיבור'}</Button>}
            <Button variant="ghost" disabled={busy} onClick={async () => {
              if (!window.confirm('להסיר את המסוף? המכירה באתר תיכבה, ואי אפשר יהיה לשלוח לינקים לתשלום.')) return;
              setBusy(true); const r = await disconnectTerminal(); setBusy(false);
              if (!r.ok) setMsg({ tone: 'error', text: r.error }); else { onChange(r.data); setMsg({ tone: 'ok', text: 'המסוף הוסר והמכירה באתר כבויה.' }); }
            }}>הסרת המסוף</Button>
          </div>
        </div>
      ) : (
        <form className="stack-y-1" onSubmit={(e) => { e.preventDefault(); void connect(); }} autoComplete="off">
          {terminal && !terminal.ready && <Notice tone="warn">השרת עוד לא מוכן לשמור מפתחות סליקה: צריך להגדיר PAYMENT_SEAL_KEY ב-Vercel (בשני הפרויקטים, אותו ערך).</Notice>}
          {terminal?.liveOpen && (
            <div role="radiogroup" aria-label="סוג המסוף" className="mb-3 flex flex-wrap gap-2">
              {([[false, 'סביבת בדיקה'], [true, 'מסוף אמיתי']] as const).map(([v, t]) => (
                <button key={t} type="button" role="radio" aria-checked={live === v} onClick={() => setLive(v)}
                  className={live === v ? 'min-h-11 rounded-full border border-ink bg-ink px-4 text-sm font-semibold text-white' : 'min-h-11 rounded-full border border-line px-4 text-sm font-semibold'}>{t}</button>
              ))}
            </div>
          )}
          <p className="mb-2 text-sm text-muted">ב-PayPlus ({live ? 'החשבון האמיתי' : 'חשבון הבדיקה'}): הגדרות ← API. מעתיקים לכאן את שלושת הערכים.</p>
          <TextRow label="API key" value={f.apiKey} onChange={(v) => setF((x) => ({ ...x, apiKey: v }))} dir="ltr" />
          <TextRow label="Secret key" value={f.secretKey} onChange={(v) => setF((x) => ({ ...x, secretKey: v }))} dir="ltr" type="password" />
          <TextRow label="Payment page UID" value={f.pageUid} onChange={(v) => setF((x) => ({ ...x, pageUid: v }))} dir="ltr" />
          <Button type="submit" variant="primary" disabled={busy || !f.apiKey || !f.secretKey || !f.pageUid}>{busy ? <><Spinner /> שומר…</> : 'חיבור המסוף'}</Button>
        </form>
      )}
    </Block>
  );
}
