'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { GAP_HE, MIGRATION_3300, publishGaps, type CatalogItem } from './catalog';
import { setPublished } from './data';

/**
 * "פרסם באתר" next to a product — in the register's price list, in finance and in the store (2.54). Off by default.
 * Switching it on when the product has no picture or no description offers to complete them (or a description from the
 * AI) — a suggestion, never a block. Until the store's site is up (stage 2), "באתר" only marks the product for it.
 */
export type EditorFocus = 'images' | 'description' | 'ai' | 'variants' | 'stock' | 'online';

export function Switch({ on, onClick, label, disabled, className }: { on: boolean; onClick: () => void; label: string; disabled?: boolean; className?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className={cx('relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', on ? 'bg-primary' : 'bg-line', className)}>
      <span aria-hidden className={cx('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', on ? '-translate-x-6' : '-translate-x-1')} />
    </button>
  );
}

export function PublishSwitch({ item, ready = true, onChanged, onComplete, onError, compact }: {
  item: CatalogItem;
  /** migration 3300 ran (else the switch explains what is missing) */
  ready?: boolean;
  onChanged: (item: CatalogItem) => void;
  /** open the product's editor at the part that is missing */
  onComplete: (focus: EditorFocus) => void;
  onError: (message: string) => void;
  compact?: boolean;
}) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const gaps = publishGaps(item);
  async function set(on: boolean) {
    setBusy(true);
    const r = await setPublished(item.id, on);
    setBusy(false);
    if (r.ok) onChanged(r.data); else onError(r.error);
  }
  function toggle() {
    if (!ready) return onError(MIGRATION_3300);
    if (!item.publishOnline && gaps.length) return setAsk(true);
    void set(!item.publishOnline);
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Switch on={item.publishOnline} onClick={toggle} disabled={busy} label={`${item.publishOnline ? 'מפורסם באתר' : 'לא באתר'}: ${item.name}`} />
      {!compact && <span className={cx('text-xs font-semibold', item.publishOnline ? 'text-primary' : 'text-muted')}>{item.publishOnline ? 'באתר' : 'לא באתר'}</span>}
      <Modal open={ask} onClose={() => setAsk(false)}>
        <h3 className="font-display text-xl font-extrabold">לפני שמפרסמים את &quot;{item.name}&quot;</h3>
        <p className="mt-2 text-ink-2">
          חסר{gaps.length > 1 ? 'ים' : ''} {gaps.map((g) => GAP_HE[g]).join(' ו')}. מוצר עם תמונה ותיאור נמכר טוב יותר באתר — אבל זו המלצה, לא חובה.
        </p>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {gaps.includes('image') && <Button variant="primary" onClick={() => { setAsk(false); onComplete('images'); }}>הוספת תמונה</Button>}
          {gaps.includes('description') && <Button variant={gaps.includes('image') ? 'ghost' : 'primary'} onClick={() => { setAsk(false); onComplete('description'); }}>כתיבת תיאור</Button>}
          {gaps.includes('description') && <Button variant="ghost" onClick={() => { setAsk(false); onComplete('ai'); }}>✨ תיאור מה-AI</Button>}
          <Button variant="ghost" disabled={busy} onClick={async () => { setAsk(false); await set(true); }}>לפרסם בכל זאת</Button>
        </div>
        <button type="button" className="mt-4 text-sm font-semibold text-muted" onClick={() => setAsk(false)}>ביטול</button>
      </Modal>
    </span>
  );
}

/** the honest line under every list with the switch: what "באתר" means while the site is not up */
export const SITE_NOT_LIVE = 'החנות באתר עוד לא עלתה. מוצר שמסומן "באתר" יופיע בה כשתעלה. זה אותו מוצר של הקופה והכספים — שינוי במחיר, בתמונה או במלאי מופיע מיד בכל המקומות.';
