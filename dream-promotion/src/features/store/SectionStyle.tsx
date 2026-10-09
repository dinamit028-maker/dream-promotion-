'use client';
import { Button, Select } from '@/components/ui/primitives';
import { STYLE_KEYS, STYLE_LABELS, STYLE_SCALES } from './builder-registry';
import { resetDevice, setSectionStyle, styleShown } from './section-style';
import { DEVICES, type Device, type Draft, type Section } from './theme-fields';

/**
 * "עיצוב החלק" (Dream Builder PR-3d, 2.68): spacing, background, alignment and width of one section — steps of fixed
 * scales, for the screen shown in the editor. The phone is the base; on a tablet or a computer a value of its own is marked
 * "• רק ב…", and "חזרה" brings that screen back to the one below it.
 */
const below: Record<Device, string> = { base: 'ברירת מחדל', md: 'כמו בטלפון', lg: 'כמו בטאבלט' };

export function SectionStyle({ d, section, device, change, onDevice }: {
  d: Draft; section: Section; device: Device; change: (next: Draft, key: string) => void;
  /** the visual editor: the screen shown, switched here too (on a phone the panel covers the switch above the site) */
  onDevice?: (device: Device) => void;
}) {
  const label = DEVICES.find((x) => x.id === device)!.label;
  const own = device !== 'base' && Boolean(section.responsive?.[device]);
  return (
    <fieldset className="stack-y-2 rounded-md border border-line p-2">
      <legend className="px-1 text-sm font-bold">{`עיצוב החלק — ${label}`}</legend>
      {onDevice && (
        <div className="flex gap-1" role="group" aria-label="לאיזה מסך">
          {DEVICES.map((dv) => <Button key={dv.id} size="sm" variant={device === dv.id ? 'primary' : 'ghost'} aria-pressed={device === dv.id}
            aria-label={`עיצוב ל${dv.label}`} onClick={() => onDevice(dv.id)}>{dv.label}</Button>)}
        </div>
      )}
      <p className="text-xs text-muted">{device === 'base'
        ? 'הטלפון הוא הבסיס: טאבלט ומחשב לוקחים ממנו, אלא אם נבחר להם אחרת.'
        : `מה שנבחר כאן — רק ב${label} ומעלה. השאר נלקח מהמסך הקטן יותר.`}</p>
      <div className="grid grid-cols-2 gap-2">
        {STYLE_KEYS.map((k) => {
          const shown = styleShown(section, device, k);
          return (
            <label key={k} className="block">
              <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-ink-2">
                {STYLE_LABELS[k]}{shown.own && device !== 'base' && <span className="text-primary" title={`רק ב${label}`}>{`• רק ב${label}`}</span>}
              </span>
              <Select aria-label={`${STYLE_LABELS[k]} (${label})`} value={shown.own ? shown.value : ''}
                onChange={(e) => change(setSectionStyle(d, section.id, device, k, e.target.value), `style:${section.id}:${device}:${k}`)}>
                <option value="">{shown.value && !shown.own ? `${below[device]} (${STYLE_SCALES[k].find((x) => x.value === shown.value)?.label})` : below[device]}</option>
                {STYLE_SCALES[k].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </label>
          );
        })}
      </div>
      {own && <Button size="sm" variant="ghost" onClick={() => change(resetDevice(d, section.id, device as 'md' | 'lg'), `style:${section.id}:${device}:reset`)}>
        {`חזרה ל${device === 'md' ? 'טלפון' : 'טאבלט'} — בלי ערכים משלו ב${label}`}
      </Button>}
    </fieldset>
  );
}
