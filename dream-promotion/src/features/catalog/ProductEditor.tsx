'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Repo } from '@/lib/repo';
import { Button, Card, Field, Input, Select, SmallSelect, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { ImageGlyph } from '@/components/ui/Icon';
import { cx } from '@/lib/utils';
import { AIService } from '@/lib/services';
import { ils } from '@/features/register/money';
import {
  KIND_HE, LIMITS, MAX_OPTIONS, MAX_PICTURES, MIGRATION_3300, MIGRATION_4200, SEO_SHOWN, changedColumns, cleanProductCopy, copyBrief, draftError, draftOf, emptyDraft,
  itemColumns, itemColumnsOf, newFieldKey, onlinePriceOf, planVariants, posPrice, promoteBrief, promoteUrl, publishGaps, slugify, splitList, unassignedUnits, uniqueSlug,
  variantColumns, variantLabel, variantLevel, type CatalogItem, type CatalogMedia, type CatalogOption, type CatalogVariant, type FieldDef,
  type ItemDraft, type ItemKind, type ProductCopy,
} from './catalog';
import {
  addFieldDef, adjustItemStock, adjustVariantStock, createVariants, deleteItem, deleteVariant, insertItem, loadFieldDefs, loadProduct, mediaApi,
  reconcileVariantStock, saveOptions, setLowStock, takenSlugs, updateItem, updateMedia, updateVariant,
} from './data';
import { uploadPicture } from './upload';
import { pickSize } from './images';
import { Switch, SITE_LIVE, SITE_NOT_LIVE, useSiteLive, type EditorFocus } from './PublishSwitch';
import { authHeaders } from '@/lib/services/http';
import { loadTreatmentTypes, packagesReady, type TreatmentType } from '@/features/finance/packages-data';

/**
 * THE product editor (Dream Commerce 2.54) — the only place a product is created and edited, opened from the register's
 * price list, from finance (a document line, an expense, the products screen) and from the store. All of them write the
 * same row of catalog_items, so a change here is everywhere at once.
 * The main "שמירה" writes the product's fields (only what changed) and the variants' fields. Pictures, creating /
 * deleting variants and stock moves happen at once (each says so) — they are their own rows and their own log.
 */
export interface EditorProps {
  itemId: string | null;
  /** a new product's first values (a document line's name and price, the register's kind) */
  initial?: Partial<ItemDraft>;
  focus?: EditorFocus;
  /** where a new product goes in the register's list */
  nextSort?: number;
  onSaved?: (item: CatalogItem) => void;
  onDeleted?: (id: string) => void;
  onClose?: () => void;
}
type VDraft = { price: string; onlinePrice: string; sku: string; barcode: string; lowStock: string; active: boolean; mediaId: string | null };
type OptRow = { position: number; name: string; values: string };
const vdraftOf = (v: CatalogVariant): VDraft => ({
  price: v.price == null ? '' : String(v.price), onlinePrice: v.onlinePrice == null ? '' : String(v.onlinePrice), sku: v.sku, barcode: v.barcode,
  lowStock: v.lowStock == null ? '' : String(v.lowStock), active: v.active, mediaId: v.mediaId,
});
const optRowsOf = (options: CatalogOption[]): OptRow[] => {
  const rows = [...options].sort((a, b) => a.position - b.position).map((o) => ({ position: o.position, name: o.name, values: o.choices.join(', ') }));
  return rows.length ? rows : [{ position: 1, name: '', values: '' }];
};
const aiErrorText = (e: any) => e?.code === 'no_api_key' ? 'ה-AI לא מוגדר בשרת (חסר ANTHROPIC_API_KEY).'
  : e?.code === 'quota_exceeded' ? String(e?.message || 'הגעתם למכסת ה-AI החודשית.')
  : e?.code === 'register_only' || e?.code === 'view_only' ? 'אין הרשאה לפעולה הזו.'
  : 'ה-AI לא הצליח הפעם — נסו שוב.';

function Section({ id, title, hint, children, sectionRef }: { id: string; title: string; hint?: ReactNode; children: ReactNode; sectionRef?: (el: HTMLElement | null) => void }) {
  return (
    <section ref={sectionRef} aria-labelledby={`pe-${id}`} className="scroll-mt-24 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h3 id={`pe-${id}`} className="font-display text-lg font-extrabold">{title}</h3>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function ProductEditor({ itemId, initial, focus, nextSort = 9999, onSaved, onDeleted, onClose }: EditorProps) {
  const userId = useApp((s) => s.userId);
  const brand = useApp((s) => s.brand);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(true);
  const live = useSiteLive();
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [draft, setDraft] = useState<ItemDraft>(() => emptyDraft(initial));
  const [variants, setVariants] = useState<CatalogVariant[]>([]);
  const [vd, setVd] = useState<Record<string, VDraft>>({});
  const [opts, setOpts] = useState<OptRow[]>([{ position: 1, name: '', values: '' }]);
  const [media, setMedia] = useState<CatalogMedia[]>([]);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<CatalogVariant[]>([]);
  const [newField, setNewField] = useState<{ label: string; kind: 'text' | 'multiline' } | null>(null);
  const [aiOk, setAiOk] = useState<boolean | null>(null);
  // a package's terms (2.87, migration 20261010004200): shown for kind "חבילה", written only when the database has them
  const [pkReady, setPkReady] = useState(false);
  const [types, setTypes] = useState<TreatmentType[]>([]);
  const [newType, setNewType] = useState<{ name: string; busy: boolean; error: string | null } | null>(null);
  const [ai, setAi] = useState<{ busy: boolean; proposal: ProductCopy | null; error: string | null }>({ busy: false, proposal: null, error: null });
  const sections = useRef<Record<string, HTMLElement | null>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  const say = (m: string) => { setNote(m); setError(null); setTimeout(() => setNote((x) => (x === m ? null : x)), 4000); };
  const fail = (m: string) => { setError(m); setNote(null); };

  const apply = useCallback((d: { item: CatalogItem; variants: CatalogVariant[]; options: CatalogOption[]; media: CatalogMedia[]; fields: FieldDef[]; ready: boolean }, keepDraft = false) => {
    setItem(d.item);
    if (!keepDraft) setDraft(draftOf(d.item));
    setVariants(d.variants);
    setVd(Object.fromEntries(d.variants.map((v) => [v.id, vdraftOf(v)])));
    setOpts(optRowsOf(d.options));
    setMedia(d.media);
    setFields(d.fields);
    setReady(d.ready);
  }, []);
  const reload = useCallback(async (id: string, keepDraft = true) => {
    const r = await loadProduct(id);
    if (!r.ok) { fail(r.error); return null; }
    apply(r.data, keepDraft);
    return r.data.item;
  }, [apply]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      if (itemId) {
        const r = await loadProduct(itemId);
        if (!alive) return;
        if (r.ok) apply(r.data); else fail(r.error);
      } else {
        const r = await loadFieldDefs();
        if (!alive) return;
        if (r.ok) { setFields(r.data.fields); setReady(r.data.ready); } else fail(r.error);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [itemId, apply]);
  useEffect(() => { AIService.available().then(setAiOk); }, []);
  const isPackage = draft.kind === 'package';
  useEffect(() => {
    if (!isPackage) return;
    let alive = true;
    void packagesReady().then(async (ok) => {
      if (!alive) return;
      setPkReady(ok);
      if (ok) { const t = await loadTreatmentTypes(); if (alive) setTypes(t); }
    });
    return () => { alive = false; };
  }, [isPackage]);
  /** a treatment type of the clinic (the client file's list, docs/CLIENT FILE ENGINEERING HE.md §3) — the owner and marked practitioners add */
  async function addType() {
    const name = newType?.name.trim() ?? '';
    if (!name) return;
    setNewType({ name, busy: true, error: null });
    try {
      const r = await fetch('/api/client-file/declarations', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ action: 'type-add', name }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setNewType({ name, busy: false, error: j?.code === 'no_access' ? 'סוגי טיפול מוסיפים בעלי העסק והמטפלים שסומנו (תיק לקוח).' : j?.message ?? 'לא נשמר — נסו שוב.' });
        return;
      }
      setTypes(await loadTreatmentTypes());
      if (j?.type?.id) set('packageTypeId', String(j.type.id));
      setNewType(null);
    } catch { setNewType({ name, busy: false, error: 'אין חיבור כרגע.' }); }
  }

  const set = <K extends keyof ItemDraft>(k: K, v: ItemDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const price = Number(draft.price.replace(/[₪,\s]/g, '')) || 0;
  const onlineNow = draft.onlinePrice.trim() ? Number(draft.onlinePrice.replace(/[₪,\s]/g, '')) : null;
  const gaps = publishGaps({ imageUrl: item?.imageUrl ?? '', description: draft.description }, media.length);
  const unassigned = item ? unassignedUnits(item, variants) : 0;

  // ---- save ----------------------------------------------------------------------------------------------------------------
  async function save(): Promise<CatalogItem | null> {
    const e = draftError(draft);
    if (e) { fail(e); return null; }
    setBusy('save');
    try {
      let d = draft;
      // every product gets its address in the store (from its name) — editable, unique in the business
      if (ready && !d.slug.trim() && slugify(d.name)) {
        d = { ...d, slug: uniqueSlug(slugify(d.name), await takenSlugs(item?.id)) };
        setDraft(d);
      }
      const all = itemColumns(d, fields, { packages: pkReady });
      // before migration 3300 only the register's columns exist
      const cols: Record<string, unknown> = ready ? all : { name: all.name, kind: all.kind, price: all.price, active: all.active };
      let saved: CatalogItem;
      if (!item) {
        const r = await insertItem(userId!, cols, nextSort);
        if (!r.ok) { fail(r.error); return null; }
        saved = r.data;
      } else {
        const r = await updateItem(item.id, changedColumns(cols, itemColumnsOf(item, { packages: pkReady }) as Record<string, unknown>));
        if (!r.ok) { fail(r.error); return null; }
        saved = r.data;
        // the variants' own fields
        for (const v of variants) {
          const x = vd[v.id];
          if (!x) continue;
          const c = variantColumns(x);
          if (!c.ok) { fail(`${variantLabel(v)}: ${c.error}`); return null; }
          const diff = changedColumns({ ...c.cols, media_id: x.mediaId } as Record<string, unknown>,
            { price: v.price, online_price: v.onlinePrice, sku: v.sku, barcode: v.barcode, low_stock: v.lowStock, active: v.active, media_id: v.mediaId });
          if (Object.keys(diff).length) {
            const u = await updateVariant(v.id, diff);
            if (!u.ok) { fail(`${variantLabel(v)}: ${u.error}`); return null; }
          }
        }
      }
      const fresh = (await reload(saved.id, false)) ?? saved;
      onSaved?.(fresh);
      say(item ? 'נשמר ✓' : 'המוצר נוצר ✓ — אפשר להוסיף תמונות ווריאנטים');
      return fresh;
    } finally { setBusy(null); }
  }
  /** pictures, variants and stock need the product to exist: a new one is saved first */
  async function ensureSaved(): Promise<CatalogItem | null> { return item ?? (await save()); }

  // ---- pictures --------------------------------------------------------------------------------------------------------------
  /** the files are copied when they are picked: the input is cleared at once (to pick the same file again) */
  async function addPictures(files: File[]) {
    if (!files.length) return;
    const it = await ensureSaved();
    if (!it) return;
    const list = files.slice(0, Math.max(0, MAX_PICTURES - media.length));
    if (list.length < files.length) fail(`עד ${MAX_PICTURES} תמונות למוצר — נוספו ${list.length}.`);
    let added = 0;
    for (const [k, f] of list.entries()) {
      setBusy(`העלאת תמונה ${k + 1} מתוך ${list.length}…`);
      const r = await uploadPicture(f, it.id, { alt: draft.name.trim() });
      if (r.ok) { added++; setMedia((m) => [...m, r.data]); } else { fail(r.error); break; }
    }
    setBusy(null);
    if (added) {
      const fresh = await reload(it.id);
      if (fresh) onSaved?.(fresh);
      say(added === 1 ? 'התמונה נוספה ✓' : `${added} תמונות נוספו ✓`);
    }
  }
  async function movePicture(m: CatalogMedia, dir: -1 | 1) {
    const list = [...media];
    const i = list.findIndex((x) => x.id === m.id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setBusy('order');
    for (const [k, x] of list.entries()) if (x.position !== k) { const r = await updateMedia(x.id, { position: k }); if (!r.ok) { fail(r.error); break; } }
    setBusy(null);
    if (item) { const fresh = await reload(item.id); if (fresh) onSaved?.(fresh); }
  }
  async function removePicture(m: CatalogMedia) {
    if (!window.confirm('למחוק את התמונה? היא תימחק גם מהקופה ומהאתר.')) return;
    setBusy('picture');
    const r = await mediaApi({ action: 'delete', mediaId: m.id });
    setBusy(null);
    if (!r.ok) return fail(r.error);
    if (item) { const fresh = await reload(item.id); if (fresh) onSaved?.(fresh); }
    say('התמונה נמחקה');
  }

  // ---- ✨ AI ---------------------------------------------------------------------------------------------------------------
  const optionsForBrief = opts.map((o) => ({ name: o.name, choices: splitList(o.values) }));
  async function writeWithAi() {
    if (!draft.name.trim()) return fail('קודם שם למוצר — ה-AI כותב לפיו.');
    setAi({ busy: true, proposal: null, error: null });
    try {
      const p = cleanProductCopy(await AIService.productCopy(brand, copyBrief(draft, optionsForBrief, fields)));
      setAi({ busy: false, proposal: p, error: p ? null : 'לא התקבל טקסט — נסו שוב.' });
    } catch (e) { setAi({ busy: false, proposal: null, error: aiErrorText(e) }); }
  }

  // ---- 📣 קדם מוצר (2.60): the main picture goes into the library, then the studio opens with it -----------------------------
  const router = useRouter();
  const [promoting, setPromoting] = useState(false);
  async function promote() {
    const dirty = Boolean(item) && Object.keys(changedColumns(itemColumns(draft, fields, { packages: pkReady }), itemColumnsOf(item!, { packages: pkReady }) as Record<string, unknown>)).length > 0;
    if (dirty && !window.confirm('יש שינויים שלא נשמרו. לעבור לאולפן היצירה בלי לשמור?')) return;
    setPromoting(true);
    const main = [...media].sort((a, b) => a.position - b.position)[0];
    let mediaId: string | null = null;
    if (main && userId) {
      const asset = { id: crypto.randomUUID(), url: pickSize(main, 1600), name: draft.name.trim().slice(0, 200), kind: 'image' as const, persistent: false };
      await Repo.saveMedia(userId, asset);
      useApp.setState((st) => ({ media: [{ ...asset, persistent: true }, ...st.media] }));
      mediaId = asset.id;
    }
    router.push(promoteUrl(promoteBrief(draft), mediaId));
  }

  // ---- variants ------------------------------------------------------------------------------------------------------------
  async function applyOptions() {
    const filled = opts.filter((o) => o.name.trim() || o.values.trim());
    if (filled.some((o) => !o.name.trim() || !splitList(o.values).length)) return fail('לכל אפשרות צריך שם וערכים — למשל: מידה — S, M, L.');
    const names = filled.map((o) => o.name.trim().toLocaleLowerCase('he'));
    if (new Set(names).size !== names.length) return fail('שתי אפשרויות באותו שם.');
    if (filled.some((o) => o.name.trim().length > LIMITS.option)) return fail(`שם של אפשרות עד ${LIMITS.option} תווים.`);
    const list = filled.map((o, k) => ({ position: k + 1, name: o.name.trim(), choices: splitList(o.values) }));
    const plan = planVariants(list, variants);
    if (!plan.ok) return fail(plan.error);
    const it = await ensureSaved();
    if (!it) return;
    setBusy('variants');
    try {
      const so = await saveOptions(it.id, list);
      if (!so.ok) return fail(so.error);
      const cv = await createVariants(it.id, plan.create, variants.reduce((a, v) => Math.max(a, v.position), 0) + 1);
      if (!cv.ok) return fail(cv.error);
      setOrphans(plan.orphan);
      const fresh = await reload(it.id);
      if (fresh) onSaved?.(fresh);
      say(plan.create.length ? `נוספו ${plan.create.length} וריאנטים ✓` : 'האפשרויות נשמרו ✓');
    } finally { setBusy(null); }
  }
  async function removeVariant(v: CatalogVariant) {
    if (!window.confirm(`למחוק את הווריאנט "${variantLabel(v)}"? מכירות קודמות לא ישתנו. ${v.stockQty ? `${v.stockQty} היחידות שלו יישארו במוצר כ"לא משויך". ` : ''}כדי רק להפסיק למכור — עדיף לכבות אותו.`)) return;
    setBusy('variant');
    const r = await deleteVariant(v.id);
    setBusy(null);
    if (!r.ok) return fail(r.error);
    setOrphans((o) => o.filter((x) => x.id !== v.id));
    if (item) { const fresh = await reload(item.id); if (fresh) onSaved?.(fresh); }
  }
  async function hideVariant(v: CatalogVariant) {
    const r = await updateVariant(v.id, { active: false });
    if (!r.ok) return fail(r.error);
    setOrphans((o) => o.filter((x) => x.id !== v.id));
    if (item) await reload(item.id);
  }

  // ---- stock -----------------------------------------------------------------------------------------------------------------
  async function moveStock(target: { kind: 'item'; id: string } | { kind: 'variant'; id: string; label: string }, mode: 'add' | 'set', raw: string) {
    const qty = Number(raw);
    if (!Number.isInteger(qty) || (mode === 'add' ? qty <= 0 : qty < 0)) return fail(mode === 'add' ? 'כמה יחידות התקבלו? מספר שלם, 1 או יותר.' : 'הספירה: מספר שלם, 0 או יותר.');
    setBusy('stock');
    const r = target.kind === 'item' ? await adjustItemStock(target.id, mode, qty) : await adjustVariantStock(target.id, mode, qty);
    setBusy(null);
    if (!r.ok) return fail(r.error);
    if (item) { const fresh = await reload(item.id); if (fresh) onSaved?.(fresh); }
    say(mode === 'add' ? `נוספו ${qty} יחידות ✓` : `הספירה נשמרה: ${r.data} ✓`);
  }
  async function reconcile() {
    if (!item) return;
    if (!window.confirm(`המלאי של המוצר יהיה סכום הווריאנטים (${variants.reduce((a, v) => a + v.stockQty, 0)}). עושים את זה אחרי שסופרים כל וריאנט. להמשיך?`)) return;
    setBusy('stock');
    const r = await reconcileVariantStock(item.id);
    setBusy(null);
    if (!r.ok) return fail(r.error);
    const fresh = await reload(item.id);
    if (fresh) onSaved?.(fresh);
    say('המלאי של המוצר תואם עכשיו לווריאנטים ✓');
  }

  // ---- fields ----------------------------------------------------------------------------------------------------------------
  async function createField() {
    if (!newField?.label.trim()) return fail('שם לשדה — למשל "טבלת מידות" או "הוראות כביסה".');
    const r = await addFieldDef(newFieldKey(fields.map((f) => f.key)), newField.label.slice(0, 40), newField.kind, fields.length);
    if (!r.ok) return fail(r.error);
    setFields((f) => [...f, r.data]);
    setNewField(null);
  }

  // ---- focus (from "חסר לפני פרסום", the register's stock button) -------------------------------------------------------------
  useEffect(() => {
    if (loading || focused.current || !focus) return;
    focused.current = true;
    const key = focus === 'ai' ? 'description' : focus;
    setTimeout(() => sections.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    // (a file picker opens only from the user's own tap — the images part is shown, the button is right there)
    if (focus === 'ai' && aiOk !== false) void writeWithAi();
  }, [loading, focus, aiOk]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = (k: string) => (el: HTMLElement | null) => { sections.current[k] = el; };

  const takenOptionNames = useMemo(() => opts.map((o) => o.name), [opts]);
  if (loading) return <div className="py-10 text-center"><Spinner /></div>;
  const isProductKind = draft.kind === 'product' || item?.trackStock;

  return (
    <div className="grid gap-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-2xl font-extrabold">{item ? item.name : isPackage ? 'חבילה חדשה' : 'מוצר חדש'}</h2>
          <p className="text-sm text-muted">מוצר אחד לקופה, לכספים ולאתר — שינוי כאן מופיע מיד בכל המקומות.</p>
        </div>
        {onClose && <CloseButton onClick={onClose} />}
      </div>
      {!ready && <p role="status" className="rounded-2xl bg-amber-500/15 p-3 text-sm font-semibold text-amber-800 dark:text-amber-200">{MIGRATION_3300} עד אז אפשר לשנות כאן שם, סוג ומחיר בלבד.</p>}

      <Section id="basics" title="פרטים" sectionRef={ref('basics')}>
        <Field label="שם (בקופה, במסמכים ובאתר)"><Input value={draft.name} maxLength={LIMITS.name} onChange={(e) => set('name', e.target.value)} placeholder="למשל: חולצת כותנה" /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="סוג"><Select value={draft.kind} onChange={(e) => set('kind', e.target.value as ItemKind)}>{Object.entries(KIND_HE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="מחיר בקופה ₪ (כולל מע״מ)"><Input inputMode="decimal" value={draft.price} onChange={(e) => set('price', e.target.value)} placeholder="0" /></Field>
          <label className="mb-4 flex min-h-11 items-center gap-2 self-end text-sm font-semibold">
            <input type="checkbox" checked={draft.active} onChange={(e) => set('active', e.target.checked)} className="h-5 w-5" />מוצג בקופה
          </label>
        </div>
      </Section>

      {isPackage && (
        <Section id="package" title="תנאי החבילה" sectionRef={ref('package')}
          hint="מה הלקוח/ה מקבל/ת: כמה טיפולים, לאיזה סוג טיפול, ולכמה זמן. כך החבילה נמכרת מכרטיס הלקוח, והטיפולים נוכים ממנה. שינוי כאן לא משנה חבילה שכבר נמכרה.">
          {!pkReady ? <p className="text-sm text-muted">{MIGRATION_4200} עד אז החבילה נמכרת בקופה כמו כל פריט.</p> : <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="מספר טיפולים"><Input inputMode="numeric" value={draft.packageSessions} placeholder="למשל 6"
                onChange={(e) => set('packageSessions', e.target.value.replace(/\D/g, '').slice(0, 3))} /></Field>
              <Field label="סוג טיפול">
                <Select value={draft.packageTypeId} onChange={(e) => (e.target.value === '+' ? setNewType({ name: '', busy: false, error: null }) : set('packageTypeId', e.target.value))}>
                  <option value="">כל טיפול</option>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.active ? '' : ' (לא פעיל)'}</option>)}
                  <option value="+">+ סוג טיפול חדש…</option>
                </Select>
              </Field>
              <Field label="תוקף בחודשים (ריק = בלי הגבלה)"><Input inputMode="numeric" value={draft.packageValidMonths} placeholder="למשל 6"
                onChange={(e) => set('packageValidMonths', e.target.value.replace(/\D/g, '').slice(0, 3))} /></Field>
            </div>
            {newType && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Input value={newType.name} maxLength={80} autoFocus placeholder="שם סוג הטיפול (למשל לייזר)" aria-label="סוג טיפול חדש" className="max-w-xs py-2"
                  onChange={(e) => setNewType({ ...newType, name: e.target.value, error: null })} />
                <Button size="sm" variant="primary" disabled={newType.busy || !newType.name.trim()} onClick={() => void addType()}>{newType.busy ? <Spinner /> : 'הוספה'}</Button>
                <Button size="sm" variant="ghost" onClick={() => setNewType(null)}>ביטול</Button>
                {newType.error && <p role="alert" className="w-full text-sm text-(--danger)">{newType.error}</p>}
              </div>
            )}
            {!draft.packageSessions.trim() && <p className="text-xs text-amber-700 dark:text-amber-300">בלי מספר טיפולים, החבילה נמכרת בקופה כפריט — אבל לא נמכרת ללקוח כחבילה שמנכים ממנה.</p>}
            <p className="text-xs text-muted">סוג הטיפול: ניכוי מוצע רק לטיפול מאותו סוג (&quot;כל טיפול&quot; — לכל טיפול). תנאים והערות ללקוח — בשדה &quot;תיאור&quot;.</p>
          </>}
        </Section>
      )}

      <Section id="images" title="תמונות" sectionRef={ref('images')}
        hint={`עד ${MAX_PICTURES} תמונות. הראשונה היא התמונה הראשית (גם במשבצת בקופה). הגדלים לאתר נעשים במכשיר — גם תמונה גדולה מהטלפון עולה מהר.`}>
        {!ready ? <p className="text-sm text-muted">{MIGRATION_3300}</p> : <>
          {media.length > 0 && (
            <ul className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {media.map((m, k) => (
                <li key={m.id} className="rounded-xl border border-line p-2">
                  <div className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pickSize(m, 400)} alt={m.alt || draft.name} className="aspect-square w-full rounded-lg bg-surface-2 object-cover" loading="lazy" />
                    {k === 0 && <span className="absolute right-1 top-1 rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold text-white">ראשית</span>}
                  </div>
                  <Input defaultValue={m.alt} maxLength={LIMITS.alt} placeholder="מה רואים בתמונה (לנגישות)" aria-label={`תיאור תמונה ${k + 1}`} className="mt-2 px-2 py-1.5 text-xs"
                    onBlur={async (e) => { const alt = e.target.value.trim(); if (alt !== m.alt) { const r = await updateMedia(m.id, { alt }); if (!r.ok) fail(r.error); else setMedia((all) => all.map((x) => (x.id === m.id ? { ...x, alt } : x))); } }} />
                  <div className="mt-2 flex items-center justify-between">
                    <span className="flex gap-1">
                      <button type="button" disabled={k === 0 || Boolean(busy)} onClick={() => void movePicture(m, -1)} aria-label={`תמונה ${k + 1}: קדימה`} className="h-9 w-9 rounded-full border border-line disabled:opacity-40">→</button>
                      <button type="button" disabled={k === media.length - 1 || Boolean(busy)} onClick={() => void movePicture(m, 1)} aria-label={`תמונה ${k + 1}: אחורה`} className="h-9 w-9 rounded-full border border-line disabled:opacity-40">←</button>
                    </span>
                    <button type="button" disabled={Boolean(busy)} onClick={() => void removePicture(m)} className="text-xs font-semibold text-(--danger)">מחיקה</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <input ref={fileInput} type="file" accept="image/*" multiple className="sr-only" aria-label="בחירת תמונות" onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ''; void addPictures(picked); }} />
          <Button variant={media.length ? 'ghost' : 'primary'} disabled={Boolean(busy) || media.length >= MAX_PICTURES}
            onClick={async () => { if (!item) { const it = await save(); if (!it) return; } fileInput.current?.click(); }}>
            <ImageGlyph size={18} aria-hidden />{media.length ? 'הוספת תמונות' : item ? 'בחירת תמונות' : 'שמירה ובחירת תמונות'}
          </Button>
        </>}
      </Section>

      <Section id="description" title="תיאור" sectionRef={ref('description')} hint="מה הלקוח צריך לדעת: ממה זה עשוי, למי זה מתאים, איך משתמשים.">
        <Textarea value={draft.description} maxLength={LIMITS.description} rows={6} onChange={(e) => set('description', e.target.value)} aria-label="תיאור המוצר" placeholder="תיאור המוצר באתר" />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted tabular-nums">{draft.description.length}/{LIMITS.description}</span>
          {ready && <Button size="sm" variant="ghost" disabled={ai.busy || aiOk === false} onClick={() => void writeWithAi()} title={aiOk === false ? 'ה-AI לא מוגדר בשרת' : undefined}>
            {ai.busy ? <><Spinner />ה-AI כותב…</> : '✨ תיאור מה-AI'}</Button>}
        </div>
        {aiOk === false && <p className="mt-1 text-xs text-muted">ה-AI לא מוגדר בשרת — כותבים ידנית.</p>}
        {ai.error && <p role="alert" className="mt-2 text-sm text-(--danger)">{ai.error}</p>}
        {ai.proposal && (
          <div className="mt-3 rounded-2xl border border-primary/40 bg-primary-soft p-3 text-sm">
            <p className="mb-1 font-bold">✨ הצעה מה-AI — לקרוא לפני שמשתמשים. היא תישמר רק אחרי &quot;שמירה&quot;.</p>
            <p className="whitespace-pre-line">{ai.proposal.description}</p>
            {ai.proposal.seoTitle && <p className="mt-2 text-xs text-ink-2"><strong>כותרת לגוגל:</strong> {ai.proposal.seoTitle}</p>}
            {ai.proposal.seoDescription && <p className="text-xs text-ink-2"><strong>תיאור לגוגל:</strong> {ai.proposal.seoDescription}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => {
                const p = ai.proposal!;
                setDraft((d) => ({ ...d, description: p.description, seoTitle: p.seoTitle || d.seoTitle, seoDescription: p.seoDescription || d.seoDescription }));
                setAi({ busy: false, proposal: null, error: null });
              }}>שימוש בטקסט</Button>
              <Button size="sm" variant="ghost" onClick={() => void writeWithAi()}>הצעה אחרת</Button>
              <Button size="sm" variant="ghost" onClick={() => setAi({ busy: false, proposal: null, error: null })}>ביטול</Button>
            </div>
          </div>
        )}
      </Section>

      {ready && (
        <Section id="online" title="באתר" sectionRef={ref('online')} hint={live ? SITE_LIVE : SITE_NOT_LIVE}>
          {item?.id && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3">
              <span className="text-sm"><strong className="block">📣 קדם מוצר</strong><span className="text-xs text-muted">פוסט עם התמונה והתיאור — באולפן היצירה, שם עורכים ומתזמנים.</span></span>
              <Button size="sm" variant="soft" disabled={promoting} onClick={() => void promote()}>{promoting ? <><Spinner /> פותח…</> : 'קדם מוצר'}</Button>
            </div>
          )}
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-surface-2 p-3">
            <span>
              <strong className="block">פרסם באתר</strong>
              <span className="text-xs text-muted">{draft.publishOnline ? 'יופיע בחנות באתר' : 'כבוי — המוצר לא יופיע באתר'}{draft.publishOnline && gaps.length ? ` · מומלץ להוסיף ${gaps.map((g) => (g === 'image' ? 'תמונה' : 'תיאור')).join(' ו')}` : ''}</span>
            </span>
            <Switch on={draft.publishOnline} onClick={() => set('publishOnline', !draft.publishOnline)} label="פרסם באתר" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="מחיר באתר ₪ (לא חובה)"><Input inputMode="decimal" value={draft.onlinePrice} onChange={(e) => set('onlinePrice', e.target.value)} placeholder={`ריק = מחיר הקופה (${ils(price)})`} /></Field>
            <Field label="מחיר לפני הנחה ₪ (לא חובה)"><Input inputMode="decimal" value={draft.compareAtPrice} onChange={(e) => set('compareAtPrice', e.target.value)} placeholder="מוצג מחוק, ליד המחיר" /></Field>
          </div>
          <Field label="כתובת המוצר באתר">
            <div className="flex gap-2">
              <Input dir="auto" value={draft.slug} maxLength={LIMITS.slug} onChange={(e) => set('slug', e.target.value.trim().toLowerCase())} placeholder={slugify(draft.name) || 'נוצרת מהשם בשמירה'} />
              <Button size="sm" variant="ghost" onClick={() => set('slug', slugify(draft.name))}>מהשם</Button>
            </div>
          </Field>
          {draft.slug && <p className="-mt-2 mb-4 text-xs text-muted" dir="ltr">/products/{draft.slug}</p>}
          <Field label={`כותרת לגוגל (${draft.seoTitle.length}/${SEO_SHOWN.title})`}><Input value={draft.seoTitle} maxLength={LIMITS.seoTitle} onChange={(e) => set('seoTitle', e.target.value)} placeholder={draft.name || 'ריק = שם המוצר'} /></Field>
          <Field label={`תיאור לגוגל (${draft.seoDescription.length}/${SEO_SHOWN.description})`}><Textarea value={draft.seoDescription} maxLength={LIMITS.seoDescription} rows={3} onChange={(e) => set('seoDescription', e.target.value)} placeholder="ריק = תחילת התיאור" /></Field>
          <Field label="תגיות (בפסיקים)"><Input value={draft.tags} onChange={(e) => set('tags', e.target.value)} placeholder="קיץ, כותנה, מבצע" /></Field>
          {draft.seoTitle.length > SEO_SHOWN.title && <p className="text-xs text-warn">גוגל מציג בערך {SEO_SHOWN.title} תווים מהכותרת — השאר ייחתך.</p>}
        </Section>
      )}

      {ready && (
        <Section id="variants" title="וריאנטים (מידות, צבעים)" sectionRef={ref('variants')}
          hint="לא חובה. מוצר בלי וריאנטים נמכר כמו היום. עם וריאנטים — בקופה בוחרים מידה/צבע, והמלאי נספר לכל וריאנט.">
          <div className="grid gap-2">
            {opts.map((o, k) => (
              <div key={k} className="grid gap-2 sm:grid-cols-[160px_1fr_auto]">
                <Input value={o.name} maxLength={LIMITS.option} onChange={(e) => setOpts((all) => all.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)))}
                  placeholder={['מידה', 'צבע', 'חומר'][k] ?? 'אפשרות'} aria-label={`שם אפשרות ${k + 1}`} list="pe-option-names" />
                <Input value={o.values} onChange={(e) => setOpts((all) => all.map((x, j) => (j === k ? { ...x, values: e.target.value } : x)))}
                  placeholder={['S, M, L, XL', 'שחור, לבן', 'כותנה, פשתן'][k] ?? 'ערכים, בפסיקים'} aria-label={`ערכים של אפשרות ${k + 1}`} />
                <button type="button" aria-label={`הסרת אפשרות ${k + 1}`} className="h-11 text-sm text-muted"
                  onClick={() => setOpts((all) => (all.length > 1 ? all.filter((_, j) => j !== k) : [{ position: 1, name: '', values: '' }]))}>הסרה</button>
              </div>
            ))}
            <datalist id="pe-option-names">{['מידה', 'צבע', 'חומר', 'גודל', 'נפח', 'טעם'].filter((n) => !takenOptionNames.includes(n)).map((n) => <option key={n} value={n} />)}</datalist>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {opts.length < MAX_OPTIONS && <Button size="sm" variant="ghost" onClick={() => setOpts((all) => [...all, { position: all.length + 1, name: '', values: '' }])}>+ אפשרות</Button>}
            <Button size="sm" variant="primary" disabled={Boolean(busy)} onClick={() => void applyOptions()}>{variants.length ? 'עדכון הווריאנטים' : 'יצירת וריאנטים'}</Button>
          </div>
          {orphans.length > 0 && (
            <div className="mt-3 rounded-xl bg-amber-500/15 p-3 text-sm">
              <p className="font-semibold">וריאנטים שאף אפשרות לא מתארת עכשיו (לא נמחקו — ייתכן שיש להם מלאי והיסטוריה):</p>
              <ul className="mt-2 grid gap-1">{orphans.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2">
                  <strong>{variantLabel(v) || 'ללא שם'}</strong>{v.stockQty ? <span className="text-xs">(במלאי {v.stockQty})</span> : null}
                  <Button size="sm" variant="ghost" onClick={() => void hideVariant(v)}>הסתרה</Button>
                  <Button size="sm" variant="ghost" onClick={() => void removeVariant(v)}>מחיקה</Button>
                </li>
              ))}</ul>
            </div>
          )}

          {item && unassigned !== 0 && (
            <div role="status" className="mt-4 rounded-xl bg-amber-500/15 p-3 text-sm">
              <p><strong>{unassigned > 0 ? `${unassigned} יחידות` : `${-unassigned} יחידות נמכרו`} לא משויכות לאף וריאנט</strong> — {unassigned > 0 ? 'מלאי מלפני הווריאנטים, או החזרה בלי בחירת וריאנט' : 'מכירה בלי בחירת וריאנט (למשל עסקה שהושהתה לפני שנוספו הווריאנטים)'}.
                סופרים כל וריאנט (&quot;ספירה&quot;), ואז &quot;סיום ספירה&quot; משווה את המלאי של המוצר לסכום הווריאנטים.</p>
              <Button size="sm" variant="ghost" className="mt-2" disabled={Boolean(busy)} onClick={() => void reconcile()}>סיום ספירה</Button>
            </div>
          )}

          {variants.length > 0 && item && (
            <ul className="mt-4 grid gap-3">
              {variants.map((v) => {
                const x = vd[v.id] ?? vdraftOf(v);
                const setX = (p: Partial<VDraft>) => setVd((all) => ({ ...all, [v.id]: { ...x, ...p } }));
                const lvl = variantLevel(item, v);
                return (
                  <li key={v.id} className={cx('rounded-xl border border-line p-3', !x.active && 'opacity-70')}>
                    <div className="flex items-center justify-between gap-2">
                      <strong>{variantLabel(v) || 'ללא שם'}</strong>
                      <span className="flex items-center gap-3">
                        <label className="flex items-center gap-2 text-xs font-semibold">פעיל<Switch on={x.active} onClick={() => setX({ active: !x.active })} label={`פעיל: ${variantLabel(v)}`} /></label>
                        <button type="button" onClick={() => void removeVariant(v)} className="text-xs font-semibold text-(--danger)" aria-label={`מחיקת ${variantLabel(v)}`}>מחיקה</button>
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <label className="text-xs text-muted">מחיר בקופה<Input inputMode="decimal" value={x.price} onChange={(e) => setX({ price: e.target.value })} placeholder={ils(posPrice({ price }, null))} className="mt-1 px-3 py-2" /></label>
                      <label className="text-xs text-muted">מחיר באתר<Input inputMode="decimal" value={x.onlinePrice} onChange={(e) => setX({ onlinePrice: e.target.value })}
                        placeholder={ils(onlinePriceOf({ price, onlinePrice: onlineNow }, { price: x.price.trim() ? Number(x.price) : null, onlinePrice: null }))} className="mt-1 px-3 py-2" /></label>
                      <label className="text-xs text-muted">מק״ט<Input value={x.sku} maxLength={LIMITS.sku} onChange={(e) => setX({ sku: e.target.value })} className="mt-1 px-3 py-2" /></label>
                      <label className="text-xs text-muted">ברקוד<Input value={x.barcode} inputMode="numeric" onChange={(e) => setX({ barcode: e.target.value.trim() })} className="mt-1 px-3 py-2" /></label>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      {item.trackStock ? (
                        <span className={cx('rounded-full px-2.5 py-1 text-xs font-bold tabular-nums', lvl === 'out' ? 'bg-red-500/15 text-red-700 dark:text-red-300' : lvl === 'low' ? 'bg-amber-500/15 text-amber-800 dark:text-amber-200' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300')}>
                          📦 {v.stockQty <= 0 ? (v.stockQty < 0 ? `חסר (${v.stockQty})` : 'אזל') : `במלאי ${v.stockQty}`}</span>
                      ) : <span className="text-xs text-muted">המלאי לא נספר עדיין</span>}
                      <StockButtons label={variantLabel(v)} disabled={Boolean(busy)} onMove={(mode, raw) => void moveStock({ kind: 'variant', id: v.id, label: variantLabel(v) }, mode, raw)} />
                      <label className="flex items-center gap-1 text-xs text-muted">התראה מתחת ל-
                        <Input inputMode="numeric" value={x.lowStock} onChange={(e) => setX({ lowStock: e.target.value })} placeholder={String(item.lowStock)} className="h-8 w-14 px-2 py-0 text-center" aria-label={`רמת התראה: ${variantLabel(v)}`} />
                      </label>
                      {media.length > 0 && (
                        <SmallSelect value={x.mediaId ?? ''} onChange={(e) => setX({ mediaId: e.target.value || null })} className="w-32" aria-label={`תמונה: ${variantLabel(v)}`}>
                          <option value="">בלי תמונה</option>
                          {media.map((m, k) => <option key={m.id} value={m.id}>תמונה {k + 1}</option>)}
                        </SmallSelect>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      {item && !item.hasVariants && isProductKind && (
        <Section id="stock" title="מלאי" sectionRef={ref('stock')} hint="כל מכירה מורידה מהמלאי לבד. קבלה מוסיפה יחידות; ספירה קובעת את מה שיש בפועל.">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-surface-2 px-3 py-1 font-bold tabular-nums">📦 {item.trackStock ? (item.stockQty <= 0 ? 'אזל' : `במלאי ${item.stockQty}`) : 'עוד לא נספר'}</span>
            <StockButtons label={item.name} disabled={Boolean(busy)} onMove={(mode, raw) => void moveStock({ kind: 'item', id: item.id }, mode, raw)} />
            <label className="flex items-center gap-1 text-xs text-muted">התראה מתחת ל-
              <Input type="number" min={0} defaultValue={item.lowStock} className="h-8 w-16 px-2 py-0 text-center" aria-label="רמת התראה"
                onBlur={async (e) => { const v = Math.max(0, Math.floor(Number(e.target.value) || 0)); if (v !== item.lowStock) { const r = await setLowStock(item.id, v); if (!r.ok) fail(r.error); else await reload(item.id); } }} />
            </label>
          </div>
        </Section>
      )}

      {ready && (
        <Section id="codes" title="קודים ופרטים" sectionRef={ref('codes')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="מק״ט (SKU)"><Input value={draft.sku} maxLength={LIMITS.sku} onChange={(e) => set('sku', e.target.value)} /></Field>
            <Field label={item?.hasVariants ? 'ברקוד (לכל וריאנט — למטה)' : 'ברקוד'}><Input inputMode="numeric" value={draft.barcode} onChange={(e) => set('barcode', e.target.value.trim())} placeholder="סורקים או מקלידים" /></Field>
            <Field label="יצרן"><Input value={draft.manufacturer} maxLength={LIMITS.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></Field>
            <Field label="ארץ ייצור"><Input value={draft.countryOfOrigin} maxLength={LIMITS.country} onChange={(e) => set('countryOfOrigin', e.target.value)} /></Field>
          </div>
          <p className="text-xs text-muted">יצרן וארץ ייצור — ייתכן שחובה להציג אותם במכירה באתר. טעון בדיקה מול עורך דין לפני שהחנות עולה.</p>
        </Section>
      )}

      {ready && (
        <Section id="fields" title="שדות נוספים" sectionRef={ref('fields')} hint="שדות של העסק, לכל המוצרים: טבלת מידות, רכיבים, הוראות כביסה…">
          {fields.map((f) => (
            <Field key={f.id} label={f.label}>
              {f.kind === 'multiline'
                ? <Textarea rows={3} value={draft.customFields[f.key] ?? ''} maxLength={LIMITS.field} onChange={(e) => set('customFields', { ...draft.customFields, [f.key]: e.target.value })} />
                : <Input value={draft.customFields[f.key] ?? ''} maxLength={LIMITS.field} onChange={(e) => set('customFields', { ...draft.customFields, [f.key]: e.target.value })} />}
            </Field>
          ))}
          {newField ? (
            <div className="grid gap-2 rounded-xl bg-surface-2 p-3 sm:grid-cols-[1fr_150px_auto_auto]">
              <Input autoFocus value={newField.label} maxLength={40} onChange={(e) => setNewField({ ...newField, label: e.target.value })} placeholder="שם השדה" aria-label="שם השדה החדש" />
              <Select value={newField.kind} onChange={(e) => setNewField({ ...newField, kind: e.target.value === 'multiline' ? 'multiline' : 'text' })} aria-label="סוג השדה">
                <option value="text">שורה אחת</option><option value="multiline">כמה שורות</option>
              </Select>
              <Button size="sm" variant="primary" onClick={() => void createField()}>הוספה</Button>
              <Button size="sm" variant="ghost" onClick={() => setNewField(null)}>ביטול</Button>
            </div>
          ) : <Button size="sm" variant="ghost" onClick={() => setNewField({ label: '', kind: 'text' })}>+ שדה חדש</Button>}
        </Section>
      )}

      {item && (
        <div className="flex justify-start">
          <button type="button" className="text-sm font-semibold text-(--danger)" disabled={Boolean(busy)} onClick={async () => {
            if (!window.confirm(`למחוק את "${item.name}"? מכירות ומסמכים קודמים לא ישתנו. התמונות יימחקו.`)) return;
            setBusy('delete');
            const r = await deleteItem(item.id, media.length > 0);
            setBusy(null);
            if (!r.ok) return fail(r.error);
            onDeleted?.(item.id);
          }}>מחיקת המוצר</button>
        </div>
      )}

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 border-t border-line bg-surface/95 px-1 py-3 backdrop-blur-sm">
        <Button variant="primary" disabled={Boolean(busy)} onClick={() => void save()}>{busy === 'save' ? <><Spinner />שומר…</> : item ? 'שמירה' : isPackage ? 'יצירת החבילה' : 'יצירת המוצר'}</Button>
        {onClose && <Button variant="ghost" onClick={onClose}>סגירה</Button>}
        {busy && busy !== 'save' && <span className="flex items-center gap-2 text-sm text-muted"><Spinner />{busy.includes('…') ? busy : 'רגע…'}</span>}
        {note && <span role="status" className="text-sm font-semibold text-ok">{note}</span>}
        {error && <span role="alert" className="text-sm font-semibold text-(--danger)">{error}</span>}
      </div>
    </div>
  );
}

/** "קבלה" (add) / "ספירה" (set) with a number — no window.prompt (phones show it badly) */
function StockButtons({ label, disabled, onMove }: { label: string; disabled?: boolean; onMove: (mode: 'add' | 'set', raw: string) => void }) {
  const [qty, setQty] = useState('');
  return (
    <span className="inline-flex items-center gap-1">
      <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ''))} placeholder="כמות" aria-label={`כמות: ${label}`} className="h-9 w-16 px-2 py-0 text-center" />
      <Button size="sm" variant="ghost" disabled={disabled || !qty} onClick={() => { onMove('add', qty); setQty(''); }}>+ קבלה</Button>
      <Button size="sm" variant="ghost" disabled={disabled || qty === ''} onClick={() => { onMove('set', qty); setQty(''); }}>ספירה</Button>
    </span>
  );
}

/** the editor in a window over the screen that opened it (the register, finance, the store's list) */
export function ProductEditorDialog({ open, onClose, ...p }: EditorProps & { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} wide>
      {open && <ProductEditor key={p.itemId ?? 'new'} {...p} onClose={onClose} />}
    </Modal>
  );
}
