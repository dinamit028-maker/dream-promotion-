import { ag } from './vat';
import { categoryLabel } from './expenses';
import { partyKey, type ReportTable } from './statements';

/**
 * Manual journal entries, one-sided (2.96, migration 20261011005100 — docs/FINANCE_ADDITIONS_HE.md T13א): a movement no document
 * made — a correction, a provision, a move between kinds — recorded by the business's owners, with an explanation. The database
 * keeps every rule (journal_entry_create / journal_entry_reverse) and puts the entries into the money summary, the VAT working
 * paper, profit and loss and the cards; this module only checks a form the same way first (in Hebrew), says what an entry does,
 * and lays the entries out as a table. An entry is never changed or removed: it is undone by a reversing entry.
 */
export type JournalKind = 'income' | 'expense' | 'vat' | 'other';
export type VatSide = 'output' | 'input';
export interface JournalParty { kind: 'customer' | 'supplier'; leadId: string | null; name: string; dealer: string }
export interface JournalEntry {
  id: string; number: number; date: string; kind: JournalKind; amount: number; vat: number; vatSide: VatSide | null; category: string | null;
  explanation: string; locationId: string; party: JournalParty | null; reverses: string | null; createdAt: string;
  /** read from the list: the number of the entry this one undoes, and of the one that undid it */
  reversesNumber: number | null; reversedBy: number | null;
}

export const KIND_LABEL: Record<JournalKind, string> = { income: 'הכנסה', expense: 'הוצאה', vat: 'מע״מ', other: 'אחר' };
export const KIND_HINT: Record<JournalKind, string> = {
  income: 'נכנסת להכנסות (רווח והפסד) ולמע״מ עסקאות',
  expense: 'נכנסת להוצאות (רווח והפסד) ולמע״מ תשומות',
  vat: 'רק בדוח המע״מ — עסקאות או תשומות',
  other: 'לא בהכנסות, לא בהוצאות ולא במע״מ — רק ברשימה ובכרטסת',
};
export const SIDE_LABEL: Record<VatSide, string> = { output: 'מע״מ עסקאות', input: 'מע״מ תשומות' };
export const JOURNAL_KINDS: JournalKind[] = ['income', 'expense', 'vat', 'other'];
/** the kind of an entry as a line says it: "הכנסה", "הוצאה · ציוד", "מע״מ תשומות" (a VAT entry by its side), "אחר" */
export const kindText = (e: Pick<JournalEntry, 'kind' | 'vatSide' | 'category'>) =>
  (e.kind === 'vat' && e.vatSide ? SIDE_LABEL[e.vatSide] : e.kind === 'expense' && e.category ? `${KIND_LABEL.expense} · ${categoryLabel(e.category)}` : KIND_LABEL[e.kind]);
/** the kinds this business records: no VAT entry for an exempt dealer */
export const kindsFor = (vatOn: boolean): JournalKind[] => (vatOn ? JOURNAL_KINDS : JOURNAL_KINDS.filter((k) => k !== 'vat'));

const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
const str = (v: unknown) => (v == null ? '' : String(v));
const KINDS = new Set<string>(JOURNAL_KINDS);

/**
 * the table's rows (journal_entries) → entries, each with the number it undoes and the one that undid it. `context`: other entries
 * that only tell those numbers (a reversal of a later period, the entry an earlier one undid) — not listed themselves
 */
export function toEntries(rows: unknown, context: unknown = []): JournalEntry[] {
  const list = (Array.isArray(rows) ? rows : []).filter((r: any) => r && KINDS.has(r.kind));
  const all = [...list, ...(Array.isArray(context) ? context : []).filter((r: any) => r && r.id)];
  const byId = new Map(all.map((r: any) => [str(r.id), num(r.number)]));
  const undone = new Map(all.filter((r: any) => r.reverses).map((r: any) => [str(r.reverses), num(r.number)]));
  return list.map((r: any): JournalEntry => ({
    id: str(r.id), number: num(r.number), date: str(r.entry_date), kind: r.kind, amount: num(r.amount), vat: num(r.vat),
    vatSide: r.vat_side === 'output' || r.vat_side === 'input' ? r.vat_side : null, category: r.category ? str(r.category) : null,
    explanation: str(r.explanation), locationId: str(r.location_id),
    party: r.party_kind === 'customer' || r.party_kind === 'supplier'
      ? { kind: r.party_kind, leadId: r.lead_id ? str(r.lead_id) : null, name: str(r.party_name), dealer: str(r.party_dealer) } : null,
    reverses: r.reverses ? str(r.reverses) : null, createdAt: str(r.created_at),
    reversesNumber: r.reverses ? byId.get(str(r.reverses)) ?? null : null, reversedBy: undone.get(str(r.id)) ?? null,
  })).sort((a, b) => b.number - a.number);
}

/** what an entry does to the money summary — the database's own rule (finance_summary), agorot-exact */
export function entryEffect(e: Pick<JournalEntry, 'kind' | 'amount' | 'vat' | 'vatSide'>): { income: number; expense: number; vatOut: number; vatIn: number } {
  const z = { income: 0, expense: 0, vatOut: 0, vatIn: 0 };
  if (e.kind === 'income') return { ...z, income: e.amount, vatOut: e.vat };
  if (e.kind === 'expense') return { ...z, expense: e.amount, vatIn: e.vat };
  if (e.kind === 'vat') return e.vatSide === 'input' ? { ...z, vatIn: e.vat } : { ...z, vatOut: e.vat };
  return z;
}
const money = (n: number) => `${n < 0 ? '−' : '+'}₪${Math.abs(n).toLocaleString('he-IL', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
/** "הכנסות +₪200 · מע״מ עסקאות +₪36" — or what "other" means */
export function effectText(e: Pick<JournalEntry, 'kind' | 'amount' | 'vat' | 'vatSide'>): string {
  const x = entryEffect(e);
  const parts = [
    x.income ? `הכנסות ${money(x.income)}` : '', x.expense ? `הוצאות ${money(x.expense)}` : '',
    x.vatOut ? `${SIDE_LABEL.output} ${money(x.vatOut)}` : '', x.vatIn ? `${SIDE_LABEL.input} ${money(x.vatIn)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'לא משנה הכנסות, הוצאות או מע״מ — רק ברשימה ובכרטסת';
}
/** the totals of a list of entries (what the screen sums for its period) */
export function entriesTotals(list: Pick<JournalEntry, 'kind' | 'amount' | 'vat' | 'vatSide'>[]) {
  const t = list.reduce((a, e) => { const x = entryEffect(e); return { income: a.income + ag(x.income), expense: a.expense + ag(x.expense), vatOut: a.vatOut + ag(x.vatOut), vatIn: a.vatIn + ag(x.vatIn) }; },
    { income: 0, expense: 0, vatOut: 0, vatIn: 0 });
  return { income: t.income / 100, expense: t.expense / 100, vatOut: t.vatOut / 100, vatIn: t.vatIn / 100, count: list.length };
}

// ---- the form ------------------------------------------------------------------------------------------------------------------------
export interface JournalDraft {
  date: string; kind: JournalKind; amount: string; vat: string; vatSide: VatSide | null; category: string; explanation: string;
  locationId: string | null; party: { kind: 'customer' | 'supplier'; leadId: string | null; name: string; dealer: string } | null;
}
export const emptyDraft = (today: string): JournalDraft => ({ date: today, kind: 'income', amount: '', vat: '', vatSide: null, category: 'other', explanation: '', locationId: null, party: null });

const AMOUNT = /^-?\d{1,9}(\.\d{1,2})?$/;
const amountOf = (s: string) => { const t = s.trim().replace(/,/g, ''); return t === '' ? 0 : AMOUNT.test(t) ? Number(t) : NaN; };
/** the VAT of an amount at the business's rate, to the agora (a suggestion — a manual entry may record any VAT) */
export const vatAt = (amount: number, rate: number) => Math.round(ag(amount) * rate / 100) / 100;
/** may the party be a customer / a supplier on this kind? (income — a customer; expense — a supplier; other — either; VAT — none) */
export const partyKinds = (kind: JournalKind): ('customer' | 'supplier')[] => (kind === 'income' ? ['customer'] : kind === 'expense' ? ['supplier'] : kind === 'other' ? ['customer', 'supplier'] : []);

/** what the database would refuse (journal_*), in Hebrew — none when the entry may be recorded */
export function journalErrors(d: JournalDraft, ctx: { today: string; lockedUntil: string | null; vatOn: boolean }): string[] {
  const e: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || d.date > ctx.today) e.push('תאריך — היום או לפני');
  else if (ctx.lockedUntil && d.date <= ctx.lockedUntil) e.push(`הספרים סגורים עד ${ctx.lockedUntil.split('-').reverse().join('/')} — פקודה בתאריך מאוחר יותר`);
  const amount = d.kind === 'vat' ? 0 : amountOf(d.amount);
  const vat = ctx.vatOn && d.kind !== 'other' ? amountOf(d.vat) : 0;
  if (Number.isNaN(amount) || Number.isNaN(vat)) e.push('סכום — מספר, עד שתי ספרות אחרי הנקודה (מינוס לתיקון שמקטין)');
  else if (d.kind === 'vat' && vat === 0) e.push('סכום המע״מ');
  else if (amount === 0 && vat === 0) e.push('סכום');
  if (!ctx.vatOn && d.kind === 'vat') e.push('עוסק פטור לא רושם מע״מ');
  if (d.kind === 'vat' && !d.vatSide) e.push('מע״מ עסקאות או מע״מ תשומות?');
  const ex = d.explanation.trim();
  if (ex.length < 2) e.push('הסבר — חובה (מה הפקודה ולמה)');
  else if (ex.length > 500) e.push('ההסבר ארוך מדי (עד 500 תווים)');
  if (d.party) {
    if (!partyKinds(d.kind).includes(d.party.kind)) e.push(d.kind === 'vat' ? 'פקודת מע״מ לא שייכת ללקוח או לספק' : d.kind === 'income' ? 'הכנסה שייכת ללקוח' : 'הוצאה שייכת לספק');
    const dealer = d.party.dealer.trim();
    if (dealer && !/^\d{9}$/.test(dealer)) e.push('ע.מ / ח.פ — 9 ספרות');
    if (!d.party.leadId && d.party.name.trim().length < 2 && !dealer) e.push(d.party.kind === 'customer' ? 'שם הלקוח או מספר העוסק שלו' : 'שם הספק או מספר העוסק שלו');
  }
  return e;
}

/** the call's arguments (journal_entry_create) — the id is the form's, fixed when it opened: a second tap is the same entry */
export function entryArgs(id: string, d: JournalDraft, vatOn: boolean) {
  const amount = d.kind === 'vat' ? 0 : amountOf(d.amount);
  const vat = vatOn && d.kind !== 'other' ? amountOf(d.vat) : 0;
  const party = d.party && partyKinds(d.kind).includes(d.party.kind)
    ? { kind: d.party.kind, ...(d.party.leadId ? { leadId: d.party.leadId } : { name: d.party.name.trim().slice(0, 120) }), dealer: d.party.dealer.trim() }
    : null;
  return {
    p_id: id, p_date: d.date, p_kind: d.kind, p_amount: amount, p_vat: vat, p_vat_side: d.kind === 'vat' ? d.vatSide : null,
    p_category: d.kind === 'expense' ? d.category || 'other' : null, p_explanation: d.explanation.trim(), p_location: d.locationId, p_party: party,
  };
}
/** the entry as the form would record it (for the preview: what it does) */
export const draftAsEntry = (d: JournalDraft, vatOn: boolean) => {
  const a = entryArgs('', d, vatOn);
  return { kind: d.kind, amount: Number.isNaN(a.p_amount) ? 0 : a.p_amount, vat: Number.isNaN(a.p_vat) ? 0 : a.p_vat, vatSide: d.kind === 'income' ? 'output' as const : d.kind === 'expense' ? 'input' as const : d.vatSide };
};

/** may this entry be undone? (not a reversal itself, not undone yet) */
export const canReverse = (e: Pick<JournalEntry, 'reverses' | 'reversedBy'>) => !e.reverses && e.reversedBy == null;
/** what a reversal must be: dated on or after its entry, today or before, not in closed books, with a reason */
export function reverseErrors(e: Pick<JournalEntry, 'date'>, o: { date: string; reason: string }, ctx: { today: string; lockedUntil: string | null }): string[] {
  const x: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date) || o.date > ctx.today || o.date < e.date) x.push('תאריך — מתאריך הפקודה ועד היום');
  else if (ctx.lockedUntil && o.date <= ctx.lockedUntil) x.push(`הספרים סגורים עד ${ctx.lockedUntil.split('-').reverse().join('/')}`);
  if (o.reason.trim().length < 2) x.push('סיבה — חובה');
  else if (o.reason.trim().length > 500) x.push('הסיבה ארוכה מדי (עד 500 תווים)');
  return x;
}

/** who an entry belongs to, as a line says it */
export const partyText = (p: JournalParty | null) => (p ? `${p.kind === 'customer' ? 'לקוח' : 'ספק'}: ${p.name || p.dealer}${p.name && p.dealer ? ` (${p.dealer})` : ''}` : '');
/** the key of the card it is on (the reports' party_key) — null when it belongs to nobody */
export const partyKeyOf = (p: JournalParty | null) =>
  (!p ? null : partyKey({ leadId: p.kind === 'customer' ? p.leadId : null, dealer: p.dealer, name: p.name }));

/** the entries of a period as a table — for the screen's CSV / PDF and the accountant's package */
export function journalTable(list: JournalEntry[], o: { vatOn: boolean; locationName?: (id: string) => string | null }): ReportTable {
  const rows = [...list].sort((a, b) => a.number - b.number).map((e) => [
    e.number, e.date, kindText(e),
    ...(o.vatOn ? [e.amount, e.vat] : [e.amount]),
    e.explanation, partyText(e.party),
    e.reversesNumber != null ? `הופכת את ${e.reversesNumber}` : e.reversedBy != null ? `בוטלה ב-${e.reversedBy}` : '',
    ...(o.locationName ? [o.locationName(e.locationId) ?? ''] : []),
  ]);
  const t = entriesTotals(list);
  return {
    title: 'פקודות יומן ידניות',
    columns: [{ label: 'מס׳', type: 'count' }, { label: 'תאריך', type: 'date' }, { label: 'סוג', type: 'text' },
      ...(o.vatOn ? [{ label: 'לפני מע״מ', type: 'money' as const }, { label: 'מע״מ', type: 'money' as const }] : [{ label: 'סכום', type: 'money' as const }]),
      { label: 'הסבר', type: 'text' }, { label: 'לקוח / ספק', type: 'text' }, { label: 'ביטול', type: 'text' },
      ...(o.locationName ? [{ label: 'סניף', type: 'text' as const }] : [])],
    rows,
    total: null,
    note: `בתקופה: הכנסות ${money(t.income)}, הוצאות ${money(t.expense)}${o.vatOn ? `, מע״מ עסקאות ${money(t.vatOut)}, מע״מ תשומות ${money(t.vatIn)}` : ''}. `
      + 'פקודה ידנית נכללת בדוח המע״מ, ברווח והפסד ובכרטסת — ולא נמחקת: ביטול בפקודה הפוכה.',
  };
}

// ---- the money summary's share of them (finance_summary → "manual") -------------------------------------------------------------------
export interface ManualSummary { count: number; income: { net: number; vat: number }; expense: { net: number; vat: number }; vat: { output: number; input: number } }
export const NO_MANUAL: ManualSummary = { count: 0, income: { net: 0, vat: 0 }, expense: { net: 0, vat: 0 }, vat: { output: 0, input: 0 } };
/** the summary's "manual" (none before migration 5100) */
export const toManual = (j: any): ManualSummary => (!j || typeof j !== 'object' ? NO_MANUAL : {
  count: num(j.count), income: { net: num(j.income?.net), vat: num(j.income?.vat) }, expense: { net: num(j.expense?.net), vat: num(j.expense?.vat) },
  vat: { output: num(j.vat?.output), input: num(j.vat?.input) },
});
const nonzero = (rows: [string, number][]) => rows.filter(([, v]) => ag(v) !== 0);
/** under profit and loss: how much of the income and the expenses manual entries are (nothing when there are none) */
export const manualPnlRows = (m: ManualSummary): [string, number][] =>
  nonzero([['מתוכן פקודות יומן ידניות — הכנסות', m.income.net], ['מתוכן פקודות יומן ידניות — הוצאות', m.expense.net]]);
/** under the VAT working paper: how much of the VAT on sales and on inputs manual entries are */
export const manualVatRows = (m: ManualSummary): [string, number][] =>
  nonzero([['מתוכן פקודות יומן ידניות — מע״מ עסקאות', (ag(m.income.vat) + ag(m.vat.output)) / 100],
    ['מתוכן פקודות יומן ידניות — מע״מ תשומות', (ag(m.expense.vat) + ag(m.vat.input)) / 100]]);
