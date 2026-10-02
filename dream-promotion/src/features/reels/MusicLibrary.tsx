'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { authHeaders } from '@/lib/services/http';
import { Button, Chip, Input } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { Play } from '@/components/ui/Icon';
import { cx } from '@/lib/utils';
import { friendlyMediaError } from '@/lib/friendly-errors';

export interface FreeTrack {
  id: string; title: string; creator: string; url: string; durationSec: number | null;
  license: string; licenseVersion: string; attribution: string; source: string; page: string | null;
}

/** Moods in Hebrew → search words the music index understands */
const MOODS: { label: string; q: string }[] = [
  { label: 'שמח', q: 'happy' }, { label: 'אנרגטי', q: 'energetic' }, { label: 'רגוע', q: 'calm' },
  { label: 'יוקרתי', q: 'piano' }, { label: 'מוטיבציה', q: 'inspiring' }, { label: 'קיץ', q: 'summer' },
  { label: 'אלקטרוני', q: 'electronic' }, { label: 'אקוסטי', q: 'guitar' }, { label: 'רקע', q: 'background' },
];
const needsCredit = (license: string) => !['cc0', 'pdm'].includes(license);
const fmt = (s: number | null) => (s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/**
 * Free background music, commercial use allowed (Openverse: Jamendo, Freesound, Wikimedia).
 * Choosing a track copies it into the media library, so the reel never depends on an outside link.
 */
export function MusicLibrary({ open, onClose, onChoose }: {
  open: boolean; onClose: () => void;
  onChoose: (m: { mediaId: string; url: string; name: string; attribution?: string; license?: string }) => void;
}) {
  const addMedia = useApp((s) => s.addMedia);
  const [q, setQ] = useState('happy');
  const [text, setText] = useState('');
  const [tracks, setTracks] = useState<FreeTrack[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  // off (default): only music with no copyright at all (CC0 / public domain) — nothing to credit
  const [withCredit, setWithCredit] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  async function search(query: string, p = 1, credit = withCredit) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/music/search?q=${encodeURIComponent(query)}&page=${p}${credit ? '&credit=1' : ''}`, { headers: await authHeaders() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || 'search failed');
      setTracks((t) => (p === 1 ? j.tracks : [...t, ...j.tracks]));
      setMore(Boolean(j.more)); setPage(p);
    } catch (e: any) { setError(`החיפוש לא עבד: ${friendlyMediaError(e.message)}`); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (open && !tracks.length) void search(q); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  useEffect(() => () => audio.current?.pause(), []);
  useEffect(() => { if (!open) { audio.current?.pause(); setPlaying(null); } }, [open]);

  function toggle(t: FreeTrack) {
    if (playing === t.id) { audio.current?.pause(); setPlaying(null); return; }
    audio.current?.pause();
    audio.current = new Audio(t.url);
    audio.current.onended = () => setPlaying(null);
    void audio.current.play().catch(() => setError('לא הצלחנו לנגן את השיר הזה.'));
    setPlaying(t.id);
  }

  async function choose(t: FreeTrack) {
    setSaving(t.id); setError(null);
    try {
      // copy into the user's storage (the archive endpoint downloads through the safe fetcher)
      const r = await fetch('/api/archive', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ url: t.url, kind: 'audio', name: `🎵 ${t.title} · ${t.creator}` }),
      });
      const j = await r.json();
      if (!r.ok || !j.id) throw new Error(j.message || j.code || 'save failed');
      addMedia({ id: j.id, url: j.url, name: `🎵 ${t.title} · ${t.creator}`, kind: 'audio', persistent: true });
      onChoose({ mediaId: j.id, url: j.url, name: `${t.title} · ${t.creator}`, attribution: t.attribution, license: t.license });
      audio.current?.pause();
      onClose();
    } catch (e: any) { setError(`השיר לא נשמר: ${friendlyMediaError(e.message)}`); }
    finally { setSaving(null); }
  }

  return (
    <Modal open={open} onClose={onClose} wide>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-display text-xl font-extrabold">מוזיקת רקע חינם</h3>
        <CloseButton onClick={onClose} />
      </div>
      <p className="mb-2 text-sm text-muted">
        {withCredit
          ? 'כל השירים שמותר להשתמש בהם לפרסום עסקי. בשירים שמסומנים "צריך קרדיט" — שורת הקרדיט מתווספת אוטומטית לטקסט של הפוסט.'
          : 'רק מוזיקה בלי זכויות יוצרים (CC0 / נחלת הכלל) — מותר לכל שימוש, גם מסחרי, בלי קרדיט ובלי רישום.'}
      </p>
      <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-muted">
        <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={withCredit}
          onChange={(e) => { setWithCredit(e.target.checked); void search(q, 1, e.target.checked); }} />
        יותר בחירה: להציג גם שירים שדורשים קרדיט (הקרדיט נכנס לפוסט אוטומטית)
      </label>
      <div className="mb-3 flex flex-wrap gap-2">
        {MOODS.map((m) => <Chip key={m.q} on={q === m.q} onClick={() => { setQ(m.q); void search(m.q); }}>{m.label}</Chip>)}
      </div>
      <div className="mb-4 flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="חיפוש באנגלית: jazz, lofi, corporate…" dir="ltr"
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { setQ(text.trim()); void search(text.trim()); } }} />
        <Button variant="ghost" onClick={() => { if (text.trim()) { setQ(text.trim()); void search(text.trim()); } }} disabled={busy}>חיפוש</Button>
      </div>
      {error && <p className="mb-3 text-sm text-warn">{error}</p>}

      <div className="grid max-h-[50vh] gap-2 overflow-y-auto pe-1">
        {tracks.map((t) => (
          <div key={t.id} className={cx('flex items-center gap-3 rounded-2xl border p-2.5', playing === t.id ? 'border-primary bg-primary-soft' : 'border-line')}>
            <Button size="sm" variant="ghost" onClick={() => toggle(t)} aria-label={playing === t.id ? 'עצירה' : `השמעת ${t.title}`}>
              {playing === t.id ? '❚❚' : <Play size={16} weight="fill" aria-hidden />}
            </Button>
            <span className="min-w-0 flex-1" dir="auto">
              <strong className="block truncate text-sm">{t.title}</strong>
              <span className="block truncate text-xs text-muted">
                {t.creator} · {fmt(t.durationSec)} · {t.source} ·{' '}
                <span className={needsCredit(t.license) ? 'text-warn' : 'text-ok'}>
                  {needsCredit(t.license) ? `CC ${t.license.toUpperCase()} — צריך קרדיט` : 'חופשי לגמרי'}
                </span>
              </span>
            </span>
            <Button size="sm" variant="primary" onClick={() => choose(t)} disabled={Boolean(saving)}>
              {saving === t.id ? <Spinner /> : 'בחירה'}
            </Button>
          </div>
        ))}
        {busy && <div className="flex justify-center p-3"><Spinner /></div>}
        {!busy && !tracks.length && !error && <p className="p-3 text-sm text-muted">אין תוצאות. נסו מילה אחרת.</p>}
        {!busy && more && <Button variant="ghost" onClick={() => search(q, page + 1)}>עוד שירים</Button>}
        {!busy && !withCredit && tracks.length > 0 && tracks.length < 6 && (
          <p className="p-2 text-xs text-muted">מעט תוצאות בלי זכויות יוצרים למילה הזו — נסו אווירה אחרת, או סמנו "יותר בחירה" למעלה.</p>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        הרישיון של כל שיר מגיע מהמקור. לפני קמפיין ממומן גדול כדאי לפתוח את דף השיר ולוודא.
      </p>
    </Modal>
  );
}
