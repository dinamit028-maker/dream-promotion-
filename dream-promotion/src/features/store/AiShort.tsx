'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { AIService } from '@/lib/services/ai.service';
import { useApp } from '@/lib/store';
import { type ShortAsk, type ShortCopy, wantsShortFill } from './page-ai';

export const aiErrorText = (e: any) => e?.code === 'no_api_key' ? 'ה-AI לא מוגדר בשרת (חסר ANTHROPIC_API_KEY).'
  : e?.code === 'quota_exceeded' ? String(e?.message || 'הגעתם למכסת ה-AI החודשית.')
  : e?.code === 'register_only' || e?.code === 'view_only' ? 'אין הרשאה לפעולה הזו.'
  : 'ה-AI לא הצליח הפעם — נסו שוב.';

/**
 * ✨ under a short field people leave empty (2.59): a category's description, the store's one sentence. It writes by itself
 * once when the field is empty (and a category has a name) — a proposal under the field, never into it: "שימוש בטקסט" fills
 * the field, and only "שמירה" saves. `autoKey` names the row, so a visit writes once per row.
 */
export function AiShort({ ask, autoKey, onUse }: { ask: ShortAsk; autoKey: string; onUse: (c: ShortCopy) => void }) {
  const brand = useApp((s) => s.brand);
  const [ok, setOk] = useState<boolean | null>(null);
  const [st, setSt] = useState<{ busy: boolean; proposal: ShortCopy | null; error: string }>({ busy: false, proposal: null, error: '' });
  const latest = useRef(ask); latest.current = ask;
  const write = async () => {
    const a = latest.current;
    if (a.field === 'collection' && !a.title.trim()) { setSt({ busy: false, proposal: null, error: 'קודם שם לקטגוריה — ה-AI כותב לפיו.' }); return; }
    setSt({ busy: true, proposal: null, error: '' });
    try {
      const p = await AIService.storeText(brand, { ...a, title: a.title.trim(), current: a.current.trim() });
      setSt({ busy: false, proposal: p?.text ? p : null, error: p?.text ? '' : 'לא התקבל טקסט — נסו שוב.' });
    } catch (e) { setSt({ busy: false, proposal: null, error: aiErrorText(e) }); }
  };
  useEffect(() => { AIService.available().then(setOk); }, []);
  useEffect(() => {
    if (!ok || !wantsShortFill(ask)) return;
    const key = `short-ai:${autoKey}`;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* no storage: write once now */ }
    void write();
  }, [ok]); // eslint-disable-line react-hooks/exhaustive-deps
  if (ok === false) return null;
  return (
    <div className="-mt-1 mb-3">
      {!st.proposal && (
        <Button size="sm" variant="ghost" disabled={st.busy || ok === null} onClick={() => void write()}>
          {st.busy ? <><Spinner /> ה-AI כותב…</> : '✨ מילוי בעזרת AI'}</Button>
      )}
      {st.error && <p role="alert" className="mt-1 text-sm text-(--danger)">{st.error}</p>}
      {st.proposal && (
        <div className="mt-2 rounded-2xl border border-primary/40 bg-primary-soft p-3 text-sm">
          <p className="mb-1 font-bold">✨ הצעה מה-AI — תישמר רק אחרי &quot;שמירה&quot;.</p>
          <p className="whitespace-pre-line">{st.proposal.text}</p>
          {st.proposal.seoDescription && <p className="mt-2 text-xs text-ink-2"><strong>תיאור לגוגל:</strong> {st.proposal.seoDescription}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => { onUse(st.proposal!); setSt({ busy: false, proposal: null, error: '' }); }}>שימוש בטקסט</Button>
            <Button size="sm" variant="ghost" onClick={() => void write()}>הצעה אחרת</Button>
            <Button size="sm" variant="ghost" onClick={() => setSt({ busy: false, proposal: null, error: '' })}>ביטול</Button>
          </div>
        </div>
      )}
    </div>
  );
}
