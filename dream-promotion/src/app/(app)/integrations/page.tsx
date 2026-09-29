'use client';
import { useEffect, useState } from 'react';
import { SocialService, type SocialAccount } from '@/lib/services/social.service';
import { Button, Card, PageHead, Pill } from '@/components/ui/primitives';
import { AdapterNote, IntegrationDialog, Spinner } from '@/components/ui/feedback';

const REASONS: Record<string, string> = {
  access_denied: 'החיבור בוטל ב-TikTok.',
  expired: 'עבר יותר מדי זמן. נסו שוב.',
};

const META_REASONS: Record<string, string> = {
  access_denied: 'החיבור בוטל בפייסבוק.',
  user_denied: 'החיבור בוטל בפייסבוק.',
  expired: 'עבר יותר מדי זמן. נסו שוב.',
  no_pages: 'לא נבחר אף עמוד. בחלון של פייסבוק סמנו את העמוד ואת חשבון האינסטגרם שלו.',
};

export default function IntegrationsPage() {
  const [dialog, setDialog] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [configured, setConfigured] = useState<{ tiktok: boolean; meta?: boolean }>({ tiktok: true, meta: true });
  const [metaBusy, setMetaBusy] = useState<'full' | 'read' | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmOff, setConfirmOff] = useState<string | null>(null);

  async function load() {
    try {
      const r = await SocialService.accounts();
      setAccounts(r.accounts); setConfigured(r.configured);
    } catch (e: any) { setAccounts([]); setNotice({ ok: false, text: e.message }); }
  }

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('tiktok') === 'connected') setNotice({ ok: true, text: 'חשבון TikTok חובר בהצלחה.' });
    if (q.get('tiktok') === 'error') {
      const r = q.get('reason') || '';
      setNotice({ ok: false, text: `החיבור ל-TikTok לא הושלם. ${REASONS[r] ?? r}` });
    }
    if (q.get('meta') === 'connected') {
      setNotice({ ok: true, text: q.get('mode') === 'read' ? 'החשבון חובר למשיכה בלבד. אפשר לייבא ממנו סטוריז, בלי אפשרות לפרסם.' : 'Instagram ו-Facebook חוברו בהצלחה.' });
    }
    if (q.get('meta') === 'error') {
      const r = q.get('reason') || '';
      setNotice({ ok: false, text: `החיבור ל-Meta לא הושלם. ${META_REASONS[r] ?? r}` });
    }
    if (q.get('tiktok') || q.get('meta')) history.replaceState(null, '', '/integrations');
    load();
  }, []);

  async function connect() {
    setBusy(true); setNotice(null);
    try { await SocialService.connectTikTok(); }
    catch (e: any) {
      setBusy(false);
      setNotice({ ok: false, text: e.code === 'not_configured' ? 'מפתחות TikTok עוד לא הוגדרו בשרת (TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET ב-Vercel).' : e.message });
    }
  }
  async function connectMeta(mode: 'full' | 'read') {
    setMetaBusy(mode); setNotice(null);
    try { await SocialService.connectMeta(mode); }
    catch (e: any) {
      setMetaBusy(null);
      setNotice({ ok: false, text: e.code === 'not_configured' ? 'מפתחות Meta עוד לא הוגדרו בשרת (META_APP_ID, META_APP_SECRET, META_CONFIG_FULL ב-Vercel).' : e.message });
    }
  }
  async function importNow(id: string) {
    setImporting(id); setNotice(null);
    try {
      const r = await SocialService.importStories(id);
      const parts = [`נוספו ${r.added.length} סטוריז לספריית המדיה.`];
      if (r.already) parts.push(`${r.already} כבר היו שמורים.`);
      if (r.noFile) parts.push(`${r.noFile} לא ניתנים להורדה (מוזיקה מספריית אינסטגרם).`);
      if (!r.live) parts.splice(0, parts.length, 'אין כרגע סטוריז פעילים בחשבון (אינסטגרם מחזירה רק סטוריז מ-24 השעות האחרונות).');
      setNotice({ ok: !r.errors.length, text: r.errors.length ? `הייבוא נכשל: ${r.errors[0]}` : parts.join(' ') });
    } catch (e: any) { setNotice({ ok: false, text: e.message }); }
    finally { setImporting(null); }
  }
  async function disconnect(id: string) {
    await SocialService.disconnect(id).catch((e) => setNotice({ ok: false, text: e.message }));
    setConfirmOff(null); load();
  }

  const tiktok = (accounts ?? []).filter((a) => a.provider === 'tiktok');
  const meta = (accounts ?? []).filter((a) => a.provider === 'instagram' || a.provider === 'facebook');

  return (
    <>
      <PageHead title="חיבורים" sub="כל חיבור נעשה דרך אישור אמיתי אצל הרשת. הסיסמאות והמפתחות לא עוברים דרכנו." />
      {notice && (
        <p className={`mb-5 rounded-2xl p-3 text-sm ${notice.ok ? 'bg-[var(--ok-soft,#e8f7ee)]' : 'bg-[var(--danger-soft,#fdecec)] text-[var(--danger)]'}`}>{notice.text}</p>
      )}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
        <Card>
          <div className="flex items-center justify-between">
            <strong className="text-[17px]">TikTok</strong>
            {accounts === null ? <Spinner /> : tiktok.length ? <Pill tone="ok">מחובר</Pill> : <Pill tone="warn">לא מחובר</Pill>}
          </div>
          <p className="my-2.5 text-sm text-muted">שליחת רילים לטיוטות ב-TikTok. מסיימים ומפרסמים באפליקציה.</p>
          {tiktok.map((a) => (
            <div key={a.id} className="mb-2 flex items-center gap-2 rounded-xl bg-surface-2 p-2 text-sm">
              {a.avatar ? <img src={a.avatar} alt="" className="h-8 w-8 rounded-full" /> : <span className="h-8 w-8 rounded-full bg-line" />}
              <span className="flex-1 truncate">{a.name || 'חשבון TikTok'}{a.needsReconnect && <span className="text-[var(--danger)]"> · צריך לחבר מחדש</span>}</span>
              {confirmOff === a.id
                ? <button type="button" className="text-xs font-semibold text-[var(--danger)]" onClick={() => disconnect(a.id)}>בטוח?</button>
                : <button type="button" className="text-xs text-muted hover:underline" onClick={() => setConfirmOff(a.id)}>ניתוק</button>}
            </div>
          ))}
          <Button variant={tiktok.length ? 'ghost' : 'primary'} size="sm" onClick={connect} disabled={busy || !configured.tiktok}>
            {busy ? <><Spinner />מעביר ל-TikTok…</> : tiktok.length ? 'חיבור חשבון נוסף' : 'חיבור TikTok'}
          </Button>
          {!configured.tiktok && <p className="mt-2 text-xs text-muted">ממתין למפתחות TikTok בשרת.</p>}
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <strong className="text-[17px]">Instagram ו-Facebook</strong>
            {accounts === null ? <Spinner /> : meta.length ? <Pill tone="ok">מחובר</Pill> : <Pill tone="warn">לא מחובר</Pill>}
          </div>
          <p className="my-2.5 text-sm text-muted">פרסום לעמוד ולאינסטגרם, ומשיכת הסטוריז שלכם לספריית המדיה.</p>
          {meta.map((a) => (
            <div key={a.id} className="mb-2 rounded-xl bg-surface-2 p-2 text-sm">
              <div className="flex items-center gap-2">
                {a.avatar ? <img src={a.avatar} alt="" className="h-8 w-8 rounded-full" /> : <span className="h-8 w-8 rounded-full bg-line" />}
                <span className="flex-1 truncate">
                  <span className="text-muted">{a.provider === 'instagram' ? 'Instagram' : 'Facebook'} · </span>{a.name}
                  {a.readOnly && <span className="text-muted"> · משיכה בלבד</span>}
                </span>
                {confirmOff === a.id
                  ? <button type="button" className="text-xs font-semibold text-[var(--danger)]" onClick={() => disconnect(a.id)}>בטוח?</button>
                  : <button type="button" className="text-xs text-muted hover:underline" onClick={() => setConfirmOff(a.id)}>ניתוק</button>}
              </div>
              {a.provider === 'instagram' && (
                <button type="button" className="mt-1.5 text-xs font-semibold text-primary disabled:opacity-60" disabled={!!importing} onClick={() => importNow(a.id)}>
                  {importing === a.id ? 'מייבא סטוריז…' : 'ייבוא הסטוריז הפעילים לספריית המדיה'}
                </button>
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button variant={meta.length ? 'ghost' : 'primary'} size="sm" onClick={() => connectMeta('full')} disabled={!!metaBusy || configured.meta === false}>
              {metaBusy === 'full' ? <><Spinner />מעביר לפייסבוק…</> : 'חיבור לפרסום ומשיכה'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => connectMeta('read')} disabled={!!metaBusy || configured.meta === false}>
              {metaBusy === 'read' ? <><Spinner />מעביר לפייסבוק…</> : 'חיבור למשיכה בלבד'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">בחלון של פייסבוק מסמנים רק את העמודים שרוצים לחבר. "משיכה בלבד" לא מאפשר פרסום בכלל.</p>
          {configured.meta === false && <p className="mt-1 text-xs text-muted">ממתין למפתחות Meta בשרת.</p>}
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <strong className="text-[17px]">WhatsApp</strong><Pill tone="warn">בקרוב</Pill>
          </div>
          <p className="my-2.5 text-sm text-muted">קבלת לידים ושליחת הודעות דרך WhatsApp Business API</p>
          <Button variant="ghost" size="sm" onClick={() => setDialog('WhatsApp')}>פרטים</Button>
        </Card>
      </div>
      <div className="mt-6">
        <AdapterNote title="איך זה עובד ב-TikTok:">
          הסרטון נשלח לתיבת ההתראות באפליקציה, ומשם מפרסמים. פרסום ישיר מתוך האתר ייפתח אחרי שהאפליקציה תאושר בביקורת של TikTok.
        </AdapterNote>
      </div>
      <IntegrationDialog open={!!dialog} onClose={() => setDialog(null)} provider={dialog || ''} what="חיבור החשבון" />
    </>
  );
}
