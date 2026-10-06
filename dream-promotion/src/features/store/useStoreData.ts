'use client';
import { useCallback, useEffect, useState } from 'react';
import { loadStore, type StoreBundle } from './data';

/** the store of the business worked in now, for one screen: loading, an error in Hebrew, and a reload after a save */
export function useStoreData() {
  const [data, setData] = useState<StoreBundle | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    const r = await loadStore();
    if (r.ok) { setData(r.data); setError(''); } else setError(r.error);
    setLoading(false);
    return r;
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}
