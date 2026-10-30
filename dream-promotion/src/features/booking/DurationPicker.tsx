'use client';
import { Chip } from '@/components/ui/primitives';
import { DURATIONS, defaultEnd, durationLabel, lengthOf } from './appt-times';

/**
 * "כמה זמן" (2.110): a tap gives the appointment that length from its start — 11:00 and "שעה וחצי" end at 12:30. The same
 * end as typing it in "סיום" (the owner of the system, 30.10.2026: a practitioner decides at the hour how long a customer gets).
 */
export function DurationPicker({ start, end, onPick, disabled }: { start: string; end: string; onPick: (end: string) => void; disabled?: boolean }) {
  const now = lengthOf(start, end);
  return (
    <div className="mb-3" role="group" aria-label="משך התור">
      <p className="mb-1.5 text-sm font-semibold">משך{now ? `: ${durationLabel(now)}` : ''}</p>
      <div className="flex flex-wrap gap-1.5">
        {DURATIONS.map((m) => (
          <Chip key={m} on={now === m} onClick={() => onPick(defaultEnd(start, m))} disabled={disabled || !start}>
            {durationLabel(m)}
          </Chip>
        ))}
      </div>
    </div>
  );
}
