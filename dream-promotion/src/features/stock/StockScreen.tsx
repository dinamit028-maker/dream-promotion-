'use client';
import { useCallback, useEffect, useState } from 'react';
import { Chip, PageHead } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Note } from '@/features/finance/ui';
import { useLocations } from '@/features/locations/store';
import { activeLocations, multiLocation } from '@/features/locations/locations';
import { STOCK_MIGRATION, type DraftLine, type StockRow } from './stock-locations';
import { loadStockCatalog, loadStockRows, type StockCatalog } from './stock-data';
import { ByLocation } from './ByLocation';
import { Transfers } from './Transfers';
import { Counts } from './Counts';

type Tab = 'by' | 'transfers' | 'counts';
/** a transfer the screen suggests (low stock here, to spare there) — the form opens with it */
export interface TransferDraft { from: string; to: string; lines: DraftLine[] }

/**
 * "מלאי" (T12ב): every location's count of every product, low stock with where to bring it from, transfers between locations and
 * counts that the owner approves. A business with one location sees only "ספירות" (it is opened from the register's price list —
 * nothing in its menus changes); with more than one, the menu has "מלאי".
 */
export function StockScreen() {
  const { state: loc, loaded, load } = useLocations();
  const multi = multiLocation(loc);
  const tabs: [Tab, string][] = multi ? [['by', 'לפי סניף'], ['transfers', 'העברות'], ['counts', 'ספירות']] : [['counts', 'ספירות']];
  const [tab, setTab] = useState<Tab>('counts');
  const [rows, setRows] = useState<StockRow[] | null | undefined>(undefined);
  const [catalog, setCatalog] = useState<StockCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TransferDraft | null>(null);
  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  // the tab of the link (?tab=transfers), once the locations are known
  useEffect(() => {
    if (!loaded) return;
    const want = new URLSearchParams(window.location.search).get('tab') as Tab | null;
    setTab(want && tabs.some(([k]) => k === want) ? want : tabs[0][0]);
  }, [loaded, multi]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(async () => {
    const [r, c] = await Promise.all([loadStockRows(), loadStockCatalog()]);
    setRows(r);
    if (c.ok) { setCatalog(c.data); setError(null); } else setError(c.error);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  if (!loaded || rows === undefined) return <div className="py-10 text-center"><Spinner /></div>;
  if (rows === null || !loc.ready) return <><PageHead title={multi ? 'מלאי' : 'ספירת מלאי'} /><Note tone="warn">{STOCK_MIGRATION}</Note></>;
  const places = activeLocations(loc);
  return (
    <>
      <PageHead title={multi ? 'מלאי' : 'ספירת מלאי'}
        sub={multi ? `${places.length} סניפים · כל מכירה מורידה מהסניף של הקופה, וההזמנות באתר — מהסניף שנקבע למשלוחים` : 'ספירה מסודרת של המלאי — הבעלים מאשרים, ורק אז הפערים נרשמים'} />
      {error && <div className="mb-4"><Note tone="warn">{error}</Note></div>}
      {tabs.length > 1 && (
        <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1" role="tablist">
          {tabs.map(([k, l]) => <Chip key={k} role="tab" aria-selected={tab === k} on={tab === k} onClick={() => setTab(k)}>{l}</Chip>)}
        </div>
      )}
      {!catalog ? <div className="py-8 text-center"><Spinner /></div> : <>
        {tab === 'by' && <ByLocation rows={rows} catalog={catalog} loc={loc} onTransfer={(d) => { setDraft(d); setTab('transfers'); }} />}
        {tab === 'transfers' && <Transfers rows={rows} catalog={catalog} loc={loc} draft={draft} onDraftUsed={() => setDraft(null)} onMoved={reload} />}
        {tab === 'counts' && <Counts catalog={catalog} loc={loc} onMoved={reload} />}
      </>}
    </>
  );
}
