'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Button, Chip, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { DOC_LABEL, creditedTotals, toDoc, type DocRow } from '@/features/documents/documents';
import { useFinance } from './FinanceScreen';
import { Composer, type ComposerMode } from './Composer';
import { DocView } from './DocView';
import { financeError } from './api';
import { allowedDocTypes } from './rules';
import type { ComposerBody } from './quotes';
import { Note, Pill, ddmmyyyy, ils } from './ui';
import { softwareRegistered } from '@/features/documents/DocumentsTab';

/**
 * "מסמכים" — the document center: every legal document of the business (from the register too), drafts, and a new
 * document of any type the business may issue. Filtered and paged by the database (50 at a time), not in the browser.
 */
const PAGE = 50;
interface Draft { id: string; docType: number; customerName: string; total: number; updatedAt: string; body: ComposerBody; leadId: string | null; quoteId: string | null }

export function DocumentCenter() {
  const { settings, params, clearParams, fail, say } = useFinance();
  const leads = useApp((s) => s.leads);
  const [type, setType] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [cancelled, setCancelled] = useState<Set<string>>(new Set());
  const [credited, setCredited] = useState<Map<string, number>>(new Map());
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [open, setOpen] = useState<DocRow | null>(null);
  const [composer, setComposer] = useState<{ mode: ComposerMode; initial?: Partial<ComposerBody> & { leadId?: string | null } } | null>(null);

  const load = useCallback(async (append = false) => {
    const sb = supabase();
    let query = sb.from('documents').select('*').order('issued_at', { ascending: false });
    if (type) query = query.eq('doc_type', type);
    if (q.trim()) query = query.ilike('customer_name', `%${q.trim().replace(/[%_,()]/g, ' ')}%`);
    const from = append ? docs?.length ?? 0 : 0;
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) { fail(financeError(error)); setDocs([]); return; }
    const page = (data ?? []).map(toDoc);
    const all = append ? [...(docs ?? []), ...page] : page;
    setDocs(all); setMore(page.length === PAGE);
    const ids = page.map((d) => d.id);
    const nums = page.filter((d) => d.docType === 305 || d.docType === 320).map((d) => d.docNumber);
    const [c, cr] = await Promise.all([
      ids.length ? sb.from('document_cancellations').select('document_id').in('document_id', ids) : Promise.resolve({ data: [] as any[] }),
      nums.length ? sb.from('documents').select('doc_type, total, base_doc_type, base_doc_number').eq('doc_type', 330).in('base_doc_number', nums) : Promise.resolve({ data: [] as any[] }),
    ]);
    setCancelled((prev) => new Set([...(append ? prev : []), ...((c.data ?? []) as any[]).map((x) => x.document_id)]));
    setCredited((prev) => new Map([...(append ? prev : []), ...creditedTotals(((cr.data ?? []) as any[]).map((x) => ({ docType: x.doc_type, total: Number(x.total), baseDocType: x.base_doc_type, baseDocNumber: Number(x.base_doc_number) })))]));
  }, [type, q, docs, fail]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadDrafts = useCallback(async () => {
    const { data } = await supabase().from('document_drafts').select('*').eq('status', 'open').order('updated_at', { ascending: false }).limit(30);
    setDrafts(((data ?? []) as any[]).map((d) => ({ id: d.id, docType: d.doc_type, customerName: d.customer_name, total: Number(d.total), updatedAt: d.updated_at, body: d.body ?? {}, leadId: d.lead_id, quoteId: d.quote_id })));
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(false), q ? 300 : 0); return () => clearTimeout(t); }, [type, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadDrafts(); }, [loadDrafts]);

  // ?new=1 / ?new=305&lead=… (the module's "+", the overview, the CRM card)
  useEffect(() => {
    const n = params.get('new');
    if (!n) return;
    const lead = params.get('lead') ? leads.find((l) => l.id === params.get('lead')) : undefined;
    const allowed = allowedDocTypes(settings.entity);
    setComposer({ mode: { kind: 'document', docType: allowed.includes(Number(n)) ? Number(n) : allowed[0] },
      initial: lead ? { leadId: lead.id, customer: { name: lead.billingName || lead.name, phone: lead.phone, email: lead.email, dealer: lead.billingDealer, street: lead.billingStreet, city: lead.billingCity } } : undefined });
    clearParams();
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const types = useMemo(() => allowedDocTypes(settings.entity), [settings.entity]);
  const status = (d: DocRow) => {
    if (cancelled.has(d.id)) return <Pill tone="bad">בוטל</Pill>;
    const c = credited.get(`${d.docType}:${d.docNumber}`) ?? 0;
    if (c) return <Pill tone={c >= d.total ? 'bad' : 'warn'}>{c >= d.total ? 'זוכתה' : 'זוכתה חלקית'}</Pill>;
    return null;
  };
  async function removeDraft(id: string) {
    if (!window.confirm('למחוק את הטיוטה? (טיוטה אינה מסמך — אין לה מספר)')) return;
    const { error } = await supabase().from('document_drafts').delete().eq('id', id);
    if (error) fail(financeError(error)); else { say('הטיוטה נמחקה'); void loadDrafts(); }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setComposer({ mode: { kind: 'document', docType: types[0] } })}>+ מסמך חדש</Button>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי לקוח" className="max-w-xs py-2" aria-label="חיפוש מסמך לפי לקוח" />
      </div>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <Chip on={type === null} onClick={() => setType(null)} className="shrink-0">הכל</Chip>
        {[305, 320, 330, 300, 400].map((t) => <Chip key={t} on={type === t} onClick={() => setType(t)} className="shrink-0">{DOC_LABEL[t]}</Chip>)}
      </div>

      {drafts.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-sm font-bold">טיוטות ({drafts.length})</p>
          {drafts.map((d) => (
            <div key={d.id} className="flex min-w-0 items-center gap-2 rounded-2xl border border-dashed border-line p-2.5 text-sm">
              <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setComposer({ mode: { kind: 'document', docType: d.docType, draftId: d.id, quoteId: d.quoteId }, initial: { ...d.body, leadId: d.leadId } })}>
                <strong className="block truncate">טיוטה · {DOC_LABEL[d.docType]} · {d.customerName || 'בלי שם'}</strong>
                <span className="text-xs text-muted">עודכנה {ddmmyyyy(d.updatedAt.slice(0, 10))}</span>
              </button>
              <strong className="tabular-nums">{ils(d.total)}</strong>
              <button type="button" className="text-xs text-muted hover:text-[var(--danger)]" onClick={() => void removeDraft(d.id)}>מחיקה</button>
            </div>
          ))}
        </div>
      )}

      {docs === null ? <div className="py-8 text-center"><Spinner /></div> : !docs.length ? (
        <Note>{q || type ? 'לא נמצאו מסמכים.' : 'עוד לא הופקו מסמכים. מסמך מופק מכאן, מהקופה (כל מכירה ששולמה) או מהצעת מחיר.'}</Note>
      ) : (
        <div className="grid gap-1.5">
          {docs.map((d) => (
            <button key={d.id} type="button" onClick={() => setOpen(d)} className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-start text-sm hover:border-primary">
              <span className="min-w-0 flex-1">
                <strong className="block truncate">{DOC_LABEL[d.docType]} {d.docNumber} · {d.customerName || 'לקוח מזדמן'}</strong>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">{ddmmyyyy(d.docDate)}{d.dueDate ? ` · לתשלום עד ${ddmmyyyy(d.dueDate)}` : ''}{d.source === 'pos' ? ' · קופה' : ''}{status(d)}</span>
              </span>
              <strong className="tabular-nums">{ils(d.total)}</strong>
            </button>
          ))}
          {more && <Button variant="ghost" onClick={() => void load(true)}>עוד מסמכים</Button>}
        </div>
      )}

      {!softwareRegistered() && (
        <p className="rounded-2xl bg-surface-2 p-3 text-xs text-ink-2">התוכנה עוד לא רשומה ברשות המסים כתוכנה להפקת מסמכים. עד הרישום ובדיקת יועץ מס — השתמשו במסמכים לבדיקה בלבד.</p>
      )}

      {open && <DocView doc={open} onClose={() => setOpen(null)} onChanged={() => void load(false)} />}
      {composer && <Composer mode={composer.mode} initial={composer.initial} onClose={() => setComposer(null)}
        onDone={(r) => {
          if (r.kind === 'issued') { setComposer(null); say(`הופקה ${DOC_LABEL[r.doc.docType]} מס׳ ${r.doc.docNumber} · ${ils(r.doc.total)}`); setOpen(r.doc); void load(false); void loadDrafts(); }
          else if (r.kind === 'draft') { setComposer(null); say('הטיוטה נשמרה'); void loadDrafts(); }
        }} />}
    </div>
  );
}
