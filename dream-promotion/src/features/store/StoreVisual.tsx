'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cx } from '@/lib/utils';
import { Button, PageHead, Select } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Switch } from '@/features/catalog/PublishSwitch';
import { loadCatalog } from '@/features/catalog/data';
import { previewLink, publishVersion, saveDraft, type StoreBundle } from './data';
import { draftErrors, draftOf, SECTION_DEFS, settingsOf, type Draft, type SectionType } from './theme-fields';
import type { ThemeVersion } from './store';
import { FieldInput, ListInput } from './StoreDesign';
import { Notice, TextRow } from './ui';
import {
  ADDABLE, addSection, applyText, canGrow, duplicateSection, editFrameUrl, editRoute, moveSection, readMessage, removeSection,
} from './visual-edit';

/**
 * "עריכה על האתר" (2.61, stage 6 — "לחץ לעריכה", like Wix): the store's own page in a frame, and a panel beside it (a
 * bottom sheet on a phone). A click on the page chooses what to edit: a section opens its settings, a title is edited in
 * place, a picture opens its field, the menus / the store's details / a page / a policy / a product open their editors.
 * Sections move, hide, and — on the open template — are added, duplicated and removed; never placed by the pixel, so the
 * site stays right on every screen. Every change is saved as the draft by itself; "פרסום באתר" puts it on the air, and the
 * versions (the classic editor) bring an older one back.
 */
type Sel = { id: string; field?: string } | { announcement: true } | null;
const SAVE_AFTER = 700;

export function VisualEditor({ bundle, template, versions, reload, onClassic }: {
  bundle: StoreBundle; template: string; versions: ThemeVersion[]; reload: () => Promise<unknown>; onClassic: () => void;
}) {
  const router = useRouter();
  const storeId = bundle.store!.id;
  const published = versions.find((v) => v.status === 'published') ?? null;
  const draftRow = useRef<ThemeVersion | null>(versions.find((v) => v.status === 'draft') ?? null);
  const [d, setD] = useState<Draft>(() => draftOf(template, (draftRow.current ?? published)?.settings ?? {}));
  const latest = useRef(d); latest.current = d;
  const [sel, setSel] = useState<Sel>(null);
  const [state, setState] = useState<'saved' | 'waiting' | 'saving' | 'error'>('saved');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [link, setLink] = useState<{ base: string; token: string; expires: number } | null>(null);
  const [linkError, setLinkError] = useState('');
  const [path, setPath] = useState('/');
  const [frameRev, setFrameRev] = useState(0);
  const [device, setDevice] = useState<'phone' | 'desktop'>('phone');
  const frame = useRef<HTMLIFrameElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadAfter = useRef(false);
  const products = useRef<Map<string, string> | null>(null);
  const grow = canGrow(template);
  const errors = useMemo(() => draftErrors(d), [d]);

  // the frame's token: signed by the server for this store, one hour — fetched again when it is about to end
  const fetchLink = useCallback(async () => {
    const r = await previewLink();
    if (!r.ok) { setLinkError(r.error); return; }
    setLinkError(''); setLink({ base: r.data.base, token: r.data.token, expires: r.data.expires });
  }, []);
  useEffect(() => { void fetchLink(); }, [fetchLink]);
  const refreshFrame = () => {
    if (link && link.expires - Date.now() / 1000 < 120) void fetchLink(); else setFrameRev((n) => n + 1);
  };

  // every change is the draft: saved by itself a moment after the last one; the frame shows it after the save
  const save = useCallback(async (): Promise<ThemeVersion | null> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const now = latest.current;
    const problems = draftErrors(now);
    if (problems.length) { setState('error'); setMsg({ tone: 'error', text: problems[0] }); return null; }
    setState('saving');
    const r = await saveDraft(storeId, template, settingsOf(now), draftRow.current);
    if (!r.ok) { setState('error'); setMsg({ tone: 'error', text: r.error }); return null; }
    draftRow.current = r.data;
    setState(latest.current === now ? 'saved' : 'waiting');
    if (reloadAfter.current) { reloadAfter.current = false; refreshFrame(); }
    return r.data;
  }, [storeId, template, link]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (next: Draft, frameToo = true) => {
    setD(next); latest.current = next; setMsg(null); setState('waiting');
    if (frameToo) reloadAfter.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_AFTER);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (state === 'waiting' || state === 'saving') e.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [state]);

  const post = (m: unknown) => { if (link) frame.current?.contentWindow?.postMessage(m, link.base); };
  const choose = (id: string, field?: string) => { setSel({ id, field }); post({ type: 'select', id }); };

  // the page's messages: only from the frame, only from the store's origin, only of a known shape
  useEffect(() => {
    if (!link) return;
    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== link.base || e.source !== frame.current?.contentWindow) return;
      const m = readMessage(e.data);
      if (!m) return;
      if (m.type === 'ready') { setPath(m.path); if (sel && 'id' in sel) post({ type: 'select', id: sel.id }); return; }
      if (m.type === 'section') { setSel({ id: m.id }); return; }
      if (m.type === 'field' || m.type === 'image') { setSel({ id: m.section, field: m.field }); return; }
      if (m.type === 'text') {
        const next = applyText(latest.current, m);
        setSel({ id: m.section, field: m.field });
        if (next) change(next, false);
        else if (latest.current.sections.some((s) => s.id === m.section)) { setMsg({ tone: 'warn', text: 'הטקסט ארוך מדי לשדה הזה — לא נשמר. אפשר לקצר בפאנל.' }); refreshFrame(); }
        return;
      }
      if (m.type === 'navigate') { setSel(null); setPath(m.path); setFrameRev((n) => n + 1); return; }
      if (m.type === 'open') {
        if (m.target.startsWith('product:') && !products.current) {
          const r = await loadCatalog();
          products.current = new Map(r.ok ? r.data.items.filter((i) => i.slug).map((i) => [i.slug!, i.id]) : []);
        }
        const to = editRoute(m.target, { pages: bundle.pages, collections: bundle.collections, productId: (slug) => products.current?.get(slug) ?? null });
        if (to === 'announcement') { setSel({ announcement: true }); return; }
        if (!to) return;
        if (state !== 'saved' && !(await save())) return;
        router.push(to);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [link, sel, state, bundle]); // eslint-disable-line react-hooks/exhaustive-deps

  const publish = async () => {
    const v = state === 'saved' && draftRow.current ? draftRow.current : await save();
    if (!v) return;
    const r = await publishVersion(v.id);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    draftRow.current = null;
    setMsg({ tone: 'ok', text: `גרסה ${v.version} פורסמה באתר.` }); await reload();
  };

  const section = sel && 'id' in sel ? d.sections.find((s) => s.id === sel.id) ?? null : null;
  const i = section ? d.sections.indexOf(section) : -1;
  const setSection = (patch: Partial<typeof d.sections[number]>) => section && change({ ...d, sections: d.sections.map((x) => (x.id === section.id ? { ...x, ...patch } : x)) });
  const status = { saved: 'נשמר כטיוטה ✓', waiting: 'שומר…', saving: 'שומר…', error: 'לא נשמר' }[state];

  const panel = (
    <div className="space-y-3">
      {sel && 'announcement' in sel ? (
        <>
          <PanelHead title="הודעה בראש האתר" onBack={() => setSel(null)} />
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="text-sm font-semibold">להציג הודעה</span>
            <Switch on={d.announcement.enabled} onClick={() => change({ ...d, announcement: { ...d.announcement, enabled: !d.announcement.enabled } })} label="להציג הודעה בראש האתר" />
          </label>
          <TextRow label="הטקסט" value={d.announcement.text} onChange={(v) => change({ ...d, announcement: { ...d.announcement, text: v } })} max={120} />
          <TextRow label="קישור (לא חובה)" value={d.announcement.href} onChange={(v) => change({ ...d, announcement: { ...d.announcement, href: v } })} dir="ltr" placeholder="/collections/all" />
        </>
      ) : section ? (
        <>
          <PanelHead title={SECTION_DEFS[section.type].label} onBack={() => setSel(null)} />
          <div className="flex flex-wrap gap-2" role="toolbar" aria-label="פעולות על החלק">
            <Button size="sm" variant="soft" disabled={i <= 0} aria-label="להזיז למעלה" onClick={() => change(moveSection(d, section.id, -1))}>▲ למעלה</Button>
            <Button size="sm" variant="soft" disabled={i >= d.sections.length - 1} aria-label="להזיז למטה" onClick={() => change(moveSection(d, section.id, 1))}>▼ למטה</Button>
            <Button size="sm" variant="soft" onClick={() => setSection({ hidden: !section.hidden })}>{section.hidden ? 'להציג באתר' : 'להסתיר'}</Button>
            {grow && <Button size="sm" variant="soft" onClick={() => { const r = duplicateSection(d, section.id); if (r) { change(r.draft); choose(r.id); } }}>שכפול</Button>}
            {grow && <Button size="sm" variant="ghost" className="text-red-700" onClick={() => {
              if (!window.confirm(`למחוק את "${SECTION_DEFS[section.type].label}" מעמוד הבית?`)) return;
              change(removeSection(d, section.id)); setSel(null);
            }}>מחיקה</Button>}
          </div>
          {section.hidden && <Notice tone="info">החלק מוסתר — הוא לא מופיע באתר.</Notice>}
          {SECTION_DEFS[section.type].soon && <Notice tone="info">{SECTION_DEFS[section.type].soon}</Notice>}
          {SECTION_DEFS[section.type].fields.map((f) => (
            <div key={f.key} className={cx(sel && 'field' in sel && sel.field === f.key && 'rounded-md ring-2 ring-primary/50')} ref={(el) => { if (el && sel && 'field' in sel && sel.field === f.key) el.scrollIntoView({ block: 'nearest' }); }}>
              <FieldInput f={f} value={section.settings[f.key]} collections={bundle.collections} onChange={(v) => setSection({ settings: { ...section.settings, [f.key]: v } })} />
            </div>
          ))}
          {SECTION_DEFS[section.type].list && <ListInput def={SECTION_DEFS[section.type].list!} rows={(Array.isArray(section.settings.items) ? section.settings.items : []) as Record<string, unknown>[]}
            onChange={(rows) => setSection({ settings: { ...section.settings, items: rows } })} />}
        </>
      ) : (
        <>
          <p className="text-sm text-muted">לוחצים על כל דבר באתר כדי לערוך אותו: כותרת נערכת במקום, חלק פותח כאן את ההגדרות שלו, והתפריט, פרטי העסק והעמודים נפתחים בעורך שלהם.</p>
          <ol className="space-y-1" aria-label="החלקים של עמוד הבית">
            {d.sections.map((s) => (
              <li key={s.id}><button type="button" className={cx('flex min-h-11 w-full items-center justify-between rounded-md border border-line px-3 text-start text-sm', s.hidden && 'opacity-60')} onClick={() => choose(s.id)}>
                <span className="font-semibold">{SECTION_DEFS[s.type].label}</span>{s.hidden && <span className="text-xs text-muted">מוסתר</span>}</button></li>
            ))}
          </ol>
          {grow && <AddSection onAdd={(type) => { const r = addSection(d, type); if (r) { change(r.draft); choose(r.id); } }} />}
          <button type="button" className="text-sm font-semibold text-primary underline underline-offset-2" onClick={() => setSel({ announcement: true })}>הודעה בראש האתר</button>
        </>
      )}
    </div>
  );

  return (
    <>
      <PageHead title="עריכה על האתר" sub="לוחצים על מה שרוצים לשנות. כל שינוי נשמר כטיוטה — הלקוחות רואים אותו רק אחרי פרסום."
        action={<span className="flex flex-wrap gap-2"><Button variant="ghost" onClick={async () => { if (state !== 'saved') await save(); onClassic(); }}>לעורך הרגיל</Button>
          <Button variant="primary" disabled={state === 'saving' || errors.length > 0} onClick={() => void publish()}>פרסום באתר</Button></span>} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {linkError && <Notice tone="error">{linkError}</Notice>}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span role="status" className={cx('font-semibold', state === 'error' ? 'text-red-700' : 'text-muted')}>{status}</span>
        <span className="ms-auto flex gap-1" role="group" aria-label="גודל המסך">
          <Button size="sm" variant={device === 'phone' ? 'primary' : 'ghost'} aria-pressed={device === 'phone'} onClick={() => setDevice('phone')}>טלפון</Button>
          <Button size="sm" variant={device === 'desktop' ? 'primary' : 'ghost'} aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}>מחשב</Button>
        </span>
        {path !== '/' && <Button size="sm" variant="ghost" onClick={() => { setPath('/'); setSel(null); setFrameRev((n) => n + 1); }}>לדף הבית</Button>}
      </div>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-4">
        <div className="flex justify-center overflow-hidden rounded-xl border border-line bg-surface-2">
          {link ? (
            <iframe key={`${frameRev}-${link.token}`} ref={frame} title="האתר — לחיצה על חלק פותחת את העריכה שלו"
              src={editFrameUrl(link.base, path, link.token)}
              className={cx('h-[calc(100dvh-14rem)] min-h-[32rem] bg-white', device === 'phone' ? 'w-[390px] max-w-full' : 'w-full')} />
          ) : !linkError && <p className="flex items-center gap-2 p-6 text-muted"><Spinner /> טוען את האתר…</p>}
        </div>
        {/* the panel: beside the site on a wide screen; a bottom sheet on a phone, when something is chosen */}
        <aside aria-label="עריכה" className={cx('rounded-xl border border-line bg-surface p-3',
          'max-lg:fixed max-lg:inset-x-2 max-lg:bottom-20 max-lg:z-40 max-lg:max-h-[55dvh] max-lg:overflow-y-auto max-lg:shadow-2xl',
          !sel && 'max-lg:hidden', 'lg:max-h-[calc(100dvh-14rem)] lg:overflow-y-auto')}>
          {panel}
        </aside>
      </div>
      {!sel && <div className="mt-3 lg:hidden">{panel}</div>}
    </>
  );
}

function PanelHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-base font-bold">{title}</h2>
      <Button size="sm" variant="ghost" onClick={onBack}>סגירה</Button>
    </div>
  );
}

function AddSection({ onAdd }: { onAdd: (type: SectionType) => void }) {
  const [type, setType] = useState<SectionType>('text');
  return (
    <div className="flex items-end gap-2">
      <label className="block flex-1">
        <span className="mb-1 block text-sm font-semibold text-ink-2">חלק חדש</span>
        <Select value={type} onChange={(e) => setType(e.target.value as SectionType)}>
          {ADDABLE.map((t) => <option key={t} value={t}>{SECTION_DEFS[t].label}</option>)}
        </Select>
      </label>
      <Button variant="soft" onClick={() => onAdd(type)}>+ הוספה</Button>
    </div>
  );
}
