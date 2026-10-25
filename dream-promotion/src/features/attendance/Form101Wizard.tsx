'use client';
import { useEffect, useId, useMemo, useState } from 'react';
import { SignaturePad, btn, input } from '@/features/client-file/DeclarationForm';
import {
  ATTACH_LABEL, COUNTS_OF, COUNT_LABEL, CREDIT_TEXT, DECLARATION, GENDER_LABEL, INCOME_KINDS, INCOME_LABEL, KIBBUTZ_LABEL, MARITAL_LABEL, STEPS,
  attachmentsAsked, married, problems, warnings, type AttachKind, type Child, type Form101Data, type OtherPayer, type Step,
} from './form101';

/**
 * The employee's טופס 101 on the phone (/f/<token>; docs/FORM101_REQUIREMENTS_HE.md §5): no sign-in, right to left, nothing of
 * Dream. Eight short steps in the form's order (א is the employer's), every word the official form's; the details the employer
 * already has (and last year's form) come prefilled — the employee confirms or changes. "הבא" checks only the step's own
 * fields; the attachments the marked sections ask for are asked at the end (a missing one is said, never a refusal — the
 * accountant decides). The answers are kept in this browser tab if the page closes half way; the signature is not.
 */
interface Page { employer: string; taxYear: number; update: boolean; form: { code: string; updated: string; year: number }; data: Form101Data }
interface Attached { kind: AttachKind; path: string; name: string; sha256: string; type: string; size: number }
type Done = { version: number; pdf: string; file: string };

const primary = `${btn} border-[#2563eb] bg-[#2563eb] text-white disabled:opacity-60`;
const ghost = `${btn} border-zinc-300 bg-white text-black`;

/** a photo becomes a JPEG of at most 2000px (a phone photo is several MB; the server takes 4MB); a PDF goes as it is */
async function fitFile(file: File): Promise<Blob> {
  if (file.type === 'application/pdf') return file;
  try {
    const b = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    try {
      const s = Math.min(1, 2000 / Math.max(b.width, b.height));
      const c = document.createElement('canvas');
      c.width = Math.round(b.width * s); c.height = Math.round(b.height * s);
      c.getContext('2d')!.drawImage(b, 0, 0, c.width, c.height);
      const out = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
      return out ?? file;
    } finally { b.close(); }
  } catch { return file; }
}

export function Form101Wizard({ token }: { token: string }) {
  const store = `form101:${token.slice(0, 16)}`;
  const [page, setPage] = useState<Page | null>(null);
  const [d, setD] = useState<Form101Data | null>(null);
  const [files, setFiles] = useState<Attached[]>([]);
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<AttachKind | null>(null);
  const [sign, setSign] = useState({ name: '', signature: '', confirm: false });
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    fetch(`/api/f101/${token}`, { cache: 'no-store' }).then(async (r) => {
      const j = await r.json().catch(() => null);
      if (!r.ok) { setError(j?.message ?? 'הקישור לא נמצא.'); return; }
      setPage(j as Page);
      let saved: { d?: Form101Data; files?: Attached[]; step?: number } | null = null;
      try { saved = JSON.parse(sessionStorage.getItem(store) ?? 'null'); } catch { /* nothing kept */ }
      setD(saved?.d ?? (j as Page).data);
      setFiles(saved?.files ?? []);
      setStep(Math.min(saved?.step ?? 0, STEPS.length - 1));
      const e = (saved?.d ?? (j as Page).data).employee;
      setSign((s) => ({ ...s, name: `${e.firstName} ${e.lastName}`.trim() }));
    }).catch(() => setError('אין חיבור כרגע. נסו שוב בעוד רגע.'));
  }, [token, store]);
  useEffect(() => {
    if (!d || done) return;
    try { sessionStorage.setItem(store, JSON.stringify({ d, files, step })); } catch { /* private mode */ }
  }, [d, files, step, store, done]);

  const visible = useMemo(() => STEPS.filter((s) => s.key !== 'spouse' || (d && married(d))), [d]);
  const current = visible[Math.min(step, visible.length - 1)];
  if (error) return <Shell><p className="mt-16 text-center text-lg" role="alert">{error}</p></Shell>;
  if (!page || !d) return <Shell><p className="mt-16 text-center" aria-live="polite">טוען…</p></Shell>;
  if (done) return (
    <Shell>
      <div className="mt-10 rounded-2xl bg-white p-6 text-center shadow-sm">
        <p className="text-2xl font-bold">תודה, הטופס נשלח ✓</p>
        <p className="mt-2 text-zinc-600">טופס 101 לשנת המס {page.taxYear} נשמר אצל {page.employer || 'המעסיק'}{done.version > 1 ? ` (עדכון מס׳ ${done.version})` : ''}.</p>
        <p className="mt-4 text-sm text-zinc-600">אפשר לשמור עותק עכשיו (הקישור לא יציג אותו שוב):</p>
        <button type="button" className={`${primary} mt-3 w-full`} onClick={() => {
          const bytes = Uint8Array.from(atob(done.pdf), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
          const a = document.createElement('a'); a.href = url; a.download = done.file; document.body.appendChild(a); a.click(); a.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        }}>הורדת עותק של הטופס</button>
      </div>
    </Shell>
  );

  const up = (fn: (x: Form101Data) => void) => setD((cur) => { if (!cur) return cur; const next = structuredClone(cur); fn(next); return next; });
  const stepProblems = (k: Step) => problems(d).filter((p) => p.step === k);
  const go = (n: number) => { setProblem(''); setStep(n); window.scrollTo({ top: 0 }); };
  const next = () => {
    const p = stepProblems(current.key);
    if (p.length) { setProblem(p[0].message); return; }
    go(step + 1);
  };

  async function attach(kind: AttachKind, file: File | undefined) {
    if (!file) return;
    setUploading(kind); setProblem('');
    try {
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('file', await fitFile(file), file.name);
      const r = await fetch(`/api/f101/${token}/file`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => null);
      if (!r.ok) { setProblem(j?.message ?? 'הקובץ לא נשמר. נסו שוב.'); return; }
      setFiles((all) => [...all, j as Attached]);
    } catch { setProblem('אין חיבור כרגע. נסו שוב בעוד רגע.'); } finally { setUploading(null); }
  }

  async function submit() {
    if (!d || busy) return;
    const all = problems(d);
    if (all.length) { const i = visible.findIndex((s) => s.key === all[0].step); go(i < 0 ? 0 : i); setProblem(all[0].message); return; }
    if (sign.name.trim().length < 2) { setProblem('חסר שם מלא.'); return; }
    if (!sign.signature) { setProblem('חסרה חתימה.'); return; }
    if (!sign.confirm) { setProblem('יש לסמן את ההצהרה לפני החתימה.'); return; }
    setBusy(true); setProblem('');
    try {
      const r = await fetch(`/api/f101/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: d, attachments: files, signerName: sign.name, signature: sign.signature, confirm: sign.confirm }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        if (j?.code === 'missing' && j.step !== 'sign') { const i = visible.findIndex((s) => s.key === j.step); if (i >= 0) go(i); }
        if (j?.code === 'missing') setProblem(j.message); else setError(j?.message ?? 'הטופס לא נשמר. נסו שוב.');
        return;
      }
      try { sessionStorage.removeItem(store); } catch { /* nothing */ }
      setDone(j as Done); window.scrollTo({ top: 0 });
    } catch { setProblem('אין חיבור כרגע — מה שמילאת נשמר בטלפון. נסו שוב בעוד רגע.'); } finally { setBusy(false); }
  }

  const e = d.employee, c = d.credits;
  const asked = attachmentsAsked(d);
  return (
    <Shell>
      <header className="mb-3">
        <p className="text-sm text-zinc-600">{page.employer}</p>
        <h1 className="text-2xl font-bold">{page.update ? 'עדכון פרטים — טופס 101' : 'טופס 101'} · שנת המס {page.taxYear}</h1>
        <p className="mt-1 text-xs text-zinc-500">כרטיס עובד ובקשה להקלה ולתיאום מס על ידי המעסיק · טופס {page.form.code} (מעודכן ל-{page.form.updated})</p>
      </header>
      <div className="sticky top-0 z-10 -mx-4 mb-4 bg-zinc-50/95 px-4 py-2 backdrop-blur" aria-live="polite">
        <div className="text-sm font-semibold">שלב {step + 1} מתוך {visible.length} — {current.title}</div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-200" role="progressbar" aria-valuemin={1} aria-valuemax={visible.length} aria-valuenow={step + 1} aria-label="התקדמות">
          <div className="h-full rounded-full bg-[#2563eb] transition-[width]" style={{ width: `${((step + 1) / visible.length) * 100}%` }} />
        </div>
      </div>

      <section className="mb-4 rounded-2xl bg-white p-4 shadow-sm" aria-labelledby="step-title">
        <h2 id="step-title" className="mb-3 text-xl font-bold">{sectionTitle(current.key)}</h2>

        {current.key === 'personal' && (<>
          <p className="mb-3 text-sm text-zinc-600">יש לצרף צילום תעודת זהות כולל ספח (בשלב האחרון). למי שאין מספר תעודת זהות — צילום דרכון ואישור / רשיון שהייה בישראל.</p>
          <Text label="מספר זהות (9 ספרות)" value={e.idNumber} inputMode="numeric" onChange={(v) => up((x) => { x.employee.idNumber = v.replace(/\D/g, '').slice(0, 9); })} />
          {!e.idNumber && <Text label="מספר דרכון (למי שאין מספר ת.ז.)" value={e.passport} onChange={(v) => up((x) => { x.employee.passport = v; })} />}
          <Text label="שם משפחה" value={e.lastName} onChange={(v) => up((x) => { x.employee.lastName = v; })} />
          <Text label="שם פרטי" value={e.firstName} onChange={(v) => up((x) => { x.employee.firstName = v; })} />
          <DateField label="תאריך לידה" value={e.birthDate} onChange={(v) => up((x) => { x.employee.birthDate = v; })} />
          <DateField label="תאריך עליה" optional value={e.aliyahDate} onChange={(v) => up((x) => { x.employee.aliyahDate = v; })} />
          <fieldset className="mb-3"><legend className="mb-1 font-semibold">כתובת פרטית</legend>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2"><Text label="רחוב/שכונה" value={e.street} onChange={(v) => up((x) => { x.employee.street = v; })} /></div>
              <Text label="מספר" value={e.houseNumber} onChange={(v) => up((x) => { x.employee.houseNumber = v; })} />
              <div className="col-span-2"><Text label="עיר/ישוב" value={e.city} onChange={(v) => up((x) => { x.employee.city = v; })} /></div>
              <Text label="מיקוד" optional value={e.zip} inputMode="numeric" onChange={(v) => up((x) => { x.employee.zip = v.replace(/\D/g, '').slice(0, 7); })} />
            </div>
          </fieldset>
          <Text label="מספר טלפון" optional value={e.phone} inputMode="tel" onChange={(v) => up((x) => { x.employee.phone = v; })} />
          <Text label="מספר טלפון נייד" optional value={e.mobile} inputMode="tel" onChange={(v) => up((x) => { x.employee.mobile = v; })} />
          <Text label="כתובת דואר אלקטרוני" optional value={e.email} inputMode="email" onChange={(v) => up((x) => { x.employee.email = v; })} />
          <Choice label="מין" value={e.gender} options={GENDER_LABEL} onChange={(v) => up((x) => { x.employee.gender = v; })} />
          <Choice label="מצב משפחתי" value={e.marital} options={MARITAL_LABEL} onChange={(v) => up((x) => { x.employee.marital = v; })} />
          {e.marital === 'separated' && <p className="-mt-2 mb-3 text-sm text-zinc-600">פרוד/ה — חובה לצרף אישור פ"ש.</p>}
          <Choice label="תושב ישראל" value={yesNo(e.resident)} options={YES_NO} onChange={(v) => up((x) => { x.employee.resident = v === 'yes'; })} />
          <Choice label="חבר קיבוץ/מושב שיתופי" value={e.kibbutz} options={KIBBUTZ_LABEL} column onChange={(v) => up((x) => { x.employee.kibbutz = v; })} />
          <Choice label="חבר בקופת חולים" value={yesNo(e.hmo)} options={YES_NO} onChange={(v) => up((x) => { x.employee.hmo = v === 'yes'; })} />
          {e.hmo && <Text label="שם הקופה" value={e.hmoName} onChange={(v) => up((x) => { x.employee.hmoName = v; })} />}
        </>)}

        {current.key === 'children' && (<>
          <p className="mb-3 text-sm text-zinc-600">ילדיי שבשנת המס טרם מלאו להם 19 שנה (עפ"י ספח תעודת זהות). סמן/י ליד כל ילד: אם הילד נמצא בחזקתך, ואם את/ה מקבל/ת בגינו קצבת ילדים מב"ל.</p>
          {d.children.map((k, i) => (
            <fieldset key={i} className="mb-3 rounded-xl border border-zinc-200 p-3">
              <legend className="px-1 font-semibold">ילד/ה {i + 1}</legend>
              <Text label="שם" value={k.name} onChange={(v) => up((x) => { x.children[i].name = v; })} />
              <Text label="מספר זהות" optional value={k.idNumber} inputMode="numeric" onChange={(v) => up((x) => { x.children[i].idNumber = v.replace(/\D/g, '').slice(0, 9); })} />
              <DateField label="תאריך לידה" value={k.birthDate} onChange={(v) => up((x) => { x.children[i].birthDate = v; })} />
              <Check label="הילד נמצא בחזקתי" checked={k.inCustody} onChange={(v) => up((x) => { x.children[i].inCustody = v; })} />
              <Check label="אני מקבל/ת בגינו קצבת ילדים מב״ל" checked={k.allowance} onChange={(v) => up((x) => { x.children[i].allowance = v; })} />
              <button type="button" className="text-sm font-semibold text-red-700 underline" onClick={() => up((x) => { x.children.splice(i, 1); })}>הסרת הילד/ה מהרשימה</button>
            </fieldset>
          ))}
          <button type="button" className={`${ghost} w-full`} onClick={() => up((x) => { x.children.push({ name: '', idNumber: '', birthDate: '', inCustody: false, allowance: false } satisfies Child); })}>+ הוספת ילד/ה</button>
          {!d.children.length && <p className="mt-2 text-sm text-zinc-600">אין ילדים מתחת לגיל 19? אפשר להמשיך.</p>}
        </>)}

        {current.key === 'income' && (<>
          <p className="mb-2 font-semibold">אני מקבל/ת:</p>
          {INCOME_KINDS.map((k) => <Check key={k} label={INCOME_LABEL[k]} checked={d.income.kinds.includes(k)} onChange={(v) => up((x) => { x.income.kinds = toggle(x.income.kinds, k, v); })} />)}
          <Explain kinds={d.income.kinds} />
          <DateField label="תאריך תחילת העבודה בשנת המס" optional value={d.income.startDate} onChange={(v) => up((x) => { x.income.startDate = v; })} />
        </>)}

        {current.key === 'other' && (<>
          <Choice label="" column value={d.other.has === null ? '' : d.other.has ? 'yes' : 'no'}
            options={{ no: 'אין לי הכנסות אחרות ממשכורת (משכורת חודש, בעד משרה נוספת, משכורת חלקית, שכר עבודה), מקצבה וממלגה', yes: 'יש לי הכנסות אחרות כמפורט להלן' }}
            onChange={(v) => up((x) => { x.other.has = v === 'yes'; })} />
          {d.other.has && (<>
            {INCOME_KINDS.map((k) => <Check key={k} label={INCOME_LABEL[k]} checked={d.other.kinds.includes(k)} onChange={(v) => up((x) => { x.other.kinds = toggle(x.other.kinds, k, v); })} />)}
            <p className="mb-2 mt-3 font-semibold">אם יש לך הכנסה אחרת — נא סמן/י:</p>
            <Check label="אבקש לקבל נקודות זיכוי ומדרגות מס כנגד הכנסתי זו (סעיף ד). איני מקבל/ת אותן בהכנסה אחרת" checked={d.other.creditsHere}
              onChange={(v) => up((x) => { x.other.creditsHere = v; if (v) x.other.creditsElsewhere = false; })} />
            <Check label="אני מקבל/ת נקודות זיכוי ומדרגות מס בהכנסה אחרת ועל כן איני זכאי/ת להן כנגד הכנסה זו" checked={d.other.creditsElsewhere}
              onChange={(v) => up((x) => { x.other.creditsElsewhere = v; if (v) x.other.creditsHere = false; })} />
            <Check label="אין מפרישים עבורי לקרן השתלמות בגין הכנסתי האחרת, או שכל הפרשות המעסיק לקרן השתלמות בגין הכנסתי האחרת מצורפות להכנסתי האחרת" checked={d.other.noStudyFund}
              onChange={(v) => up((x) => { x.other.noStudyFund = v; })} />
            <Check label="אין מפרישים עבורי לקצבה/לביטוח אובדן כושר עבודה/פיצויים בגין הכנסתי האחרת, או שכל הפרשות המעסיק לקצבה/לביטוח אובדן כושר עבודה/פיצויים בגין הכנסתי האחרת מצורפות להכנסתי האחרת" checked={d.other.noPension}
              onChange={(v) => up((x) => { x.other.noPension = v; })} />
          </>)}
        </>)}

        {current.key === 'spouse' && (<>
          <Text label="מספר זהות (9 ספרות)" optional value={d.spouse.idNumber} inputMode="numeric" onChange={(v) => up((x) => { x.spouse.idNumber = v.replace(/\D/g, '').slice(0, 9); })} />
          {!d.spouse.idNumber && <Text label="מספר דרכון (למי שאין מספר זהות)" optional value={d.spouse.passport} onChange={(v) => up((x) => { x.spouse.passport = v; })} />}
          <Text label="שם משפחה" value={d.spouse.lastName} onChange={(v) => up((x) => { x.spouse.lastName = v; })} />
          <Text label="שם פרטי" value={d.spouse.firstName} onChange={(v) => up((x) => { x.spouse.firstName = v; })} />
          <DateField label="תאריך לידה" optional value={d.spouse.birthDate} onChange={(v) => up((x) => { x.spouse.birthDate = v; })} />
          <DateField label="תאריך עליה" optional value={d.spouse.aliyahDate} onChange={(v) => up((x) => { x.spouse.aliyahDate = v; })} />
          <Choice label="" column value={d.spouse.hasIncome === null ? '' : d.spouse.hasIncome ? 'yes' : 'no'}
            options={{ no: 'אין לבן/בת הזוג כל הכנסה', yes: 'יש לבן/בת הזוג הכנסה' }} onChange={(v) => up((x) => { x.spouse.hasIncome = v === 'yes'; })} />
          {d.spouse.hasIncome && (<>
            <Check label="עבודה/קצבה/עסק" checked={d.spouse.incomeWork} onChange={(v) => up((x) => { x.spouse.incomeWork = v; })} />
            <Check label="הכנסה אחרת" checked={d.spouse.incomeOther} onChange={(v) => up((x) => { x.spouse.incomeOther = v; })} />
          </>)}
        </>)}

        {current.key === 'credits' && (<>
          <p className="mb-3 text-sm text-zinc-600">אני מבקש/ת פטור או זיכוי ממס מהסיבות הבאות. מסמנים רק מה שנכון — שום סעיף לא מסומן מראש.</p>
          {CREDIT_TEXT.map((x) => (
            <div key={x.key} className="mb-2">
              <Check label={`${x.n}. ${x.text}`} checked={Boolean(c[x.key])} onChange={(v) => up((f) => { (f.credits[x.key] as boolean) = v; })} />
              {c[x.key] && (
                <div className="mb-3 me-1 ms-8">
                  {x.note && <p className="mb-2 text-xs text-zinc-600">{x.note}</p>}
                  {x.key === 'settlement' && (<><DateField label="מתאריך" value={c.settlementFrom} onChange={(v) => up((f) => { f.credits.settlementFrom = v; })} />
                    <Text label="מתגוררים ביישוב" value={c.settlementName} onChange={(v) => up((f) => { f.credits.settlementName = v; })} /></>)}
                  {x.key === 'immigrant' && (<><DateField label="אני עולה חדש/ה מתאריך" value={c.immigrantFrom} onChange={(v) => up((f) => { f.credits.immigrantFrom = v; })} />
                    <DateField label="לא היתה לי הכנסה בישראל מתחילת שנת המס הנוכחית עד תאריך" optional value={c.immigrantNoIncomeUntil} onChange={(v) => up((f) => { f.credits.immigrantNoIncomeUntil = v; })} /></>)}
                  {(x.key === 'childrenInCustody' || x.key === 'childrenOther') && COUNTS_OF[x.key === 'childrenInCustody' ? 'custodyCounts' : 'otherCounts'].map((k) => {
                    const g = x.key === 'childrenInCustody' ? 'custodyCounts' : 'otherCounts';
                    return <Text key={k} label={COUNT_LABEL[k]} optional value={c[g][k]} inputMode="numeric" onChange={(v) => up((f) => { f.credits[g][k] = v.replace(/\D/g, '').slice(0, 2); })} />;
                  })}
                  {x.key === 'disabledChildren' && <Text label="מספר הילדים" value={c.disabledChildrenCount} inputMode="numeric" onChange={(v) => up((f) => { f.credits.disabledChildrenCount = v.replace(/\D/g, '').slice(0, 2); })} />}
                  {x.key === 'discharged' && (<><DateField label="תאריך תחילת השירות" value={c.serviceFrom} onChange={(v) => up((f) => { f.credits.serviceFrom = v; })} />
                    <DateField label="תאריך סיום השירות" value={c.serviceTo} onChange={(v) => up((f) => { f.credits.serviceTo = v; })} /></>)}
                  {x.key === 'reserveCombat' && <Text label='סה"כ ימי מילואים בשנת המס הקודמת' value={c.reserveDays} inputMode="numeric" onChange={(v) => up((f) => { f.credits.reserveDays = v.replace(/\D/g, '').slice(0, 3); })} />}
                </div>
              )}
            </div>
          ))}
        </>)}

        {current.key === 'coordination' && (<>
          <p className="mb-3 text-sm text-zinc-600">אני מבקש/ת תיאום מס מהסיבות הבאות (אם אין — ממשיכים).</p>
          <Check label="1. לא היתה לי הכנסה מתחילת שנת המס הנוכחית עד לתחילת עבודתי אצל מעסיק זה." checked={d.coordination.noIncomeSinceYearStart}
            onChange={(v) => up((x) => { x.coordination.noIncomeSinceYearStart = v; })} />
          {d.coordination.noIncomeSinceYearStart && <p className="mb-3 me-1 ms-8 text-xs text-zinc-600">יש להמציא הוכחה כגון: אישור משטרת הגבולות בגין שהייה בחו"ל, אישור מחלה וכיו"ב. בהעדר הוכחה יש לפנות לפקיד השומה. דמי לידה ודמי אבטלה הינם הכנסה חייבת.</p>}
          <Check label="2. יש לי הכנסות נוספות ממשכורת כמפורט להלן:" checked={d.coordination.hasOthers} onChange={(v) => up((x) => { x.coordination.hasOthers = v; if (v && !x.coordination.others.length) x.coordination.others.push(emptyPayer()); })} />
          {d.coordination.hasOthers && d.coordination.others.map((o, i) => (
            <fieldset key={i} className="mb-3 rounded-xl border border-zinc-200 p-3">
              <legend className="px-1 font-semibold">המעסיק/משלם המשכורת {i + 1}</legend>
              <Text label="שם" value={o.name} onChange={(v) => up((x) => { x.coordination.others[i].name = v; })} />
              <Text label="כתובת" optional value={o.address} onChange={(v) => up((x) => { x.coordination.others[i].address = v; })} />
              <Text label="מספר תיק ניכויים" optional value={o.fileNumber} inputMode="numeric" onChange={(v) => up((x) => { x.coordination.others[i].fileNumber = v.replace(/\D/g, '').slice(0, 9); })} />
              <Text label="סוג ההכנסה (עבודה/קצבה/מלגה/אחר)" optional value={o.kind} onChange={(v) => up((x) => { x.coordination.others[i].kind = v; })} />
              <Text label="הכנסה חודשית" optional value={o.monthly} inputMode="decimal" onChange={(v) => up((x) => { x.coordination.others[i].monthly = v; })} />
              <Text label="המס שנוכה (לפי התלושים)" optional value={o.taxDeducted} inputMode="decimal" onChange={(v) => up((x) => { x.coordination.others[i].taxDeducted = v; })} />
              <button type="button" className="text-sm font-semibold text-red-700 underline" onClick={() => up((x) => { x.coordination.others.splice(i, 1); })}>הסרה</button>
            </fieldset>
          ))}
          {d.coordination.hasOthers && <button type="button" className={`${ghost} mb-3 w-full`} onClick={() => up((x) => { x.coordination.others.push(emptyPayer()); })}>+ עוד מעסיק/משלם</button>}
          <Check label="3. פקיד השומה אישר תיאום לפי אישור מצורף." checked={d.coordination.assessorApproved} onChange={(v) => up((x) => { x.coordination.assessorApproved = v; })} />
        </>)}

        {current.key === 'sign' && (<>
          {page.update && <Text label="מה השתנה? (ז. שינויים במהלך השנה)" optional value={d.changeNote} onChange={(v) => up((x) => { x.changeNote = v; })} />}
          <h3 className="mb-2 mt-1 font-bold">נספחים</h3>
          <ul className="mb-4 flex flex-col gap-2">
            {[...asked, 'other' as AttachKind].map((k) => {
              const got = files.filter((f) => f.kind === k);
              return (
                <li key={k} className="rounded-xl border border-zinc-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold">{ATTACH_LABEL[k]}</span>
                    {got.length > 0 ? <span className="shrink-0 text-sm font-bold text-green-700">צורף ✓</span> : k !== 'other' ? <span className="shrink-0 text-sm text-amber-700">חסר</span> : null}
                  </div>
                  {got.map((f) => <p key={f.path} className="text-xs text-zinc-600">{f.name || 'קובץ'}</p>)}
                  <label className={`${ghost} mt-2 inline-flex cursor-pointer items-center`}>
                    {uploading === k ? 'מעלה…' : got.length ? 'צירוף קובץ נוסף' : 'צילום / צירוף קובץ'}
                    <input type="file" accept="image/*,application/pdf" className="sr-only" disabled={uploading !== null}
                      onChange={(ev) => { void attach(k, ev.target.files?.[0]); ev.target.value = ''; }} />
                  </label>
                </li>
              );
            })}
          </ul>
          {warnings(d).length > 0 && (
            <div className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              <p className="mb-1 font-bold">מדברי ההסבר של הטופס:</p>
              <ul className="list-disc ps-5">{warnings(d).map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
          <h3 className="mb-2 font-bold">י. הצהרה</h3>
          <p className="mb-3">{DECLARATION}</p>
          <Text label="שם מלא" value={sign.name} onChange={(v) => setSign({ ...sign, name: v })} />
          <div className="mb-3">
            <span className="mb-1 block font-semibold">חתימת המבקש/ת (באצבע)</span>
            <SignaturePad value={sign.signature} onChange={(v) => { setSign({ ...sign, signature: v }); if (v) setProblem(''); }} invalid={problem === 'חסרה חתימה.'} />
          </div>
          <Check label="אני מאשר/ת את ההצהרה" checked={sign.confirm} onChange={(v) => { setSign({ ...sign, confirm: v }); if (v) setProblem(''); }} />
          <p className="mt-1 text-xs text-zinc-500">התאריך והשעה נרשמים אוטומטית בשרת בזמן השליחה. הפרטים נשמרים רק אצל המעסיק ורואה החשבון.</p>
        </>)}
      </section>

      {problem && <p className="mb-3 rounded-xl bg-red-50 p-3 font-semibold text-red-700" role="alert">{problem}</p>}
      <div className="mb-10 flex gap-2">
        {step > 0 && <button type="button" className={`${ghost} flex-1`} onClick={() => go(step - 1)}>הקודם</button>}
        {current.key !== 'sign'
          ? <button type="button" className={`${primary} flex-[2]`} onClick={next}>הבא</button>
          : <button type="button" className={`${primary} flex-[2] text-lg`} disabled={busy || uploading !== null} onClick={() => void submit()}>{busy ? 'שולח…' : 'חתימה ושליחה'}</button>}
      </div>
    </Shell>
  );
}

const YES_NO = { yes: 'כן', no: 'לא' } as const;
const yesNo = (v: boolean | null) => (v === true ? 'yes' : v === false ? 'no' : '') as '' | 'yes' | 'no';
const toggle = <T,>(list: T[], k: T, on: boolean) => (on ? [...new Set([...list, k])] : list.filter((x) => x !== k));
const emptyPayer = (): OtherPayer => ({ name: '', address: '', fileNumber: '', kind: '', monthly: '', taxDeducted: '' });
const sectionTitle = (k: Step) => ({
  personal: 'ב. פרטי העובד/ת', children: 'ג. פרטים על ילדיי שבשנת המס טרם מלאו להם 19 שנה', income: 'ד. פרטים על הכנסותיי ממעסיק זה',
  other: 'ה. פרטים על הכנסות אחרות', spouse: 'ו. פרטים על בן/בת הזוג', credits: 'ח. אני מבקש/ת פטור או זיכוי ממס', coordination: 'ט. אני מבקש/ת תיאום מס', sign: 'נספחים, הצהרה וחתימה',
} as Record<Step, string>)[k];

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main dir="rtl" lang="he" className="min-h-screen bg-zinc-50 px-4 py-6 text-black" style={{ colorScheme: 'light' }}>
      <div className="mx-auto max-w-xl">{children}</div>
    </main>
  );
}
function Text({ label, value, onChange, optional, inputMode }: { label: string; value: string; onChange: (v: string) => void; optional?: boolean; inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'] }) {
  const id = useId();
  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1 block font-semibold">{label}{optional ? <> <span className="text-sm font-normal text-zinc-500">(לא חובה)</span></> : null}</label>
      <input id={id} className={input} value={value} inputMode={inputMode} dir={inputMode === 'email' ? 'ltr' : undefined} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
function DateField({ label, value, onChange, optional }: { label: string; value: string; onChange: (v: string) => void; optional?: boolean }) {
  const id = useId();
  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1 block font-semibold">{label}{optional ? <> <span className="text-sm font-normal text-zinc-500">(לא חובה)</span></> : null}</label>
      <input id={id} type="date" className={input} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="mb-2 flex items-start gap-3 rounded-xl border border-zinc-200 p-3">
      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[#2563eb]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
function Choice<K extends string>({ label, value, options, onChange, column }: { label: string; value: K | ''; options: Record<K, string>; onChange: (v: K) => void; column?: boolean }) {
  const name = useId();
  return (
    <fieldset className="mb-3">
      {label && <legend className="mb-1 font-semibold">{label}</legend>}
      <div className={column ? 'flex flex-col gap-2' : 'flex flex-wrap gap-2'}>
        {(Object.keys(options) as K[]).map((k) => (
          <label key={k} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 ${value === k ? 'border-[#2563eb] bg-blue-50 font-semibold' : 'border-zinc-300 bg-white'}`}>
            <input type="radio" name={name} className="h-4 w-4 accent-[#2563eb]" checked={value === k} onChange={() => onChange(k)} />
            <span>{options[k]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
function Explain({ kinds }: { kinds: string[] }) {
  const lines = [
    kinds.includes('monthly') && '(2) משכורת חודש — משכורת בעד עבודה של לא פחות מ-18 יום בחודש.',
    kinds.includes('additional') && '(3) משכורת בעד משרה נוספת — משכורת בעד עבודה של יותר מ-5 שעות ביום, נוסף למשכורת ו/או בנוסף לקצבה החייבת במס ממקום אחר. העובד רשאי לבחור את מקום העבודה בו תחשב משכורתו כ"משכורת בעד משרה נוספת".',
    kinds.includes('partial') && '(4) משכורת חלקית — משכורת בעד עבודה של 5 שעות או פחות ליום או משכורת בעד עבודה במשך יותר מ-5 שעות ליום אך פחות מ-8 שעות בשבוע. ממשכורת חלקית ינוכה מס בשיעור מירבי אלא אם כן זו הכנסה יחידה שאז ינוכה מס לפי לוח הניכויים.',
    kinds.includes('daily') && '(5) שכר עבודה — משכורת בעד עבודה של פחות מ-18 יום בחודש אך לא פחות מ-8 שעות בשבוע. משכר עבודה ינוכה מס לפי לוח יומי אלא אם כן זו הכנסה יחידה שאז ינוכה מס לפי לוח הניכויים.',
    kinds.includes('pension') && '(6) קצבה — אין לדווח על קצבה פטורה מביטוח לאומי וקצבת שאירים שכולה פטורה.',
  ].filter(Boolean) as string[];
  return lines.length ? <div className="mb-3 rounded-xl bg-zinc-100 p-3 text-xs text-zinc-700">{lines.map((l) => <p key={l} className="mb-1">{l}</p>)}</div> : null;
}
