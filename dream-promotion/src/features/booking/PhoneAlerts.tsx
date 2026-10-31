'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/feedback';
import { enablePush, needsHomeScreen, pushKeyReady, pushSupported, sendTest } from '@/features/register/notifications';
import { SOON_MINUTES, TOMORROW_FROM } from './alerts';

/**
 * "🔔 התראות בטלפון" of the calendar (2.112): this device gets the person's notifications — SOON_MINUTES before each of their
 * appointments (the owners: of every appointment), and at TOMORROW_FROM the day before, "מחר X תורים — לשלוח תזכורות".
 * An iPhone shows notifications only from the app on the home screen (iOS 16.4+) — the screen says how, step by step.
 */
export function PhoneAlerts({ open, onClose, userId }: { open: boolean; onClose: () => void; userId: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const homeFirst = typeof window !== 'undefined' && needsHomeScreen();
  return (
    <Modal open={open} onClose={onClose}>
      <h3 className="mb-2 font-display text-xl font-extrabold">🔔 התראות בטלפון</h3>
      <ul className="mb-4 grid gap-1.5 text-sm text-ink-2">
        <li>⏰ <strong>{SOON_MINUTES} דקות לפני כל תור</strong> — למטפלת של התור ולבעלי העסק: להכין את הקליניקה.</li>
        <li>📅 <strong>ב-{TOMORROW_FROM} ביום שלפני</strong> — "מחר X תורים": לחיצה פותחת רשימה עם תזכורת בוואטסאפ לכל לקוח/ה.</li>
      </ul>
      {homeFirst ? (
        <div className="mb-4 rounded-2xl bg-amber-500/15 p-3 text-sm">
          <p className="mb-1 font-bold">באייפון — קודם מוסיפים את האפליקציה למסך הבית:</p>
          <ol className="list-inside list-decimal">
            <li>ב-Safari: כפתור השיתוף (ריבוע עם חץ למעלה)</li>
            <li>"הוספה למסך הבית" ← "הוספה"</li>
            <li>פותחים את Dream מהאייקון במסך הבית, נכנסים לתורים ← 🔔, ולוחצים "הפעלה"</li>
          </ol>
        </div>
      ) : !pushSupported() ? (
        <p className="mb-4 text-sm text-warn">הדפדפן הזה לא תומך בהתראות. בטלפון — Chrome (אנדרואיד) או האפליקציה ממסך הבית (אייפון).</p>
      ) : !pushKeyReady() ? (
        <p className="mb-4 text-sm text-warn">ההתראות עוד לא מוגדרות במערכת (חסרים מפתחות ב-Vercel).</p>
      ) : null}
      {msg && <p className="mb-3 rounded-2xl bg-surface-2 p-3 text-sm">{msg}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || homeFirst} onClick={async () => { setBusy(true); const r = await enablePush(userId); setMsg(r.message); setBusy(false); }}>
          הפעלה במכשיר הזה</Button>
        <Button variant="ghost" disabled={busy} onClick={async () => setMsg(await sendTest('calendar'))}>התראת ניסיון</Button>
        <Button variant="ghost" onClick={onClose}>סגירה</Button>
      </div>
      <p className="mt-3 text-xs text-muted">כל מכשיר מופעל פעם אחת. אפשר להפעיל בכמה טלפונים.</p>
    </Modal>
  );
}
