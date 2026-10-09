'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button, PageHead, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Switch } from '@/features/catalog/PublishSwitch';
import { LIMITS, SEO_SHOWN } from '@/features/catalog/catalog';
import { AIService } from '@/lib/services/ai.service';
import { useApp } from '@/lib/store';
import { deletePage, savePage } from './data';
import { aiErrorText } from './AiShort';
import { type PageCopy, wantsAutoFill } from './page-ai';
import {
  hasPlaceholders, pageProblem, POLICY_ACK, policyAckProblem, POLICY_LABEL, policyDraft, policySlug, REQUIRED_POLICIES, STORE_LIMITS, suggestSlug,
  type PageRow, type PolicyKind, type StoreRow,
} from './store';
import { AreaRow, Block, NeedsStore, Notice, TextRow } from './ui';
import { useStoreData } from './useStoreData';

/**
 * "עמודים" (2.55): the policies the site must show (returns, privacy, accessibility — the checklist asks for them) and
 * pages of the business's own (about, delivery…). A policy starts from a draft with "[…]" for what only the business knows;
 * it is NEEDS_LEGAL_VERIFICATION, never "approved", and it is not published while a "[…]" is left in it.
 * Text is plain: an empty line between paragraphs, "## " for a title, "- " for a list (the storefront's RichText).
 */
export function StorePages() {
  return <Suspense fallback={<div className="py-10 text-center"><Spinner /></div>}><Pages /></Suspense>;
}

const POLICIES: PolicyKind[] = ['returns', 'privacy', 'accessibility', 'shipping', 'terms'];
type Draft = { id: string | null; kind: 'page' | 'policy'; policy: PolicyKind | null; title: string; slug: string; slugTouched: boolean; body: string;
  seoTitle: string; seoDescription: string; published: boolean };
const draftOfPage = (p: PageRow): Draft => ({ id: p.id, kind: p.kind, policy: p.policy, title: p.title, slug: p.slug, slugTouched: true, body: p.body,
  seoTitle: p.seoTitle, seoDescription: p.seoDescription, published: p.published });
const newPolicy = (kind: PolicyKind, store: StoreRow): Draft => {
  const t = policyDraft(kind, { name: store.name, phone: store.phone, email: store.email, address: store.address });
  return { id: null, kind: 'policy', policy: kind, title: t.title, slug: policySlug(kind), slugTouched: true, body: t.body, seoTitle: '', seoDescription: '', published: false };
};
const newPage = (): Draft => ({ id: null, kind: 'page', policy: null, title: '', slug: '', slugTouched: false, body: '', seoTitle: '', seoDescription: '', published: false });
const status = (p: PageRow | undefined) => (!p ? { label: 'לא נכתב', tone: 'default' as const } : p.published ? { label: 'באתר', tone: 'ok' as const } : { label: 'טיוטה', tone: 'warn' as const });

function Pages() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { data, error, loading, reload } = useStoreData();
  const [edit, setEdit] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<string>('');
  const store = data?.store ?? null;
  const pages = data?.pages ?? [];
  const open = (kind: PolicyKind) => { const p = pages.find((g) => g.policy === kind); setEdit(p ? draftOfPage(p) : newPolicy(kind, store!)); setMsg(''); };

  // the checklist's links (?policy=returns) and "+ עמוד חדש" of the module (?new=1)
  useEffect(() => {
    if (!store) return;
    const policy = params?.get('policy') as PolicyKind | null;
    const page = params?.get('page') ? pages.find((g) => g.id === params.get('page')) : undefined;
    if (policy && POLICIES.includes(policy)) open(policy);
    else if (page) setEdit(draftOfPage(page));
    else if (params?.get('new') === '1') setEdit(newPage());
    else return;
    router.replace(pathname, { scroll: false });
  }, [params, store?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <><PageHead title="עמודים" /><p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p></>;
  if (error && !data) return <><PageHead title="עמודים" /><Notice tone="error">{error}</Notice></>;
  if (!store) return <><PageHead title="עמודים" /><NeedsStore /></>;

  if (edit) {
    return <Editor draft={edit} store={store} taken={pages.filter((g) => g.id !== edit.id).map((g) => g.slug)} onClose={() => setEdit(null)}
      onSaved={async (text) => { await reload(); setEdit(null); setMsg(text); }} />;
  }

  const content = pages.filter((g) => g.kind === 'page');
  return (
    <>
      <PageHead title="עמודים" sub="מדיניות, ועמודים משלכם כמו אודות או משלוחים." action={<Button variant="primary" onClick={() => { setMsg(''); setEdit(newPage()); }}>+ עמוד חדש</Button>} />
      {msg && <Notice tone="ok">{msg}</Notice>}
      <Block title="מדיניות" sub="שלוש הראשונות נדרשות לפני שהחנות עולה לאוויר. בתחתית כל עמוד באתר יש קישור אליהן.">
        <Notice tone="warn">הנוסח המוצע הוא נקודת התחלה בלבד, ולא בדיקה משפטית. לפני מכירה אמיתית — לעבור עליו עם עורך דין (NEEDS_LEGAL_VERIFICATION).</Notice>
        <ul className="space-y-2">
          {POLICIES.map((kind) => {
            const p = pages.find((g) => g.policy === kind);
            const st = status(p);
            return (
              <li key={kind} className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{p?.title || POLICY_LABEL[kind]}</span>
                  {REQUIRED_POLICIES.includes(kind) && <span className="ms-2 text-xs text-muted">(נדרש)</span>}
                  <span className="block text-xs text-muted"><bdi dir="ltr">/policies/{kind}</bdi></span>
                </span>
                <Pill tone={st.tone}>{st.label}</Pill>
                <Button variant={p ? 'ghost' : 'soft'} size="sm" onClick={() => open(kind)}>{p ? 'עריכה' : 'כתיבה'}</Button>
              </li>
            );
          })}
        </ul>
      </Block>
      <Block title="עמודים משלכם">
        {!content.length ? <p className="text-sm text-muted">עוד אין. למשל: אודות, איך מזמינים, הדפסה על שקיות.</p> : (
          <ul className="space-y-2">
            {content.map((p) => {
              const st = status(p);
              return (
                <li key={p.id}>
                  <button type="button" className="flex w-full flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2 text-start hover:bg-surface-2"
                    onClick={() => { setMsg(''); setEdit(draftOfPage(p)); }}>
                    <span className="min-w-0 flex-1"><span className="block font-semibold">{p.title}</span><span className="block text-xs text-muted"><bdi dir="ltr">/pages/{p.slug}</bdi></span></span>
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Block>
    </>
  );
}

function Editor({ draft, store, taken, onClose, onSaved }: { draft: Draft; store: StoreRow; taken: string[]; onClose: () => void; onSaved: (text: string) => Promise<void> }) {
  const [d, setD] = useState<Draft>(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ack, setAck] = useState(false);
  const ai = usePageAi(d, draft);
  const set = (patch: Partial<Draft>) => { setD((x) => ({ ...x, ...patch })); setError(''); };
  const policy = d.kind === 'policy';
  const required = policy && d.policy !== null && REQUIRED_POLICIES.includes(d.policy);
  const address = policy ? `/policies/${d.policy}` : `/pages/${d.slug || '…'}`;
  // the store is on the air and a required policy would leave the site
  const leavesLive = (willShow: boolean) => store.status === 'published' && required && draft.published && !willShow;

  const save = async () => {
    const slug = d.slugTouched ? d.slug.trim() : suggestSlug(d.title, taken, 'עמוד');
    const problem = pageProblem({ ...d, slug }, taken) ?? policyAckProblem(d, draft.published, ack);
    if (problem) { setError(problem); return; }
    if (leavesLive(d.published) && !window.confirm('החנות באוויר, והעמוד הזה נדרש בה. להסתיר אותו בכל זאת?')) return;
    setBusy(true);
    const r = await savePage(store.id, d.id, { kind: d.kind, policy: d.policy, slug, title: d.title.trim(), body: d.body.trim(),
      seo_title: d.seoTitle.trim(), seo_description: d.seoDescription.trim(), published: d.published });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    await onSaved(d.published ? 'העמוד נשמר ומוצג באתר.' : 'העמוד נשמר כטיוטה (לא מוצג באתר).');
  };

  return (
    <>
      <PageHead title={d.id || policy ? d.title || 'עמוד' : 'עמוד חדש'} sub={address} action={<Button variant="ghost" onClick={onClose}>חזרה לרשימה</Button>} />
      {error && <Notice tone="error">{error}</Notice>}
      {policy && <Notice tone="warn">נקודת התחלה בלבד — לא בדיקה משפטית. מה שבסוגריים [ … ] רק אתם יודעים: משלימים או מוחקים. לפני מכירה אמיתית — לעבור עם עורך דין (NEEDS_LEGAL_VERIFICATION).</Notice>}

      <AiProposal ai={ai} policy={policy} onUse={(p) => {
        set({ title: d.title.trim() ? d.title : p.title, body: p.body, seoTitle: d.seoTitle.trim() || p.seoTitle, seoDescription: d.seoDescription.trim() || p.seoDescription,
          ...(d.slugTouched || d.title.trim() ? {} : { slug: suggestSlug(p.title, taken, 'עמוד') }) });
        ai.clear();
      }} />

      <Block title="תוכן">
        <TextRow label="כותרת" value={d.title} max={STORE_LIMITS.pageTitle}
          onChange={(v) => set({ title: v, ...(d.slugTouched ? {} : { slug: suggestSlug(v, taken, 'עמוד') }) })} />
        {!policy && <TextRow label="כתובת באתר" value={d.slug} max={LIMITS.slug} dir="ltr" onChange={(v) => set({ slug: v.toLowerCase().replace(/\s+/g, '-'), slugTouched: true })}
          hint={`/pages/${d.slug || '…'}${d.id && draft.published ? ' · שינוי הכתובת משאיר הפניה מהכתובת הישנה' : ''}`} />}
        <AreaRow label="טקסט" value={d.body} onChange={(v) => set({ body: v })} rows={16} max={STORE_LIMITS.pageBody}
          hint="שורה ריקה = פסקה חדשה · ## בתחילת שורה = כותרת · - בתחילת שורה = רשימה" />
        {policy && hasPlaceholders(d.body) && <Notice tone="warn">יש בטקסט סימונים בסוגריים [ … ] שעוד לא הושלמו. אפשר לשמור כטיוטה; לפרסם — רק אחרי שהם מושלמים.</Notice>}
        {!policy && hasPlaceholders(d.body) && <Notice tone="warn">יש בטקסט סימונים בסוגריים [ … ] — מקומות להשלים. אם תפרסמו כך, הלקוחות יראו אותם.</Notice>}
        <label className="flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm font-semibold">באתר</span>
          <Switch on={d.published} onClick={() => set({ published: !d.published })} label="העמוד באתר" />
        </label>
        {policy && d.published && !draft.published && (
          <label className="mt-2 flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-line p-3">
            <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={ack} onChange={() => { setAck(!ack); setError(''); }} />
            <span className="text-sm"><span className="block font-semibold">קראתי ואני מאשר/ת</span><span className="block text-xs text-muted">{POLICY_ACK}</span></span>
          </label>
        )}
      </Block>

      <Block title="בגוגל" sub="ריק = הכותרת ותחילת הטקסט.">
        <TextRow label="כותרת" value={d.seoTitle} onChange={(v) => set({ seoTitle: v })} max={STORE_LIMITS.seoTitle} hint={`${d.seoTitle.length} תווים · גוגל מציג בערך ${SEO_SHOWN.title}`} />
        <AreaRow label="תיאור" value={d.seoDescription} onChange={(v) => set({ seoDescription: v })} rows={2} max={STORE_LIMITS.seoDescription}
          hint={`${d.seoDescription.length} תווים · גוגל מציג בערך ${SEO_SHOWN.description}`} />
      </Block>

      <div className="sticky bottom-20 z-10 flex flex-wrap justify-end gap-2 rounded-lg bg-(--glass) py-2 backdrop-blur-sm sm:bottom-4">
        {d.id && (
          <Button variant="ghost" className="me-auto text-red-700" disabled={busy} onClick={async () => {
            const live = leavesLive(false) ? ' החנות באוויר, והעמוד הזה נדרש בה.' : '';
            if (!window.confirm(`למחוק את "${d.title}"?${live}`)) return;
            setBusy(true); const r = await deletePage(d.id!); setBusy(false);
            if (!r.ok) setError(r.error); else await onSaved('העמוד נמחק.');
          }}>מחיקה</Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={onClose}>ביטול</Button>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? <><Spinner /> שומר…</> : 'שמירה'}</Button>
      </div>
    </>
  );
}

// ---- ✨ AI (2.59) --------------------------------------------------------------------------------------------------------------
type PageAi = { ok: boolean | null; busy: boolean; proposal: PageCopy | null; error: string; write: () => Promise<void>; clear: () => void };

/**
 * The AI writes by itself when the editor opens on an empty page or one still holding "[…]" (once per page in a visit) — a
 * proposal beside the text, never over it: "שימוש בטקסט" puts it in the editor, and only "שמירה" saves.
 */
function usePageAi(d: Draft, opened: Draft): PageAi {
  const brand = useApp((s) => s.brand);
  const [ok, setOk] = useState<boolean | null>(null);
  const [state, setState] = useState<{ busy: boolean; proposal: PageCopy | null; error: string }>({ busy: false, proposal: null, error: '' });
  const latest = useRef(d); latest.current = d;
  const write = async () => {
    const x = latest.current;
    if (x.kind === 'page' && !x.title.trim()) { setState({ busy: false, proposal: null, error: 'קודם כותרת לעמוד — ה-AI כותב לפיה.' }); return; }
    setState({ busy: true, proposal: null, error: '' });
    try {
      const p = await AIService.storePage(brand, { kind: x.kind, policy: x.policy, title: x.title.trim(), current: x.body });
      setState({ busy: false, proposal: p?.body ? p : null, error: p?.body ? '' : 'לא התקבל טקסט — נסו שוב.' });
    } catch (e) { setState({ busy: false, proposal: null, error: aiErrorText(e) }); }
  };
  useEffect(() => { AIService.available().then(setOk); }, []);
  useEffect(() => {
    if (!ok || !wantsAutoFill(opened.body) || (opened.kind === 'page' && !opened.title.trim())) return;
    const key = `page-ai:${opened.id ?? opened.policy ?? opened.title}`;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* no storage: still write once now */ }
    void write();
  }, [ok]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ok, ...state, write, clear: () => setState({ busy: false, proposal: null, error: '' }) };
}

function AiProposal({ ai, policy, onUse }: { ai: PageAi; policy: boolean; onUse: (p: PageCopy) => void }) {
  if (ai.ok === false) return <p className="mb-3 text-xs text-muted">ה-AI לא מוגדר בשרת — כותבים ידנית.</p>;
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="soft" disabled={ai.busy || ai.ok === null} onClick={() => void ai.write()}>
          {ai.busy ? <><Spinner /> ה-AI כותב…</> : policy ? '✨ מילוי בעזרת AI לפי החוק' : '✨ מילוי בעזרת AI'}</Button>
        {!ai.busy && !ai.proposal && <span className="text-xs text-muted">{policy ? 'לפי חוקי המדינה של החנות ופרטי העסק.' : 'לפי פרטי העסק והכותרת.'}</span>}
      </div>
      {ai.error && <p role="alert" className="mt-2 text-sm text-(--danger)">{ai.error}</p>}
      {ai.proposal && (
        <div className="mt-3 rounded-2xl border border-primary/40 bg-primary-soft p-3 text-sm">
          <p className="mb-1 font-bold">✨ הצעה מה-AI — לקרוא לפני שמשתמשים. היא תישמר רק אחרי &quot;שמירה&quot;.</p>
          {policy && <p className="mb-2 text-xs text-ink-2">נכתב לפי החוק כפי שהוא ידוע לנו — לא בדיקה משפטית. מה שבסוגריים [ … ] משלימים, ולפני הפרסום עוברים עם עורך דין.</p>}
          <div className="max-h-80 overflow-y-auto whitespace-pre-line rounded-md bg-surface p-2">{ai.proposal.body}</div>
          {ai.proposal.seoTitle && <p className="mt-2 text-xs text-ink-2"><strong>כותרת לגוגל:</strong> {ai.proposal.seoTitle}</p>}
          {ai.proposal.seoDescription && <p className="text-xs text-ink-2"><strong>תיאור לגוגל:</strong> {ai.proposal.seoDescription}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => onUse(ai.proposal!)}>שימוש בטקסט</Button>
            <Button size="sm" variant="ghost" onClick={() => void ai.write()}>הצעה אחרת</Button>
            <Button size="sm" variant="ghost" onClick={ai.clear}>ביטול</Button>
          </div>
        </div>
      )}
    </div>
  );
}
