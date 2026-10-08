'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cx } from '@/lib/utils';
import { Button, PageHead } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Switch } from '@/features/catalog/PublishSwitch';
import { loadCatalog } from '@/features/catalog/data';
import { previewLink, publishVersion, saveDraft, type StoreBundle } from './data';
import { DEVICES, draftErrors, draftOf, SECTION_DEFS, settingsOf, type Device, type Draft } from './theme-fields';
import type { ThemeVersion } from './store';
import { GlobalDesign, liveClasses, SectionLayout } from './StoreVariants';
import { kitPictureShown } from './kits';
import { FieldInput, ListInput } from './StoreDesign';
import { Notice, TextRow } from './ui';
import {
  addSection, applyText, canGrow, duplicateSection, editFrameUrl, editRoute, moveSection, moveSectionAt, moveSectionTo, readMessage,
  removeSection, shownIndex,
} from './visual-edit';
import { emptyHistory, record, redo as redoStep, undo as undoStep, type History } from './history';
import { SectionList } from './SectionList';
import { ColumnsEditor } from './BlockEditor';
import { withColumns } from './blocks';
import { SectionStyle } from './SectionStyle';
import { AddGallery } from './AddGallery';
import { sectionStyleClasses } from './section-style';

/**
 * 2.65 (Dream Builder PR-3a): how the page shows a change without loading again — "move" / "remove" at once (the draft is
 * saved behind it), "rerender" after the save (the page fetches itself and swaps its content), "none" (the page already shows
 * it: a text typed in place). The key joins steps of the history (typing in one field is one step).
 */
type Live = 'rerender' | 'reload' | 'none' | { move: string } | { remove: string };

/**
 * "עריכה על האתר" (2.61, stage 6 — "לחץ לעריכה", like Wix): the store's own page in a frame, and a panel beside it (a
 * bottom sheet on a phone). A click on the page chooses what to edit: a section opens its settings, a title is edited in
 * place, a picture opens its field, the menus / the store's details / a page / a policy / a product open their editors.
 * Sections move, hide, and — on the open template — are added, duplicated and removed; never placed by the pixel, so the
 * site stays right on every screen. Every change is saved as the draft by itself; "פרסום באתר" puts it on the air, and the
 * versions (the classic editor) bring an older one back.
 */
type Sel = { id: string; field?: string; block?: string } | { add: true; after: string | null } | { announcement: true } | null;
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
  const [device, setDevice] = useState<Device>('base');
  const frame = useRef<HTMLIFrameElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rerenderAfter = useRef(false);
  const reloadAfter = useRef(false);   // the announcement bar is outside the page's content: a new frame
  const rev = useRef(0);
  const [hist, setHist] = useState<History<Draft>>(emptyHistory);
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
    if (reloadAfter.current) { reloadAfter.current = false; rerenderAfter.current = false; refreshFrame(); }
    else if (rerenderAfter.current) { rerenderAfter.current = false; showSaved(); }
    return r.data;
  }, [storeId, template, link]); // eslint-disable-line react-hooks/exhaustive-deps
  // the page shows the saved draft: its content swapped in place — or, with a token about to end, a new frame
  const showSaved = () => {
    if (link && link.expires - Date.now() / 1000 < 120) { refreshFrame(); return; }
    rev.current += 1; post({ type: 'rerender', rev: rev.current });
  };
  const apply = (next: Draft, live: Live) => {
    setD(next); latest.current = next; setMsg(null); setState('waiting');
    if (live === 'rerender') rerenderAfter.current = true;
    else if (live === 'reload') reloadAfter.current = true;
    else if (live !== 'none' && 'move' in live) { const at = shownIndex(next, live.move); if (at >= 0) post({ type: 'move', id: live.move, to: at }); }
    else if (live !== 'none') post({ type: 'remove', id: live.remove });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_AFTER);
  };
  /** every change: one step back in the history (typing in one field is one step), then the draft */
  const change = (next: Draft, live: Live = 'rerender', key: string | null = null) => {
    if (next === latest.current) return;
    const before = latest.current;   // read now: the updater runs later, after apply() has moved latest on
    setHist((h) => record(h, before, key));
    apply(next, live);
  };
  /**
   * "עיצוב כללי" (2.66): colours, corners, font and the design choices show on the page at once — the variables and the
   * classes through the page's own checks (EditBridge "style"); a header / footer / card / product page that is drawn
   * differently comes back from the server after the save.
   */
  const changeGlobal = (next: Draft) => {
    const shape = (cls: string) => cls.split(' ').filter((c) => /^v-(h|f|pc|cc|pp)-/.test(c)).join(' ');
    const classes = liveClasses(next);
    change(next, shape(classes) === shape(liveClasses(latest.current)) ? 'none' : 'rerender');
    post({ type: 'style', colors: next.colors, font: next.font, radius: next.radius, classes });
  };
  const undo = () => { const r = undoStep(hist, latest.current); if (r) { setHist(r.history); apply(r.value, 'rerender'); } };
  const redo = () => { const r = redoStep(hist, latest.current); if (r) { setHist(r.history); apply(r.value, 'rerender'); } };
  // Ctrl / Cmd + Z, Ctrl / Cmd + Shift + Z — not while typing in a field (it has its own undo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
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
      if (m.type === 'ready') { setPath(m.path); post({ type: 'config', add: grow && m.path === '/' }); if (sel && 'id' in sel) post({ type: 'select', id: sel.id, block: sel.block }); return; }
      if (m.type === 'section') { setSel({ id: m.id }); return; }
      if (m.type === 'block') { setSel({ id: m.section, block: m.id }); return; }
      if (m.type === 'add') { if (grow && latest.current.sections.some((s) => s.id === m.after)) setSel({ add: true, after: m.after }); return; }
      if (m.type === 'field' || m.type === 'image') { setSel({ id: m.section, field: m.field }); return; }
      if (m.type === 'text') {
        const next = applyText(latest.current, m);
        setSel({ id: m.section, field: m.field });
        if (next) change(next, 'none', `text:${m.section}:${m.field}`);
        else if (latest.current.sections.some((s) => s.id === m.section)) { setMsg({ tone: 'warn', text: 'הטקסט ארוך מדי לשדה הזה — לא נשמר. אפשר לקצר בפאנל.' }); refreshFrame(); }
        return;
      }
      if (m.type === 'drop') {
        // the page says where; the draft decides (a hidden section, an unknown one — nothing moves)
        const next = moveSectionTo(latest.current, m.id, m.to);
        if (next !== latest.current) change(next, { move: m.id });
        else { const at = shownIndex(latest.current, m.id); if (at >= 0) post({ type: 'move', id: m.id, to: at }); }
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
  const setSection = (patch: Partial<typeof d.sections[number]>, live: Live = 'rerender', key: string | null = null) =>
    section && change({ ...d, sections: d.sections.map((x) => (x.id === section.id ? { ...x, ...patch } : x)) }, live, key);
  const moveBy = (id: string, by: -1 | 1) => { const next = moveSection(d, id, by); change(next, next.sections.find((x) => x.id === id)?.hidden ? 'none' : { move: id }); };
  const status = { saved: 'נשמר כטיוטה ✓', waiting: 'שומר…', saving: 'שומר…', error: 'לא נשמר' }[state];

  const panel = (
    <div className="space-y-3">
      {sel && 'add' in sel ? (
        <AddGallery where={sel.after ? `אחרי "${SECTION_DEFS[d.sections.find((s) => s.id === sel.after)?.type ?? 'text'].label}"` : 'בסוף עמוד הבית'}
          onBack={() => setSel(null)} onPick={(type) => {
            const r = addSection(d, type, sel.after, bundle.store!.name);
            if (r) { change(r.draft); choose(r.id); } else setMsg({ tone: 'warn', text: 'אפשר עד 20 חלקים בעמוד הבית.' });
          }} />
      ) : sel && 'announcement' in sel ? (
        <>
          <PanelHead title="הודעה בראש האתר" onBack={() => setSel(null)} />
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="text-sm font-semibold">להציג הודעה</span>
            <Switch on={d.announcement.enabled} onClick={() => change({ ...d, announcement: { ...d.announcement, enabled: !d.announcement.enabled } }, 'reload')} label="להציג הודעה בראש האתר" />
          </label>
          <TextRow label="הטקסט" value={d.announcement.text} onChange={(v) => change({ ...d, announcement: { ...d.announcement, text: v } }, 'reload', 'announcement:text')} max={120} />
          <TextRow label="קישור (לא חובה)" value={d.announcement.href} onChange={(v) => change({ ...d, announcement: { ...d.announcement, href: v } }, 'reload', 'announcement:href')} dir="ltr" placeholder="/collections/all" />
        </>
      ) : section ? (
        <>
          <PanelHead title={SECTION_DEFS[section.type].label} onBack={() => setSel(null)} />
          <div className="flex flex-wrap gap-2" role="toolbar" aria-label="פעולות על החלק">
            <Button size="sm" variant="soft" disabled={i <= 0} aria-label="להזיז למעלה" onClick={() => moveBy(section.id, -1)}>▲ למעלה</Button>
            <Button size="sm" variant="soft" disabled={i >= d.sections.length - 1} aria-label="להזיז למטה" onClick={() => moveBy(section.id, 1)}>▼ למטה</Button>
            <Button size="sm" variant="soft" onClick={() => setSection({ hidden: !section.hidden }, section.hidden ? 'rerender' : { remove: section.id })}>{section.hidden ? 'להציג באתר' : 'להסתיר'}</Button>
            {grow && <Button size="sm" variant="soft" onClick={() => { const r = duplicateSection(d, section.id); if (r) { change(r.draft); choose(r.id); } }}>שכפול</Button>}
            {grow && <Button size="sm" variant="ghost" className="text-red-700" onClick={() => {
              if (!window.confirm(`למחוק את "${SECTION_DEFS[section.type].label}" מעמוד הבית?`)) return;
              change(removeSection(d, section.id), { remove: section.id }); setSel(null);
            }}>מחיקה</Button>}
          </div>
          {section.hidden && <Notice tone="info">החלק מוסתר — הוא לא מופיע באתר.</Notice>}
          {!section.hidden && (
            <fieldset className="flex flex-wrap items-center gap-2">
              <legend className="mb-1 text-sm font-semibold text-ink-2">להציג ב:</legend>
              {DEVICES.map((dv) => {
                const off = section.hiddenOn?.includes(dv.id) ?? false;
                return <Button key={dv.id} size="sm" variant={off ? 'ghost' : 'soft'} aria-pressed={!off} onClick={() => {
                  const next = off ? (section.hiddenOn ?? []).filter((x) => x !== dv.id) : DEVICES.map((x) => x.id).filter((x) => x === dv.id || section.hiddenOn?.includes(x));
                  if (next.length === DEVICES.length) { setMsg({ tone: 'warn', text: 'כדי להסתיר בכל המסכים — "להסתיר".' }); return; }
                  setSection({ hiddenOn: next.length ? next : undefined });
                }}>{off ? `✕ ${dv.label}` : `✓ ${dv.label}`}</Button>;
              })}
            </fieldset>
          )}
          {SECTION_DEFS[section.type].soon && <Notice tone="info">{SECTION_DEFS[section.type].soon}</Notice>}
          <SectionLayout d={d} section={section} change={change} />
          <SectionStyle d={d} section={section} device={device} onDevice={setDevice} change={(next, key) => {
            // at once on the page (its classes, checked there), the saved draft behind it
            const s = next.sections.find((x) => x.id === section.id);
            change(next, 'none', key);
            if (s) post({ type: 'sectionStyle', id: s.id, classes: sectionStyleClasses(s) });
          }} />
          {SECTION_DEFS[section.type].fields.map((f) => (
            <div key={f.key} className={cx(sel && 'field' in sel && sel.field === f.key && 'rounded-md ring-2 ring-primary/50')} ref={(el) => { if (el && sel && 'field' in sel && sel.field === f.key) el.scrollIntoView({ block: 'nearest' }); }}>
              <FieldInput f={f} value={section.settings[f.key]} collections={bundle.collections} kitPicture={kitPictureShown(d.kit, section.type, f.key) && !(f.kind === 'kitpick' && section.settings.image)}
                onChange={(v) => setSection({ settings: { ...section.settings, [f.key]: v } }, 'rerender', `field:${section.id}:${f.key}`)} />
            </div>
          ))}
          {section.type === 'custom' && <ColumnsEditor columns={section.columns ?? []} block={sel && 'id' in sel ? sel.block ?? null : null}
            onChange={(cols, key = null) => change(withColumns(d, section.id, cols), 'rerender', key ? `${section.id}:${key}` : null)}
            onBlock={(block) => { setSel({ id: section.id, ...(block ? { block } : {}) }); post({ type: 'select', id: section.id, block }); }} />}
          {SECTION_DEFS[section.type].list && <ListInput def={SECTION_DEFS[section.type].list!} rows={(Array.isArray(section.settings.items) ? section.settings.items : []) as Record<string, unknown>[]}
            onChange={(rows) => setSection({ settings: { ...section.settings, items: rows } })} />}
        </>
      ) : (
        <>
          <p className="text-sm text-muted">לוחצים על כל דבר באתר כדי לערוך אותו: כותרת נערכת במקום, חלק פותח כאן את ההגדרות שלו, והתפריט, פרטי העסק והעמודים נפתחים בעורך שלהם.</p>
          <SectionList sections={d.sections} onChoose={choose} onMove={(from, to) => {
            const id = d.sections[from]?.id; const next = moveSectionAt(d, from, to);
            if (id) change(next, next.sections.find((x) => x.id === id)?.hidden ? 'none' : { move: id });
          }} />
          {grow && <Button variant="soft" className="w-full" onClick={() => setSel({ add: true, after: null })}>+ חלק חדש</Button>}
          <details className="rounded-md border border-line p-2">
            <summary className="cursor-pointer text-sm font-semibold">עיצוב כללי — צבעים, גופן, ראש ותחתית, ריווח וכפתורים</summary>
            <div className="mt-3"><GlobalDesign d={d} change={changeGlobal} /></div>
          </details>
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
        <span className="flex gap-1" role="group" aria-label="ביטול וחזרה">
          <Button size="sm" variant="ghost" disabled={!hist.past.length} onClick={undo} aria-label="ביטול הפעולה האחרונה (Ctrl+Z)" title="Ctrl+Z">↶ ביטול</Button>
          <Button size="sm" variant="ghost" disabled={!hist.future.length} onClick={redo} aria-label="חזרה על הפעולה (Ctrl+Shift+Z)" title="Ctrl+Shift+Z">↷ חזרה</Button>
        </span>
        <span className="ms-auto flex gap-1" role="group" aria-label="גודל המסך">
          {DEVICES.map((dv) => <Button key={dv.id} size="sm" variant={device === dv.id ? 'primary' : 'ghost'} aria-pressed={device === dv.id} onClick={() => setDevice(dv.id)}>{dv.label}</Button>)}
        </span>
        {path !== '/' && <Button size="sm" variant="ghost" onClick={() => { setPath('/'); setSel(null); setFrameRev((n) => n + 1); }}>לדף הבית</Button>}
      </div>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-4">
        <div className="flex justify-center overflow-hidden rounded-xl border border-line bg-surface-2">
          {link ? (
            <iframe key={`${frameRev}-${link.token}`} ref={frame} title="האתר — לחיצה על חלק פותחת את העריכה שלו"
              src={editFrameUrl(link.base, path, link.token)}
              className={cx('h-[calc(100dvh-14rem)] min-h-[32rem] max-w-full bg-white', { base: 'w-[390px]', md: 'w-[820px]', lg: 'w-full' }[device])} />
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
