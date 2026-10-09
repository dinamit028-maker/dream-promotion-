'use client';
import { useCallback, useEffect, useRef } from 'react';
import { followUpsOpen, type Answers, type Field, type FollowUp } from './declarations';

/**
 * The parts of the customer's declaration page (/h/<token>): a question (yes/no with its follow-ups, text, choice…) and
 * the finger signature. Shared with the owner's preview before approval, so the preview is exactly what the customer sees.
 * Light colours always (the page is the customer's, not the dashboard's theme).
 */
export const btn = 'min-h-11 rounded-xl border px-4 py-2 text-base font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6b3bf5]';
export const input = 'w-full rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-base text-black focus-visible:outline-2 focus-visible:outline-[#6b3bf5]';

export function Question({ id, prefix, field, answers, problem, onAnswer }: {
  id: string; prefix: string; field: Field; answers: Answers; problem: { id: string; message: string } | null;
  onAnswer: (key: string, v: Answers[string] | undefined) => void;
}) {
  const bad = problem?.id === id;
  const firstUp = useRef<HTMLDivElement>(null);
  const open = followUpsOpen(field, answers[field.key]);
  const wasOpen = useRef(open);
  useEffect(() => {
    // the follow-ups just opened: the first one gets the focus
    if (open && !wasOpen.current) (firstUp.current?.querySelector('input, textarea, button') as HTMLElement | null)?.focus();
    wasOpen.current = open;
  }, [open]);

  if (field.type === 'info') return <p id={id} className="mb-4 whitespace-pre-wrap leading-relaxed">{field.label}</p>;
  if (field.type === 'marketing') {
    return (
      <label id={id} className="mb-4 flex items-start gap-3 rounded-xl border border-zinc-200 p-3">
        <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[#6b3bf5]" checked={answers[field.key] === 'yes'}
          onChange={(e) => onAnswer(field.key, e.target.checked ? 'yes' : 'no')} />
        <span><span className="whitespace-pre-wrap">{field.label}</span><span className="block text-xs text-zinc-500">לא חובה. בלי סימון — התמונות נשארות בתיק בלבד.</span></span>
      </label>
    );
  }
  return (
    <div id={id} className={`mb-4 rounded-xl p-3 ${bad ? 'bg-red-50 ring-2 ring-red-600' : ''}`}>
      <Control fieldKey={field.key} labelId={`${id}-label`} label={field.label} required={field.required} type={field.type} options={field.options}
        value={answers[field.key]} onChange={(v) => onAnswer(field.key, v)} invalid={bad} />
      {field.type === 'yesno' && field.followUps?.length ? (
        <div ref={firstUp} className={`grid transition-[grid-template-rows,opacity] duration-200 ${open ? 'mt-3 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`} aria-hidden={!open}>
          <div className="overflow-hidden">
            {open && field.followUps.map((u: FollowUp) => {
              const uid = `${prefix}-${u.key}`;
              return (
                <div key={u.key} id={uid} className={`mb-2 border-s-4 border-[#6b3bf5]/40 ps-3 ${problem?.id === uid ? 'rounded-xl bg-red-50 ring-2 ring-red-600' : ''}`}>
                  <Control fieldKey={u.key} labelId={`${uid}-label`} label={u.label} required={u.required} type={u.type} options={u.options}
                    value={answers[u.key]} onChange={(v) => onAnswer(u.key, v)} invalid={problem?.id === uid} />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Control({ fieldKey, labelId, label, required, type, options, value, onChange, invalid }: {
  fieldKey: string; labelId: string; label: string; required: boolean; type: Field['type'] | FollowUp['type']; options?: string[];
  value: Answers[string] | undefined; onChange: (v: Answers[string] | undefined) => void; invalid: boolean;
}) {
  const title = <span id={labelId} className="mb-2 block font-semibold whitespace-pre-wrap">{label}{required && <span aria-hidden className="text-red-600"> *</span>}</span>;
  if (type === 'yesno') {
    return (
      <div role="radiogroup" aria-labelledby={labelId} aria-required={required} aria-invalid={invalid}>
        {title}
        <div className="flex gap-2">
          {(['yes', 'no'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
              className={`${btn} flex-1 ${value === v ? 'border-[#6b3bf5] bg-[#6b3bf5] text-white' : 'border-zinc-300 bg-white text-black'}`}>
              {v === 'yes' ? 'כן' : 'לא'}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (type === 'choice' || type === 'multi') {
    const multi = type === 'multi';
    const picked = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return (
      <fieldset aria-required={required} aria-invalid={invalid}>
        <legend className="contents">{title}</legend>
        <div className="grid gap-2">
          {(options ?? []).map((o) => (
            <label key={o} className="flex min-h-11 items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3">
              <input type={multi ? 'checkbox' : 'radio'} name={fieldKey} className="h-5 w-5 accent-[#6b3bf5]" checked={picked.includes(o)}
                onChange={(e) => onChange(multi ? (e.target.checked ? [...picked, o] : picked.filter((x) => x !== o)) : o)} />
              <span>{o}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <label className="block">
      {title}
      {type === 'longtext' || type === 'meds'
        ? <textarea className={`${input} min-h-24`} value={text} onChange={(e) => onChange(e.target.value)} aria-required={required} aria-invalid={invalid}
            placeholder={type === 'meds' ? 'שם התרופה ומינון — כל תרופה בשורה' : undefined} />
        : <input className={input} type={type === 'date' ? 'date' : 'text'} value={text} onChange={(e) => onChange(e.target.value)} aria-required={required} aria-invalid={invalid} />}
    </label>
  );
}

/** a finger (or mouse) signature on a canvas; the value is a PNG data URL — empty until a stroke is drawn */
export function SignaturePad({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const W = 900, H = 300;

  // a signature copied from another declaration ("same signature") is drawn in; clearing empties the canvas
  useEffect(() => {
    const c = canvas.current, ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    if (!value) { ctx.clearRect(0, 0, W, H); c.dataset.drawn = ''; return; }
    if (c.dataset.drawn === value) return;
    const img = new Image();
    img.onload = () => { ctx.clearRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); c.dataset.drawn = value; };
    img.src = value;
  }, [value]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const finish = useCallback(() => {
    if (!drawing.current) return;
    drawing.current = false; last.current = null;
    const c = canvas.current;
    if (c) { const v = c.toDataURL('image/png'); c.dataset.drawn = v; onChange(v); }
  }, [onChange]);

  return (
    <div>
      <canvas ref={canvas} width={W} height={H} aria-label="משטח חתימה — חתמו באצבע" role="img" tabIndex={0}
        className={`h-40 w-full touch-none rounded-xl border-2 border-dashed bg-white ${invalid ? 'border-red-600' : 'border-zinc-300'}`}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; last.current = point(e); }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext('2d')!, p = point(e), q = last.current ?? p;
          ctx.strokeStyle = '#111'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(p.x, p.y); ctx.stroke();
          last.current = p;
        }}
        onPointerUp={finish} onPointerCancel={finish} onPointerLeave={finish} />
      <button type="button" className="mt-1 text-sm font-semibold text-zinc-600 underline" onClick={() => onChange('')}>נקה</button>
    </div>
  );
}
