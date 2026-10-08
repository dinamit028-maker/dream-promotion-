'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { cx } from '@/lib/utils';
import { Button, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { applyKit, bookingUrl, loadStore, type KitApplied, type StoreBundle } from './data';
import { KITS, kitById, kitFor, planKit, type ApplyMode, type Kit, type KitChoices, type KitContext, type KitPlan } from './kits';
import { PreviewButton } from './StoreSettings';
import { POLICY_LABEL, type StoreRow } from './store';
import { Block, Notice } from './ui';
import { storeHref } from './routes';

/**
 * Starter kits (2.58) in the dashboard: the gallery ("החלפת ערכה") and the plan of one kit before it is applied — what it
 * creates, what it keeps, and what it would replace only if the owner ticks it. Applying writes a draft: the site changes
 * only after "פרסום" in Design (except a store that never published a theme — its site is still closed).
 */

/** the business's field (its profile) and booking page → what a kit needs to fill itself in */
export function useKitContext(store: StoreRow | null): { ctx: KitContext | null; industry: string } {
  const brand = useApp((s) => s.brand);
  const [booking, setBooking] = useState<string | null>(null);
  useEffect(() => { let on = true; void bookingUrl(window.location.origin).then((u) => { if (on) setBooking(u); }); return () => { on = false; }; }, []);
  const industry = [brand?.industry, brand?.description].filter(Boolean).join(' ');
  if (!store || booking === null) return { ctx: null, industry };
  return { industry, ctx: { name: store.name, booking, business: { name: store.name, phone: store.phone, email: store.email, address: store.address } } };
}

/** the kit a store is on now: the one its latest draft or published theme came from ('' = none, e.g. the first template) */
export function currentKit(b: Pick<StoreBundle, 'versions'>): Kit | null {
  const v = b.versions.find((x) => x.status === 'draft') ?? b.versions.find((x) => x.status === 'published');
  const id = v && typeof v.settings.kit === 'string' ? v.settings.kit : '';
  return id ? kitById(id) : null;
}

/** a new store: its field's kit, right after it is opened (nothing of the business's can be replaced — it is empty) */
export async function applyFieldKit(industry: string, ctx: KitContext): Promise<{ ok: true; kit: Kit; done: KitApplied } | { ok: false; error: string }> {
  const kit = kitFor(industry);
  const b = await loadStore();
  if (!b.ok || !b.data.store) return { ok: false, error: b.ok ? 'החנות לא נמצאה.' : b.error };
  const plan = planKit(kit, b.data, ctx);
  const r = await applyKit(b.data.store.id, plan, { replacePages: [], replaceMenus: [], replaceDraft: false });
  return r.ok ? { ok: true, kit, done: r.data } : { ok: false, error: r.error };
}

export function KitGallery({ bundle, onApplied, onClose }: { bundle: StoreBundle; onApplied: (kit: Kit, done: KitApplied) => Promise<void> | void; onClose: () => void }) {
  const store = bundle.store!;
  const { ctx, industry } = useKitContext(store);
  const current = currentKit(bundle);
  const suggested = useMemo(() => kitFor(industry), [industry]);
  const [chosen, setChosen] = useState<{ kit: Kit; mode: ApplyMode } | null>(null);
  if (chosen && ctx) return <KitPlanView kit={chosen.kit} mode={chosen.mode} bundle={bundle} ctx={ctx} onBack={() => setChosen(null)} onApplied={onApplied} />;
  return (
    <Block title="ערכות הקמה" sub="תצוגה מקדימה מראה את החנות שלכם בערכה, בלי לשמור כלום. החלפת עיצוב משנה רק את המראה; ערכה מלאה מוסיפה גם עמודים, תפריטים וקולקציות. המוצרים שלכם לא משתנים."
      action={<Button variant="ghost" size="sm" onClick={onClose}>סגירה</Button>}>
      {!ctx && <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> טוען…</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {KITS.map((k) => (
          <li key={k.id} className={cx('flex flex-col rounded-lg border p-3', k.id === current?.id ? 'border-primary' : 'border-line')}>
            <div className="mb-2 flex h-12 overflow-hidden rounded-md border border-line" aria-hidden="true">
              {(['background', 'accentSoft', 'accent', 'primary'] as const).map((c) => (
                <span key={c} className="flex-1" style={{ background: k.theme.colors[c] }} />
              ))}
            </div>
            <span className="flex flex-wrap items-center gap-2 font-semibold">
              {k.name}
              {k.id === current?.id && <Pill tone="ok">הערכה הנוכחית</Pill>}
              {k.id === suggested.id && k.id !== current?.id && <Pill tone="default">מתאימה לתחום שלכם</Pill>}
            </span>
            <span className="mb-3 mt-1 flex-1 text-sm text-muted">{k.description}</span>
            <div className="flex flex-wrap gap-2">
              <PreviewButton label="תצוגה מקדימה" kit={{ id: k.id, mode: 'design' }} size="sm" variant="soft" />
              {k.id !== current?.id && <Button variant="soft" size="sm" disabled={!ctx} onClick={() => setChosen({ kit: k, mode: 'design' })}>החלפת עיצוב</Button>}
              <Button variant="ghost" size="sm" disabled={!ctx} onClick={() => setChosen({ kit: k, mode: 'full' })}>
                {k.id === current?.id ? 'להחיל שוב (רק מה שחסר)' : 'ערכה מלאה'}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Block>
  );
}

function KitPlanView({ kit, mode, bundle, ctx, onBack, onApplied }: { kit: Kit; mode: ApplyMode; bundle: StoreBundle; ctx: KitContext; onBack: () => void;
  onApplied: (kit: Kit, done: KitApplied) => Promise<void> | void }) {
  const plan: KitPlan = useMemo(() => planKit(kit, bundle, ctx, mode), [kit, bundle, ctx, mode]);
  const [choices, setChoices] = useState<KitChoices>({ replacePages: [], replaceMenus: [], replaceDraft: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = <K extends 'replacePages' | 'replaceMenus'>(k: K, v: KitChoices[K][number]) =>
    setChoices((c) => ({ ...c, [k]: (c[k] as string[]).includes(v) ? (c[k] as string[]).filter((x) => x !== v) : [...(c[k] as string[]), v] }));
  const policies = plan.pages.filter((p) => p.kind === 'policy');
  const pages = plan.pages.filter((p) => p.kind === 'page');
  const menuLabel = { main: 'התפריט הראשי', footer: 'התפריט בתחתית' };
  const conflicts = plan.pageConflicts.length + (['main', 'footer'] as const).filter((k) => plan.menus[k].action === 'conflict').length;

  const apply = async () => {
    setBusy(true); setError('');
    const r = await applyKit(bundle.store!.id, plan, choices);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    await onApplied(kit, r.data);
  };

  return (
    <Block title={mode === 'design' ? `החלפת עיצוב: "${kit.name}"` : `ערכת "${kit.name}"`} sub={kit.description} action={<Button variant="ghost" size="sm" onClick={onBack}>חזרה לערכות</Button>}>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="mb-3 flex justify-start"><PreviewButton label="תצוגה מקדימה (בלי לשמור)" kit={{ id: kit.id, mode }} size="sm" variant="soft" /></div>
      {mode === 'design' ? <>
        <Notice tone="info">
          העיצוב החדש נשמר כטיוטה, והאתר משתנה רק אחרי "פרסום". אפשר לחזור לגרסה קודמת בכל רגע.
          {plan.publishTheme && ' החנות עוד לא פרסמה עיצוב, ולכן זה יהיה העיצוב הראשון שלה (האתר עצמו עדיין סגור).'}
        </Notice>
        <h4 className="mb-2 font-semibold">מה משתנה</h4>
        <ul className="mb-4 list-disc space-y-1 ps-5 text-sm">
          <li>המראה בלבד: הצבעים, הגופן, ראש האתר והתחתית, כרטיסי המוצר, הריווח והכפתורים — של הערכה.</li>
          <li>בחירות עיצוב שעשיתם (פריסה, כפתורים וכו׳) מתחלפות בשל הערכה. אפשר לשנות אותן שוב אחר כך.</li>
        </ul>
        <h4 className="mb-2 font-semibold">מה נשאר כמו שהוא</h4>
        <ul className="mb-4 list-disc space-y-1 ps-5 text-sm text-muted">
          <li>עמוד הבית שלכם: הטקסטים, התמונות, הסדר ומה שהסתרתם.</li>
          <li>העמודים, המדיניות, התפריטים, הקולקציות, המוצרים וההודעה העליונה.</li>
        </ul>
      </> : <>
      <Notice tone="info">
        הערכה נשמרת כטיוטה: העיצוב, העמודים והמדיניות לא עולים לאתר עד שמפרסמים. אפשר לראות הכל ב"תצוגה מקדימה", ולחזור לגרסה קודמת בכל רגע.
        {plan.publishTheme && ' החנות עוד לא פרסמה עיצוב, ולכן העיצוב של הערכה יהיה הגרסה הראשונה שלה (האתר עצמו עדיין סגור).'}
      </Notice>

      <h4 className="mb-2 font-semibold">מה ייווצר</h4>
      <ul className="mb-4 list-disc space-y-1 ps-5 text-sm">
        <li>עיצוב ועמוד בית: {kit.theme.sections.filter((s) => !s.hidden).length} חלקים, צבעים וגופן של הערכה.</li>
        {plan.collections.length > 0 && <li>קולקציות (ריקות, מתמלאות לפי תגיות של מוצרים): {plan.collections.map((c) => c.title).join(', ')}.</li>}
        {pages.length > 0 && <li>עמודים (כטיוטה): {pages.map((p) => p.title).join(', ')}.</li>}
        {policies.length > 0 && <li>מדיניות (נוסח התחלה, כטיוטה): {policies.map((p) => p.title).join(', ')}.</li>}
        {(['main', 'footer'] as const).filter((k) => plan.menus[k].action === 'create').map((k) => <li key={k}>{menuLabel[k]}: {plan.menus[k].items.map((l) => l.label).join(' · ')}.</li>)}
        <li>מוצרים: לא נוצרים. עד שתוסיפו מוצרים, התצוגה המקדימה מראה איפה הם יופיעו.</li>
      </ul>

      {(plan.keptCollections.length > 0 || plan.keptPolicies.length > 0) && <>
        <h4 className="mb-2 font-semibold">מה נשאר כמו שהוא</h4>
        <ul className="mb-4 list-disc space-y-1 ps-5 text-sm text-muted">
          {plan.keptCollections.length > 0 && <li>קולקציות שכבר קיימות: {plan.keptCollections.join(', ')}.</li>}
          {plan.keptPolicies.length > 0 && <li>המדיניות שכבר כתבתם: {plan.keptPolicies.map((k) => POLICY_LABEL[k]).join(', ')} — לא מוחלפת.</li>}
        </ul>
      </>}
      </>}

      {(conflicts > 0 || plan.draft.edited) && <>
        <h4 className="mb-2 font-semibold">לפני שמחליפים — סמנו רק מה שרוצים להחליף</h4>
        <ul className="mb-4 space-y-2">
          {plan.draft.edited && (
            <li><Check on={choices.replaceDraft} onChange={() => setChoices((c) => ({ ...c, replaceDraft: !c.replaceDraft }))}
              label="להחליף את טיוטת העיצוב" sub="בטיוטה יש שינויים שלא פורסמו. הגרסה שבאתר לא משתנה, ונשמרת ברשימת הגרסאות." /></li>
          )}
          {(['main', 'footer'] as const).filter((k) => plan.menus[k].action === 'conflict').map((k) => (
            <li key={k}><Check on={choices.replaceMenus.includes(k)} onChange={() => toggle('replaceMenus', k)} label={`להחליף את ${menuLabel[k]}`}
              sub={`עכשיו: ${plan.menus[k].current.map((l) => l.label).join(' · ')} ← בערכה: ${plan.menus[k].items.map((l) => l.label).join(' · ')}`} /></li>
          ))}
          {plan.pageConflicts.map((c) => (
            <li key={c.id}><Check on={choices.replacePages.includes(c.id)} onChange={() => toggle('replacePages', c.id)} label={`להחליף את העמוד "${c.title}"`}
              sub={`כבר יש עמוד בכתובת /pages/${c.slug}. בלי סימון — העמוד שלכם נשאר.`} /></li>
          ))}
        </ul>
      </>}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onBack}>ביטול</Button>
        <Button variant="primary" disabled={busy || (plan.draft.edited && !choices.replaceDraft)} onClick={() => void apply()}>
          {busy ? <><Spinner /> מחיל…</> : mode === 'design' ? 'החלפת העיצוב (כטיוטה)' : 'החלת הערכה (כטיוטה)'}
        </Button>
      </div>
      {plan.draft.edited && !choices.replaceDraft && <p className="mt-2 text-end text-xs text-muted">כדי להחיל, צריך לאשר את החלפת טיוטת העיצוב.</p>}
    </Block>
  );
}

function Check({ on, onChange, label, sub }: { on: boolean; onChange: () => void; label: string; sub?: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-line p-3">
      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={on} onChange={onChange} />
      <span><span className="block text-sm font-semibold">{label}</span>{sub && <span className="block text-xs text-muted">{sub}</span>}</span>
    </label>
  );
}

/** after a kit: the site is ready — what is left is the products (and a look) */
export function KitReady({ kit, done }: { kit: Kit; done: KitApplied }) {
  return (
    <Notice tone="ok">
      <strong>האתר מוכן — עכשיו מוסיפים מוצרים.</strong> הוחלה הערכה "{kit.name}"
      {done.collections + done.pages > 0 && `: ${[done.collections && `${done.collections} קולקציות`, done.pages && `${done.pages} עמודים ומדיניות`].filter(Boolean).join(', ')} (כטיוטה)`}.{' '}
      <Link className="font-semibold underline underline-offset-2" href={storeHref('products', { new: '1' })}>הוספת מוצר</Link>
      {' · '}
      <Link className="font-semibold underline underline-offset-2" href={storeHref('design', { kits: '1' })}>החלפת ערכה</Link>
    </Notice>
  );
}
