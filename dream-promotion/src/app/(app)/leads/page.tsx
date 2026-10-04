'use client';
import { useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { Button, Card, Chip, Field, Input, PageHead } from '@/components/ui/primitives';
import { EmptyState, Modal } from '@/components/ui/feedback';
import { cx, today } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';
import type { Lead, LeadStatus } from '@/types';
import { UsersThree } from '@/components/ui/Icon';
import { STAGES, followupState, matches, parseTags, stageOf, telLink, waLink } from '@/features/crm/crm';
import { ContactSheet } from '@/features/crm/ContactSheet';
import { MetaLeadsSettings } from '@/features/crm/MetaLeadsSettings';

/**
 * CRM — the business's contacts: leads and customers in one place (toolbox stage 1).
 * Search, stages, follow-ups that are due, quick call / WhatsApp, a pipeline board, and a contact
 * card with the full history. Works on the phone first.
 */
export default function LeadsPage() {
  const { leads, addLead } = useApp();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState<LeadStatus | 'all' | 'due'>('all');
  const [view, setView] = useState<'list' | 'board'>('list');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', source: '', tags: '' });

  const due = useMemo(() => leads.filter((l) => { const s = followupState(l); return s === 'overdue' || s === 'today'; }), [leads]);
  const shown = useMemo(() => {
    const base = stage === 'due' ? due : stage === 'all' ? leads : leads.filter((l) => l.status === stage);
    // what needs attention first: overdue / today follow-ups, then the newest
    const rank = (l: Lead) => ({ overdue: 0, today: 1, upcoming: 2 } as Record<string, number>)[followupState(l) ?? ''] ?? 3;
    return base.filter((l) => matches(l, q)).sort((a, b) => rank(a) - rank(b) || (b.date > a.date ? 1 : -1));
  }, [leads, due, stage, q]);
  const customers = leads.filter((l) => l.status === 'נסגר');
  const revenue = customers.reduce((a, l) => a + (Number(l.value) || 0), 0);

  function create() {
    if (!form.name.trim()) return;
    const id = addLead({
      name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim(), source: form.source.trim() || 'ידני',
      tags: parseTags(form.tags), date: today(), status: 'חדש', value: 0,
    });
    setForm({ name: '', phone: '', email: '', source: '', tags: '' });
    setAdding(false); setOpenId(id);
  }

  const Row = ({ l }: { l: Lead }) => {
    const st = stageOf(l.status), fs = followupState(l);
    return (
      <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-3">
        <button type="button" onClick={() => setOpenId(l.id)} className="min-w-0 flex-1 text-start">
          <span className="flex flex-wrap items-center gap-2">
            <strong className="truncate">{l.name}</strong>
            <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-bold', st.tone)}>{st.label}</span>
            {fs === 'overdue' && <span className="rounded-full bg-[var(--danger)]/15 px-2 py-0.5 text-[11px] font-bold text-[var(--danger)]">לחזור — עבר הזמן</span>}
            {fs === 'today' && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">לחזור היום</span>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted" dir="auto">
            {[l.phone, l.source, ...(l.tags ?? []).map((t) => `#${t}`)].filter(Boolean).join(' · ')}
            {fs === 'upcoming' && l.nextFollowup ? ` · תזכורת ${formatIL(l.nextFollowup, { dateStyle: 'short' })}` : ''}
          </span>
        </button>
        {l.phone && <a href={telLink(l.phone)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line hover:border-primary" aria-label={`התקשרות ל${l.name}`}>📞</a>}
        {waLink(l.phone) && <a href={waLink(l.phone)} target="_blank" rel="noopener" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line hover:border-primary" aria-label={`וואטסאפ ל${l.name}`}>💬</a>}
      </div>
    );
  };

  return (
    <>
      <PageHead title="לקוחות" sub={`${leads.length} אנשי קשר · ${customers.length} לקוחות${revenue ? ` · ₪${revenue.toLocaleString('he-IL')}` : ''}`}
        action={<div className="flex gap-2">
          <Button variant="ghost" onClick={() => setSettings(true)} aria-label="הגדרות לקוחות">⚙️ הגדרות</Button>
          <Button variant="primary" onClick={() => setAdding(true)}>+ איש קשר</Button>
        </div>} />

      {leads.length === 0 ? (
        <EmptyState icon={<UsersThree />} title="עוד אין אנשי קשר"
          body="כאן מנהלים לידים ולקוחות: מי פנה, מה דובר, ומתי לחזור אליו. הוסיפו את הראשון — אפשר גם מהטלפון."
          action={<Button variant="primary" onClick={() => setAdding(true)}>הוספת איש קשר</Button>} />
      ) : (
        <>
          {due.length > 0 && (
            <button type="button" onClick={() => setStage('due')}
              className="mb-4 flex w-full items-center justify-between gap-3 rounded-2xl bg-amber-500/15 px-4 py-3 text-start">
              <span><strong>{due.length} אנשי קשר מחכים שתחזרו אליהם</strong><span className="block text-xs text-ink-2">תזכורות להיום ושעבר זמנן</span></span>
              <span className="text-sm font-bold">הצגה ←</span>
            </button>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם, טלפון, תגית…" className="h-10 min-w-0 flex-1 basis-56" aria-label="חיפוש" />
            <div className="flex overflow-hidden rounded-full border border-line text-sm" role="radiogroup" aria-label="תצוגה">
              {(['list', 'board'] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}
                  className={cx('px-3 py-1.5 font-semibold', view === v ? 'bg-primary text-white' : 'text-ink-2')}>{v === 'list' ? 'רשימה' : 'לוח'}</button>
              ))}
            </div>
          </div>

          {view === 'list' && (
            <>
              <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
                <Chip on={stage === 'all'} onClick={() => setStage('all')}>הכל {leads.length}</Chip>
                {due.length > 0 && <Chip on={stage === 'due'} onClick={() => setStage('due')}>לחזור {due.length}</Chip>}
                {STAGES.map((s) => {
                  const n = leads.filter((l) => l.status === s.id).length;
                  return n ? <Chip key={s.id} on={stage === s.id} onClick={() => setStage(s.id)}>{s.label} {n}</Chip> : null;
                })}
              </div>
              {/* grid-cols-1 + min-w-0: a long line (phone · source · tags) truncates instead of widening the page */}
              <div className="grid grid-cols-1 gap-2">
                {shown.map((l) => <Row key={l.id} l={l} />)}
                {!shown.length && <p className="p-4 text-center text-sm text-muted">אין תוצאות.</p>}
              </div>
            </>
          )}

          {view === 'board' && (
            <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
              {STAGES.map((s) => {
                const col = leads.filter((l) => l.status === s.id && matches(l, q));
                return (
                  <Card key={s.id} className="w-64 shrink-0 p-3">
                    <p className="mb-2 flex items-center justify-between text-sm font-bold">
                      <span className={cx('rounded-full px-2 py-0.5 text-xs', s.tone)}>{s.label}</span>
                      <span className="text-muted">{col.length}</span>
                    </p>
                    <div className="grid gap-2">
                      {col.map((l) => {
                        const fs = followupState(l);
                        return (
                          <button key={l.id} type="button" onClick={() => setOpenId(l.id)} className="rounded-xl border border-line bg-surface p-2.5 text-start hover:border-primary">
                            <strong className="block truncate text-sm">{l.name}</strong>
                            <span className="block truncate text-[11px] text-muted">{l.phone || l.source}</span>
                            {(fs === 'overdue' || fs === 'today') && <span className="mt-1 block text-[11px] font-bold text-amber-700 dark:text-amber-300">לחזור {fs === 'today' ? 'היום' : '— עבר הזמן'}</span>}
                          </button>
                        );
                      })}
                      {!col.length && <p className="py-2 text-center text-xs text-muted">—</p>}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      <Modal open={settings} onClose={() => setSettings(false)}>
        <MetaLeadsSettings />
        <div className="mt-4 flex justify-end"><Button variant="ghost" onClick={() => setSettings(false)}>סגירה</Button></div>
      </Modal>

      <Modal open={adding} onClose={() => setAdding(false)}>
        <h3 className="mb-4 font-display text-xl font-extrabold">איש קשר חדש</h3>
        <Field label="שם"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
        <Field label="טלפון"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" dir="ltr" /></Field>
        <Field label="אימייל (לא חובה)"><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} inputMode="email" dir="ltr" /></Field>
        <Field label="מאיפה הגיע/ה"><Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="אינסטגרם, המלצה, אתר…" /></Field>
        <Field label="תגיות (לא חובה)"><Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="VIP, לייזר" /></Field>
        <div className="flex gap-3">
          <Button variant="primary" onClick={create} disabled={!form.name.trim()}>הוספה</Button>
          <Button variant="ghost" onClick={() => setAdding(false)}>ביטול</Button>
        </div>
      </Modal>

      <ContactSheet leadId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
