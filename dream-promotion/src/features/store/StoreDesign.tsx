'use client';
import { useEffect, useMemo, useState } from 'react';
import { cx } from '@/lib/utils';
import { Button, PageHead, Select } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Switch } from '@/features/catalog/PublishSwitch';
import { publishVersion, saveDraft } from './data';
import { contrast, draftErrors, draftOf, SECTION_DEFS, settingsOf, TEMPLATES, type Draft, type FieldDef, type Section } from './theme-fields';
import type { CollectionRow, ThemeVersion } from './store';
import { PreviewButton } from './StoreSettings';
import { Block, NeedsStore, Notice, PicturePicker, TextRow } from './ui';
import { useStoreData } from './useStoreData';

/**
 * "עיצוב" (2.55, the basic editor of stage 2): the template "שקיות ממותגות", its colours and corners, the bar at the top,
 * the home page's sections (shown / hidden, their order, their texts and pictures) and the product page's options.
 * Edits are saved as the one draft; "תצוגה מקדימה" shows the draft; "פרסום" puts it on the site — and an older version
 * can be published again. The storefront checks every value again.
 */
export function StoreDesign() {
  const { data, error, loading, reload } = useStoreData();
  if (loading) return <><PageHead title="עיצוב" /><p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p></>;
  if (error && !data) return <><PageHead title="עיצוב" /><Notice tone="error">{error}</Notice></>;
  if (!data?.store) return <><PageHead title="עיצוב" /><NeedsStore /></>;
  return <Editor storeId={data.store.id} template={data.store.template} versions={data.versions} collections={data.collections} reload={reload} />;
}

function Editor({ storeId, template, versions, collections, reload }: {
  storeId: string; template: string; versions: ThemeVersion[]; collections: CollectionRow[]; reload: () => Promise<unknown>;
}) {
  const draftRow = versions.find((v) => v.status === 'draft') ?? null;
  const published = versions.find((v) => v.status === 'published') ?? null;
  const [d, setD] = useState<Draft>(() => draftOf(template, (draftRow ?? published)?.settings ?? {}));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>('hero');
  const errors = useMemo(() => draftErrors(d), [d]);
  useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  const change = (next: Draft) => { setD(next); setDirty(true); setMsg(null); };
  const setSection = (id: string, s: Partial<Section>) => change({ ...d, sections: d.sections.map((x) => (x.id === id ? { ...x, ...s } : x)) });
  const move = (i: number, by: number) => {
    const j = i + by; if (j < 0 || j >= d.sections.length) return;
    const list = d.sections.slice(); [list[i], list[j]] = [list[j], list[i]]; change({ ...d, sections: list });
  };

  const save = async (): Promise<ThemeVersion | null> => {
    if (errors.length) { setMsg({ tone: 'error', text: errors[0] }); return null; }
    setBusy(true);
    const r = await saveDraft(storeId, template, settingsOf(d), draftRow);
    setBusy(false);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return null; }
    setDirty(false); await reload();
    return r.data;
  };
  const publish = async () => {
    const v = dirty || !draftRow ? await save() : draftRow;
    if (!v) return;
    setBusy(true);
    const r = await publishVersion(v.id);
    setBusy(false);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    setMsg({ tone: 'ok', text: `גרסה ${v.version} פורסמה באתר.` }); await reload();
  };

  return (
    <>
      <PageHead title="עיצוב" sub={`תבנית: ${TEMPLATES[template]?.name ?? template}${published ? ` · באתר: גרסה ${published.version}` : ' · עוד לא פורסם עיצוב (האתר מציג את התבנית כמו שהיא)'}`}
        action={<PreviewButton label="תצוגה מקדימה של הטיוטה" />} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Notice tone="info">הטקסטים של התבנית הם דוגמה — כדאי לעבור עליהם ולהתאים לעסק. "תצוגה מקדימה" מראה את הטיוטה השמורה.</Notice>

      <Block title="צבעים ופינות">
        <div className="grid gap-3 sm:grid-cols-2">
          {([['primary', 'כפתורים'], ['accent', 'צבע הדגשה'], ['background', 'רקע'], ['text', 'טקסט']] as const).map(([k, label]) => (
            <label key={k} className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-line px-3">
              <span className="text-sm font-semibold">{label}</span>
              <span className="flex items-center gap-2"><span dir="ltr" className="font-mono text-xs text-muted">{d.colors[k]}</span>
                <input type="color" aria-label={label} value={d.colors[k]} onChange={(e) => change({ ...d, colors: { ...d.colors, [k]: e.target.value } })} className="h-9 w-12 cursor-pointer rounded border border-line bg-transparent" /></span>
            </label>
          ))}
        </div>
        {contrast(d.colors.text, d.colors.background) < 4.5 && <Notice tone="warn">הטקסט והרקע קרובים מדי — קשה לקרוא. כך אי אפשר לשמור: בחרו זוג צבעים עם יותר ניגוד.</Notice>}
        <label className="mt-3 block max-w-xs">
          <span className="mb-2 block text-sm font-semibold text-ink-2">פינות</span>
          <Select value={d.radius} onChange={(e) => change({ ...d, radius: e.target.value as Draft['radius'] })}>
            <option value="none">ישרות</option><option value="small">מעט עגולות</option><option value="medium">עגולות</option><option value="large">עגולות מאוד</option>
          </Select>
        </label>
        <button type="button" className="mt-3 text-sm font-semibold text-primary underline underline-offset-2" onClick={() => change({ ...d, colors: { ...draftOf(template, {}).colors }, radius: draftOf(template, {}).radius })}>חזרה לצבעי התבנית</button>
      </Block>

      <Block title="הודעה בראש האתר">
        <label className="mb-3 flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm font-semibold">להציג הודעה</span>
          <Switch on={d.announcement.enabled} onClick={() => change({ ...d, announcement: { ...d.announcement, enabled: !d.announcement.enabled } })} label="להציג הודעה בראש האתר" />
        </label>
        {d.announcement.enabled && <>
          <TextRow label="הטקסט" value={d.announcement.text} onChange={(v) => change({ ...d, announcement: { ...d.announcement, text: v } })} max={120} />
          <TextRow label="קישור (לא חובה)" value={d.announcement.href} onChange={(v) => change({ ...d, announcement: { ...d.announcement, href: v } })} dir="ltr" placeholder="/collections/all" />
        </>}
      </Block>

      <Block title="עמוד הבית" sub="החלקים לפי הסדר. אפשר להסתיר, להזיז ולערוך כל אחד.">
        <ol className="space-y-2">
          {d.sections.map((s, i) => {
            const def = SECTION_DEFS[s.type];
            const isOpen = open === s.id;
            return (
              <li key={s.id} className={cx('rounded-md border border-line', s.hidden && 'opacity-70')}>
                <div className="flex items-center gap-2 p-2">
                  <button type="button" className="flex min-h-11 flex-1 items-center text-start font-semibold" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.id)}>
                    {def.label}{s.hidden && <span className="ms-2 text-xs font-normal text-muted">(מוסתר)</span>}
                  </button>
                  <Switch on={!s.hidden} onClick={() => setSection(s.id, { hidden: !s.hidden })} label={`להציג: ${def.label}`} />
                  <Button type="button" variant="soft" size="sm" aria-label={`להזיז למעלה: ${def.label}`} disabled={i === 0} onClick={() => move(i, -1)}>▲</Button>
                  <Button type="button" variant="soft" size="sm" aria-label={`להזיז למטה: ${def.label}`} disabled={i === d.sections.length - 1} onClick={() => move(i, 1)}>▼</Button>
                </div>
                {isOpen && (
                  <div className="border-t border-line p-3">
                    {def.fields.map((f) => <FieldInput key={f.key} f={f} value={s.settings[f.key]} collections={collections}
                      onChange={(v) => setSection(s.id, { settings: { ...s.settings, [f.key]: v } })} />)}
                    {def.list && <ListInput def={def.list} rows={(Array.isArray(s.settings.items) ? s.settings.items : []) as Record<string, unknown>[]}
                      onChange={(rows) => setSection(s.id, { settings: { ...s.settings, items: rows } })} />}
                    <button type="button" className="text-sm font-semibold text-primary underline underline-offset-2"
                      onClick={() => setSection(s.id, { settings: { ...(TEMPLATES[template]?.sections.find((x) => x.id === s.id)?.settings ?? {}) } })}>חזרה לטקסט של התבנית</button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </Block>

      <Block title="עמוד מוצר">
        <label className="mb-2 flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm font-semibold">כפתור "לפרטים והזמנה בוואטסאפ" (כשיש מספר וואטסאפ)</span>
          <Switch on={d.product.whatsapp} onClick={() => change({ ...d, product: { ...d.product, whatsapp: !d.product.whatsapp } })} label="כפתור וואטסאפ בעמוד מוצר" />
        </label>
        <label className="flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm font-semibold">"אולי יעניין אותך גם" — מוצרים דומים</span>
          <Switch on={d.product.related} onClick={() => change({ ...d, product: { ...d.product, related: !d.product.related } })} label="מוצרים דומים בעמוד מוצר" />
        </label>
      </Block>

      <Versions versions={versions} busy={busy} onPublish={async (v) => {
        if (dirty && !window.confirm('יש שינויים שלא נשמרו בטיוטה. לפרסם בכל זאת את הגרסה הישנה?')) return;
        setBusy(true); const r = await publishVersion(v.id); setBusy(false);
        if (!r.ok) setMsg({ tone: 'error', text: r.error }); else { setMsg({ tone: 'ok', text: `גרסה ${v.version} חזרה לאתר.` }); await reload(); }
      }} />

      <div className="sticky bottom-20 z-10 flex flex-wrap justify-end gap-2 rounded-lg bg-[color:var(--glass)] py-2 backdrop-blur sm:bottom-4">
        {dirty && <span className="me-auto self-center text-sm text-muted">יש שינויים שלא נשמרו</span>}
        <Button variant="ghost" disabled={busy || !dirty} onClick={async () => { if (await save()) setMsg({ tone: 'ok', text: 'הטיוטה נשמרה. הלקוחות עדיין רואים את הגרסה שפורסמה.' }); }}>שמירת טיוטה</Button>
        <Button variant="primary" disabled={busy} onClick={() => void publish()}>{busy ? <><Spinner /> רגע…</> : 'פרסום באתר'}</Button>
      </div>
    </>
  );
}

function FieldInput({ f, value, onChange, collections }: { f: FieldDef; value: unknown; onChange: (v: unknown) => void; collections: CollectionRow[] }) {
  const v = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (f.kind === 'image') return <PicturePicker label={f.label} value={v} onChange={onChange} />;
  if (f.kind === 'longtext') {
    return (
      <label className="mb-4 block">
        <span className="mb-2 block text-sm font-semibold text-ink-2">{f.label}</span>
        <textarea className="w-full rounded-md border-[1.5px] border-line bg-surface px-4 py-3 text-[15px]" rows={3} maxLength={f.max} value={v} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  if (f.kind === 'number') {
    return (
      <label className="mb-4 block max-w-[10rem]">
        <span className="mb-2 block text-sm font-semibold text-ink-2">{f.label}</span>
        <Select value={v || '8'} onChange={(e) => onChange(Number(e.target.value))}>{[2, 3, 4, 6, 8, 12].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
      </label>
    );
  }
  if (f.kind === 'side') {
    return (
      <label className="mb-4 block max-w-[12rem]">
        <span className="mb-2 block text-sm font-semibold text-ink-2">{f.label}</span>
        <Select value={v || 'start'} onChange={(e) => onChange(e.target.value)}><option value="start">ימין</option><option value="end">שמאל</option></Select>
      </label>
    );
  }
  if (f.kind === 'collection') {
    return (
      <label className="mb-4 block">
        <span className="mb-2 block text-sm font-semibold text-ink-2">{f.label}</span>
        <Select value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">החדשים באתר</option>
          {collections.map((c) => <option key={c.id} value={c.slug}>{c.title}{c.publishOnline ? '' : ' (לא באתר)'}</option>)}
        </Select>
      </label>
    );
  }
  return <TextRow label={f.label} value={v} onChange={onChange} max={f.max} hint={f.hint} dir={f.kind === 'link' ? 'ltr' : undefined} />;
}

function ListInput({ def, rows, onChange }: { def: NonNullable<(typeof SECTION_DEFS)[keyof typeof SECTION_DEFS]['list']>; rows: Record<string, unknown>[]; onChange: (rows: Record<string, unknown>[]) => void }) {
  return (
    <fieldset className="mb-4">
      <legend className="mb-2 text-sm font-semibold text-ink-2">{def.label}</legend>
      {rows.map((row, i) => (
        <div key={i} className="mb-3 rounded-md bg-surface-2 p-3">
          {def.fields.map((f) => <FieldInput key={f.key} f={f} value={row[f.key]} collections={[]} onChange={(v) => onChange(rows.map((r, j) => (j === i ? { ...r, [f.key]: v } : r)))} />)}
          <button type="button" className="text-sm font-semibold text-red-700 underline underline-offset-2" onClick={() => onChange(rows.filter((_, j) => j !== i))}>הסרה</button>
        </div>
      ))}
      {rows.length < def.max && <Button type="button" variant="soft" size="sm" onClick={() => onChange([...rows, Object.fromEntries(def.fields.map((f) => [f.key, '']))])}>{def.add}</Button>}
    </fieldset>
  );
}

function Versions({ versions, busy, onPublish }: { versions: ThemeVersion[]; busy: boolean; onPublish: (v: ThemeVersion) => void }) {
  const done = versions.filter((v) => v.status !== 'draft');
  if (!done.length) return null;
  return (
    <Block title="גרסאות" sub="אפשר להחזיר לאתר גרסה קודמת. הטיוטה נשארת כמו שהיא.">
      <ul className="space-y-2">
        {done.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
            <span><span className="font-semibold">גרסה {v.version}</span> <span className="text-sm text-muted">{v.publishedAt ? new Date(v.publishedAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }) : ''}</span></span>
            {v.status === 'published' ? <span className="text-sm font-semibold text-ok">באתר עכשיו</span>
              : <Button variant="ghost" size="sm" disabled={busy} onClick={() => onPublish(v)}>להחזיר לאתר</Button>}
          </li>
        ))}
      </ul>
    </Block>
  );
}
