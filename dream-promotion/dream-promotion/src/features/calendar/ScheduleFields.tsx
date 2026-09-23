'use client';
import { Field, Input } from '@/components/ui/primitives';
import { addDays, cx, dayName, fmtDay, parse, today } from '@/lib/utils';
import { CalendarBlank } from '@/components/ui/Icon';

/** Date + time picker built for the thumb: the next 7 days as tap targets,
 *  plus a native date input for anything further out. */
export function ScheduleFields({
  date, time, onChange,
}: { date: string; time: string; onChange: (v: { date: string; time: string }) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today(), i));
  return (
    <>
      <Field label="באיזה יום?">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {days.map((d, i) => (
            <button key={d} type="button" onClick={() => onChange({ date: d, time })}
              className={cx(
                'flex min-h-14 min-w-[58px] shrink-0 flex-col items-center justify-center rounded-2xl border-[1.5px] px-3 py-1.5 transition-colors',
                date === d ? 'border-primary bg-primary-soft text-primary' : 'border-transparent bg-surface-2',
              )}>
              <span className="text-xs font-semibold">{i === 0 ? 'היום' : i === 1 ? 'מחר' : `${dayName(d)}׳`}</span>
              <span className="font-display text-lg font-extrabold">{parse(d).getDate()}</span>
            </button>
          ))}
        </div>
      </Field>
      <div className="flex gap-3">
        <div className="flex-1">
          <Field label="או תאריך אחר">
            <Input type="date" value={date} min={today()} onChange={(e) => onChange({ date: e.target.value, time })} />
          </Field>
        </div>
        <div className="w-32">
          <Field label="שעה">
            <Input type="time" value={time} onChange={(e) => onChange({ date, time: e.target.value })} />
          </Field>
        </div>
      </div>
      {date && (
        <p className="flex items-center gap-2 rounded-md bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">
          <CalendarBlank size={18} aria-hidden className="shrink-0" />יתפרסם ביום {dayName(date)}׳, {fmtDay(date)} בשעה {time}
        </p>
      )}
    </>
  );
}
