'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { PREVIEW_LINE, VOICE_STYLES, VoiceService, type VoiceOption } from '@/lib/services/voice.service';
import { SUGGESTED_TERMS, type Pronunciation } from '@/lib/pronunciation';
import { Button, Card, Chip, Field, Input, Pill } from '@/components/ui/primitives';
import { AdapterNote, Spinner } from '@/components/ui/feedback';
import { Play, Plus, Trash, Sparkle } from '@/components/ui/Icon';
import { cx } from '@/lib/utils';

export function voiceErrorText(code?: string) {
  if (code === 'no_voice_key') return 'מנוע הקול לא מוגדר — חסר ELEVENLABS_API_KEY בשרת.';
  if (code === 'bad_voice_key') return 'מפתח הקול נדחה. בדקו אותו בהגדרות הספק.';
  if (code === 'no_voice_credit') return 'נגמרו הקרדיטים בחשבון הקול.';
  if (code === 'rate_limited') return 'יותר מדי בקשות קול. המתינו רגע ונסו שוב.';
  return 'יצירת הקריינות נכשלה.';
}

/** Voice selection, preview and pronunciation overrides. The engine behind it is swappable. */
export function VoicePanel() {
  const { voice, setVoice, pronunciations, setPronunciations } = useApp();
  const [status, setStatus] = useState<{ available: boolean; provider: string; voices: VoiceOption[] } | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => { VoiceService.status(voice.language).then(setStatus); }, [voice.language]);

  // pick a sensible default voice once the list arrives
  useEffect(() => {
    if (!voice.voiceId && status?.voices.length) setVoice({ voiceId: status.voices[0].id });
  }, [status, voice.voiceId, setVoice]);

  async function preview(v: VoiceOption) {
    setPreviewing(v.id); setError(null);
    try {
      const n = await VoiceService.narrate({
        text: PREVIEW_LINE, voiceId: v.id, style: voice.style, language: voice.language, pronunciations,
      });
      audio.current?.pause();
      audio.current = new Audio(n.audioUrl);
      await audio.current.play();
    } catch (e: any) { setError(voiceErrorText(e.code)); }
    finally { setPreviewing(null); }
  }

  const update = (i: number, patch: Partial<Pronunciation>) =>
    setPronunciations(pronunciations.map((p, n) => (n === i ? { ...p, ...patch } : p)));

  if (status && !status.available) {
    return (
      <Card>
        <h3 className="mb-3 font-display text-lg font-bold">קריינות</h3>
        <AdapterNote title="מנוע הקול לא מוגדר.">
          הוסיפו <code>ELEVENLABS_API_KEY</code> במשתני הסביבה ובצעו פריסה מחדש. המנוע ניתן להחלפה דרך <code>VOICE_PROVIDER</code> בלי לשנות את שאר המערכת.
        </AdapterNote>
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-lg font-bold">קריינות</h3>
        {status && <Pill tone="ai">{status.provider}</Pill>}
      </div>

      <Field label="שפה">
        <div className="flex gap-2">
          {([['he', 'עברית'], ['en', 'English']] as const).map(([id, label]) => (
            <Chip key={id} on={voice.language === id} onClick={() => setVoice({ language: id, voiceId: '' })}>{label}</Chip>
          ))}
        </div>
      </Field>

      <Field label="סגנון">
        <div className="flex flex-wrap gap-2">
          {VOICE_STYLES.map((s) => (
            <Chip key={s.id} on={voice.style === s.id} onClick={() => setVoice({ style: s.id })}>{s.label}</Chip>
          ))}
        </div>
      </Field>

      <Field label="קול">
        {!status ? <Spinner /> : (
          <div className="max-h-64 space-y-2 overflow-y-auto pe-1">
            {status.voices.slice(0, 24).map((v) => (
              <div key={v.id}
                className={cx('flex items-center gap-2 rounded-2xl border-[1.5px] p-2.5 transition-colors',
                  voice.voiceId === v.id ? 'border-primary bg-primary-soft' : 'border-line')}>
                <button type="button" onClick={() => setVoice({ voiceId: v.id })} className="min-w-0 flex-1 text-start">
                  <strong className="block truncate text-sm">
                    {v.name}{v.gender !== 'unknown' && <span className="text-muted"> · {v.gender === 'female' ? 'אישה' : 'גבר'}</span>}
                  </strong>
                  {v.description && <span className="block truncate text-xs text-muted">{v.description}</span>}
                </button>
                <Button size="sm" variant="ghost" aria-label={`השמעת ${v.name}`} onClick={() => preview(v)} disabled={previewing === v.id}>
                  {previewing === v.id ? <Spinner /> : <Play size={16} weight="fill" aria-hidden />}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Field>

      {error && <p className="mb-3 text-sm text-warn">{error}</p>}

      {/* ---- pronunciation overrides: change what is SAID, not what is written ---- */}
      <div className="border-t border-line pt-4">
        <button type="button" onClick={() => setShowTerms((v) => !v)} className="flex w-full items-center justify-between text-start">
          <span>
            <strong className="block text-sm">הגייה של מותגים ומילים לועזיות</strong>
            <span className="text-xs text-muted">משנה רק איך המנוע מבטא. הכתוביות נשארות במקור.</span>
          </span>
          <Pill>{pronunciations.length}</Pill>
        </button>

        {showTerms && (
          <div className="mt-3 space-y-2">
            {pronunciations.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={p.term} placeholder="eSIM" onChange={(e) => update(i, { term: e.target.value })} />
                <span className="shrink-0 text-muted">←</span>
                <Input value={p.say} placeholder="אי סים" onChange={(e) => update(i, { say: e.target.value })} />
                <Button size="sm" variant="ghost" aria-label="מחיקה" className="text-[var(--danger)]"
                  onClick={() => setPronunciations(pronunciations.filter((_, n) => n !== i))}>
                  <Trash size={15} aria-hidden />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={() => setPronunciations([...pronunciations, { term: '', say: '' }])}>
                <Plus size={15} aria-hidden />הוספה
              </Button>
              {SUGGESTED_TERMS.filter((t) => !pronunciations.some((p) => p.term.toLowerCase() === t.toLowerCase())).map((t) => (
                <Chip key={t} onClick={() => setPronunciations([...pronunciations, { term: t, say: '' }])}>
                  <Sparkle size={13} weight="fill" aria-hidden />{t}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
