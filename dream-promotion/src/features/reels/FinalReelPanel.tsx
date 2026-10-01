'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { AIService } from '@/lib/services';
import { TranscribeService } from '@/lib/services/transcribe.service';
import { Button, Card, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { AdapterNote, CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { MediaPicker } from '@/features/media/MediaPicker';
import { PlatformPreview } from '@/features/preview/PlatformPreview';
import { ScheduleFields } from '@/features/calendar/ScheduleFields';
import { today } from '@/lib/utils';
import type { CaptionCue, CaptionStyle, ReelProject } from '@/types';
import { PRESETS, audioDuration, cueFrames, linesFromWords, loadCaptionFont, presetStyle, sceneCues, styleOf } from './captionImages';
import { CaptionEditor, type EditorScene } from './CaptionEditor';
import { TikTokSend } from '@/features/social/TikTokSend';
import { MetaSend } from '@/features/social/MetaSend';
import { MusicLibrary } from './MusicLibrary';
import { SocialService, type BestTimes, type PostFormat, type ScheduleView, type SocialAccount } from '@/lib/services/social.service';
import { cx } from '@/lib/utils';

export interface RenderScenePayload {
  url: string; kind: 'video' | 'image'; seconds?: number; narrationUrl?: string;
  cues?: { start: number; end: number; text: string }[];
  text?: string;
  durationSec?: number;
  /** the scene's label in the studio ("הוק", "קליפ 2") */
  label?: string;
  /** false: the clip's own sound is dropped (AI clips); true/undefined: kept when "original sound" is on */
  keepAudio?: boolean;
  /** the scene's on-screen line — the caption when the reel has no narration */
  onScreen?: string;
  /** stills: camera move made by the renderer */
  motion?: 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'none';
}

const STAGE_HE = {
  captions: 'מכין את הכתוביות…', download: 'אוסף את הקליפים והקריינות…', render: 'מרכיב את הריל…', upload: 'שומר בספריית המדיה…',
} as const;

/** A request body is capped at 4.5 MB on Vercel — caption images beyond that go through storage. */
async function parkInStorage(token: string, json: string): Promise<string> {
  const res = await fetch('/api/media', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'sign', ext: 'json' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || 'sign_failed');
  const up = await supabase().storage.from('assets').uploadToSignedUrl(j.path, j.token, new Blob([json], { type: 'application/json' }), { contentType: 'application/json' });
  if (up.error) throw new Error(up.error.message);
  return j.path as string;
}

/**
 * The last step of the reel studio: background music, the clips' own sound, captions (style +
 * editor), and one button that turns the scenes into a single finished 9:16 MP4 — stored, in the
 * media library, and linked to this reel. Then the post text and hashtags, and publishing.
 */
export function FinalReelPanel({
  projectId, title, brief, payload, ready, missingNarration, music, setMusic, captions, setCaptions,
  sceneCaptions, setSceneCaption, originalAudio, setOriginalAudio, social, setSocial, final, onRendered, section = 'all', textOnly = false,
}: {
  projectId: string | null; title: string; brief: string;
  payload: RenderScenePayload[]; ready: boolean; missingNarration: number;
  music: ReelProject['music']; setMusic: (m: ReelProject['music']) => void;
  captions: ReelProject['captions']; setCaptions: (c: ReelProject['captions']) => void;
  sceneCaptions: (CaptionCue[] | null)[]; setSceneCaption: (i: number, lines: CaptionCue[] | null) => void;
  originalAudio: boolean; setOriginalAudio: (v: boolean) => void;
  social: { caption: string; hashtags: string[] }; setSocial: (s: { caption: string; hashtags: string[] }) => void;
  final: ReelProject['final']; onRendered: (f: NonNullable<ReelProject['final']>) => void;
  /** wizard step: "render" = music, captions, make the file · "publish" = post text, publish, schedule */
  section?: 'render' | 'publish' | 'all';
  /** no narration: captions come from each scene's on-screen text, music plays louder */
  textOnly?: boolean;
}) {
  const router = useRouter();
  const { media, addMedia, duplicateContent, updateContent, content, openEditor, brand } = useApp();
  const [picking, setPicking] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<{ stage: keyof typeof STAGE_HE; pct?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [captionNote, setCaptionNote] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [when, setWhen] = useState({ date: today(), time: '19:30' });
  const [scheduledMsg, setScheduledMsg] = useState<string | null>(null);
  const [tiktokOpen, setTiktokOpen] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);
  const [socialError, setSocialError] = useState<string | null>(null);
  const [newTag, setNewTag] = useState('');
  const autoSocial = useRef(false);

  const style = styleOf(captions);
  const setStyle = (s: CaptionStyle) => setCaptions({ ...captions, style: s });

  /** The caption lines of every scene, as they will be burned: edited, else from the narration. */
  const scenesForEditor: EditorScene[] = useMemo(() => payload.map((p, i) => {
    const edited = sceneCaptions[i];
    const fromNarration = p.narrationUrl ? sceneCues(p.cues, p.text, p.durationSec) : [];
    return {
      index: i, label: p.label || `סצנה ${i + 1}`, clipUrl: p.url, kind: p.kind, narrationUrl: p.narrationUrl,
      lines: edited ?? fromNarration,
      source: edited ? 'edited' : fromNarration.length ? 'narration' : 'none',
    } as EditorScene;
  }), [payload, sceneCaptions]);

  const spokenText = scenesForEditor.flatMap((s) => s.lines.map((c) => c.text)).join(' ').slice(0, 3000);

  // ---------------------------------------------------------------- scheduled publishing --
  const [schedAccounts, setSchedAccounts] = useState<SocialAccount[] | null>(null);
  const [schedPick, setSchedPick] = useState<Record<string, boolean>>({});
  const [schedIgTarget, setSchedIgTarget] = useState<'feed' | 'story'>('feed');
  const [schedule, setSchedule] = useState<ScheduleView | null>(null);
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedError, setSchedError] = useState<string | null>(null);
  const [best, setBest] = useState<BestTimes | null>(null);

  async function loadSchedule() {
    if (!projectId || !isCloudConfigured) return;
    try { setSchedule((await SocialService.getSchedule(projectId)).schedule); } catch { /* no table yet */ }
  }
  useEffect(() => { void loadSchedule(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);
  // while it is waiting or publishing, the status refreshes on its own
  useEffect(() => {
    if (!schedule || !['scheduled', 'publishing'].includes(schedule.status)) return;
    const t = setInterval(() => void loadSchedule(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule?.status]);

  function openSchedule() {
    const item = content.find((c) => c.id === projectId);
    setWhen({ date: item?.date || today(), time: item?.time || '19:30' });
    setSchedError(null);
    setScheduling(true);
    if (!best) SocialService.bestTimes().then(setBest).catch(() => {});
    SocialService.accounts().then((r) => {
      const usable = r.accounts.filter((a) => !a.readOnly);
      setSchedAccounts(usable);
      // already scheduled → keep its choice; otherwise every connected destination
      const prev = schedule && schedule.status === 'scheduled' ? new Set(schedule.destinations.map((d) => d.accountId)) : null;
      setSchedPick(Object.fromEntries(usable.map((a) => [a.id, prev ? prev.has(a.id) : a.provider !== 'tiktok'])));
    }).catch(() => setSchedAccounts([]));
  }
  function saveDraft() {
    if (!projectId || !final) return;
    updateContent(projectId, { status: 'draft', date: null, time: null, mediaId: final.mediaId });
    setScheduledMsg('נשמר בטיוטות. נמצא במסך "תוכן" תחת "טיוטות", ואפשר לתזמן אותו מכאן או משם בכל רגע.');
  }
  async function saveSchedule() {
    if (!projectId || !final) return;
    const chosen = (schedAccounts ?? []).filter((a) => schedPick[a.id]);
    setSchedBusy(true); setSchedError(null);
    try {
      if (chosen.length) {
        // the browser's local time (Israel) → an exact moment for the server timer
        const runAt = new Date(`${when.date}T${when.time}:00`).toISOString();
        await SocialService.schedule({
          contentId: projectId, mediaId: final.mediaId, caption: postText, runAt,
          destinations: chosen.map((a) => ({ accountId: a.id, ...(a.provider === 'instagram' ? { target: schedIgTarget } : {}) })),
        });
      }
      updateContent(projectId, { date: when.date, time: when.time, status: 'scheduled', mediaId: final.mediaId });
      setScheduling(false);
      setScheduledMsg(chosen.length
        ? `יתפרסם אוטומטית ב-${when.date.split('-').reverse().join('.')} בשעה ${when.time} — ${chosen.length} יעדים.`
        : `נשמר ביומן ל-${when.date.split('-').reverse().join('.')} בשעה ${when.time} (בלי פרסום אוטומטי).`);
      await loadSchedule();
    } catch (e: any) {
      setSchedError(e.message || 'התזמון נכשל');
    } finally { setSchedBusy(false); }
  }
  /**
   * The next good moments for the chosen destinations: the account's own best hours first
   * (from its posts' likes and comments), then the research defaults. Upcoming only.
   */
  const suggestions = useMemo(() => {
    if (!best || !schedAccounts) return [] as { at: Date; label: string; why: string; mine: boolean; format: PostFormat }[];
    const chosen = schedAccounts.filter((a) => schedPick[a.id]);
    const formats = new Set<PostFormat>();
    for (const a of chosen) formats.add(a.provider === 'tiktok' ? 'tiktok' : a.provider === 'facebook' ? 'facebook' : schedIgTarget === 'story' ? 'story' : 'reel');
    if (!formats.size) formats.add('reel');
    const now = Date.now() + 15 * 60_000;
    const next = (days: number[] | null, hh: number, mm: number) => {
      for (let k = 0; k < 8; k++) {
        const d = new Date(now + k * 864e5);
        d.setHours(hh, mm, 0, 0);
        if (+d > now && (!days || days.includes(d.getDay()))) return d;
      }
      return null;
    };
    const out: { at: Date; label: string; why: string; mine: boolean; format: PostFormat }[] = [];
    for (const f of formats) {
      // the account's own data (Instagram reels / posts)
      if (f === 'reel' || f === 'feed') {
        for (const a of chosen.filter((x) => x.provider === 'instagram')) {
          const p = best.personal[a.id];
          const slots = (f === 'reel' ? p?.reel : p?.feed) ?? [];
          for (const sl of slots.slice(0, 2)) {
            const at = next(sl.bestDays.length >= 2 ? sl.bestDays : null, sl.hour, 0);
            if (at) out.push({ at, mine: true, format: f, label: '', why: `בנתונים שלך: ${sl.posts} פוסטים בשעות האלה קיבלו פי ${sl.score.toFixed(1)} מהרגיל` });
          }
        }
      }
      for (const sl of best.research[f] ?? []) {
        const [hh, mm] = sl.time.split(':').map(Number);
        const at = next(sl.days, hh, mm);
        if (at) out.push({ at, mine: false, format: f, label: '', why: sl.why });
      }
    }
    const seen = new Set<string>();
    const DAY = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    const todayKey = new Date().toDateString(), tomorrowKey = new Date(Date.now() + 864e5).toDateString();
    return out
      .sort((a, b) => Number(b.mine) - Number(a.mine) || +a.at - +b.at)
      .filter((s) => { const k = `${+s.at}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 5)
      .map((s) => {
        const hm = s.at.toTimeString().slice(0, 5);
        const day = s.at.toDateString() === todayKey ? 'היום' : s.at.toDateString() === tomorrowKey ? 'מחר' : `יום ${DAY[s.at.getDay()]}`;
        return { ...s, label: `${day} ${hm}` };
      });
  }, [best, schedAccounts, schedPick, schedIgTarget]);
  const FORMAT_HE: Record<PostFormat, string> = { reel: 'רילס', feed: 'פוסט', story: 'סטורי', tiktok: 'TikTok', facebook: 'פייסבוק' };
  const pad = (n: number) => String(n).padStart(2, '0');

  async function cancelSchedule() {
    if (!schedule) return;
    try { await SocialService.cancelSchedule(schedule.id); await loadSchedule(); setScheduledMsg('הפרסום האוטומטי בוטל. הריל נשאר ביומן.'); }
    catch (e: any) { setScheduledMsg(e.message); }
  }

  // ---------------------------------------------------------------- post text + hashtags --
  /** auto: only fills what is missing — a post text the user wrote stays */
  async function makeSocial(auto = false) {
    setSocialBusy(true); setSocialError(null);
    try {
      const r = await AIService.social(brand, { title, brief, spoken: spokenText });
      const tags = Array.from(new Set((r.hashtags ?? []).map((h) => `#${String(h).replace(/^#+/, '').replace(/\s+/g, '')}`).filter((h) => h.length > 1))).slice(0, 25);
      const written = social.caption.trim();
      const keep = auto && written && written !== brief.trim();
      setSocial({ caption: keep ? written : String(r.caption ?? '').trim(), hashtags: tags });
    } catch (e: any) {
      setSocialError(e.code === 'no_api_key' ? 'ה-AI לא מוגדר (חסר ANTHROPIC_API_KEY).' : 'יצירת הטקסט נכשלה. נסו שוב.');
    } finally { setSocialBusy(false); }
  }
  // a finished reel without hashtags gets post text + hashtags written for it, once
  useEffect(() => {
    if (!final || autoSocial.current || social.hashtags.length) return;
    autoSocial.current = true;
    void makeSocial(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [final]);
  function addTag() {
    const t = newTag.trim().replace(/^#+/, '').replace(/\s+/g, '_');
    if (!t) return;
    const tag = `#${t}`;
    if (!social.hashtags.includes(tag)) setSocial({ ...social, hashtags: [...social.hashtags, tag] });
    setNewTag('');
  }
  // a CC BY track must be credited — the line rides along in every post
  const musicCredit = music?.attribution && music.license && !['cc0', 'pdm'].includes(music.license) ? `🎵 ${music.attribution}` : '';
  const postText = [social.caption.trim() || title, musicCredit, social.hashtags.join(' ')].filter(Boolean).join('\n\n');

  // ---------------------------------------------------------------- render --
  async function render() {
    setBusy(true); setError(null); setCaptionNote(null); setStage({ stage: 'captions' });
    try {
      if (!isCloudConfigured) throw new Error('יצירת הריל הסופי דורשת חשבון מחובר.');
      const { data } = await supabase().auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('צריך להתחבר מחדש.');

      let transcribed = 0;
      const scenes: any[] = [];
      if (captions.enabled) {
        await loadCaptionFont(style.font);
        await document.fonts.ready;
      }
      const canvas = document.createElement('canvas');
      for (let i = 0; i < payload.length; i++) {
        const p = payload[i];
        let lines: CaptionCue[] = [];
        if (captions.enabled) {
          lines = sceneCaptions[i] ?? [];
          if (!sceneCaptions[i] && textOnly && p.onScreen?.trim()) {
            // no narration: the scene's on-screen line stays up for the whole scene
            lines = [{ start: 0.15, end: Math.max(1, (p.seconds || 5) - 0.1), text: p.onScreen.trim() }];
          } else if (!sceneCaptions[i] && p.narrationUrl) {
            const dur = p.durationSec || (p.cues?.length ? 0 : await audioDuration(p.narrationUrl));
            lines = sceneCues(p.cues, p.text, dur);
          }
          // a video with someone talking and no narration: captions from its own sound, automatically
          if (!lines.length && !p.narrationUrl && p.kind === 'video' && p.url.startsWith('https://') && originalAudio) {
            try {
              const r = await TranscribeService.file(p.url, [brand.name, brand.industry, brand.city].filter(Boolean).join(', '));
              if (r.words.length) {
                lines = linesFromWords(r.words, style.maxWords);
                setSceneCaption(i, lines); // kept with the project — editable later, never transcribed twice
                transcribed++;
              }
            } catch { /* no captions for this scene; the reel still renders */ }
          }
        }
        const cues = lines.flatMap((c) => cueFrames(c, style, canvas));
        scenes.push({
          url: p.url, kind: p.kind, seconds: p.seconds, narrationUrl: p.narrationUrl, motion: p.motion,
          text: undefined, keepAudio: originalAudio && p.keepAudio !== false, cues,
        });
        setStage({ stage: 'captions', pct: Math.round(((i + 1) / payload.length) * 100) });
      }

      const body: Record<string, unknown> = {
        contentId: projectId, replaceMediaId: final?.mediaId ?? null, title,
        music: music ? { url: music.url, volume: music.volume } : null, captions, originalAudio,
      };
      const scenesJson = JSON.stringify(scenes);
      if (scenesJson.length > 3_000_000) body.scenesPath = await parkInStorage(token, scenesJson);
      else body.scenes = scenes;

      setStage({ stage: 'download', pct: 0 });
      const res = await fetch('/api/reel/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `השרת החזיר ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', result: any = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const l of lines) {
          if (!l.trim()) continue;
          const m = JSON.parse(l);
          if (m.error) throw new Error(m.error);
          if (m.done) result = m; else if (m.stage) setStage({ stage: m.stage, pct: m.pct });
        }
      }
      if (!result) throw new Error('הרינדור הסתיים בלי קובץ.');
      if (captions.enabled) {
        setCaptionNote(result.captionLines > 0
          ? `נצרבו ${result.captionLines} שורות כתוביות${transcribed ? ` (${transcribed} סצנות תומללו אוטומטית מהקול בסרטון)` : ''}.`
          : 'לא נצרבו כתוביות: אין קריינות ולא נשמע דיבור בסרטונים. אפשר להוסיף שורות ב"עריכת כתוביות".');
      }
      if (final?.mediaId && final.mediaId !== result.mediaId) {
        useApp.setState((st) => ({ media: st.media.filter((m) => m.id !== final.mediaId) }));
      }
      addMedia({ id: result.mediaId, url: result.url, name: `${title} · ריל סופי`, kind: 'video', persistent: true });
      onRendered({ mediaId: result.mediaId, url: result.url, durationSec: result.durationSec, renderedAt: Date.now() });
    } catch (e: any) {
      setError(e?.message ?? 'הרינדור נכשל.');
    } finally { setBusy(false); setStage(null); }
  }

  function duplicate() {
    if (!projectId) return;
    const before = new Set(content.map((c) => c.id));
    duplicateContent(projectId);
    const copy = useApp.getState().content.find((c) => !before.has(c.id));
    if (copy) router.push(`/reels?id=${copy.id}`);
  }

  const musicName = music ? (media.find((m) => m.id === music.mediaId)?.name ?? music.name) : null;
  const totalLines = scenesForEditor.reduce((a, s) => a + s.lines.length, 0);
  const talkingScenes = payload.filter((p) => p.kind === 'video' && !p.narrationUrl).length;
  const barPct = !stage ? 0 : stage.stage === 'captions' ? (stage.pct ?? 0) * 0.1
    : stage.stage === 'download' ? 10 + (stage.pct ?? 0) * 0.1 : stage.stage === 'render' ? 20 + (stage.pct ?? 0) * 0.77 : 98;

  return (
    <Card className="mt-4">
      <h3 className="font-display text-xl font-bold">{section === 'publish' ? 'פרסום' : 'הריל הסופי'}</h3>
      <p className="mt-1 text-sm text-muted">
        {section === 'publish' ? 'הטקסט וההאשטגים, ואז פרסום עכשיו או בזמן מתוזמן.' : 'כל הסצנות, הקריינות, הכתוביות והמוזיקה — בקובץ MP4 אנכי אחד.'}
      </p>
      {section === 'publish' && !final && (
        <p className="mt-4 rounded-2xl bg-surface-2 p-3 text-sm">עוד אין ריל סופי. חזרו לשלב "ריל סופי" ולחצו "יצירת הריל הסופי".</p>
      )}

      {section !== 'publish' && (<>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="מוזיקת רקע">
          {music ? (
            <div className="rounded-2xl bg-surface-2 p-3">
              <p className="truncate text-sm font-semibold">♪ {musicName}</p>
              <audio src={music.url} controls className="mt-2 h-9 w-full" />
              <label className="mt-3 block text-sm">
                עוצמת המוזיקה: <strong>{Math.round(music.volume * 100)}%</strong>
                <input type="range" min={0} max={100} value={Math.round(music.volume * 100)}
                  onChange={(e) => setMusic({ ...music, volume: +e.target.value / 100 })}
                  className="mt-1 w-full accent-[var(--primary)]" />
              </label>
              <p className="mt-1 text-xs text-muted">{textOnly ? 'בלי קריינות — המוזיקה היא הקול של הסרטון.' : 'המוזיקה יורדת אוטומטית כשמדברים.'}</p>
              {musicCredit && <p className="mt-1 text-xs text-warn">השיר דורש קרדיט — נוסף אוטומטית לטקסט הפוסט.</p>}
              <div className="mt-2 flex gap-3 text-sm">
                <button type="button" className="font-semibold text-primary" onClick={() => setLibraryOpen(true)}>שיר אחר מהספרייה</button>
                <button type="button" className="font-semibold text-primary" onClick={() => setPicking(true)}>קובץ שלכם</button>
                <button type="button" className="text-muted" onClick={() => setMusic(null)}>בלי מוזיקה</button>
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              <Button variant="primary" className="w-full" onClick={() => setLibraryOpen(true)}>🎵 מוזיקה חינם מהספרייה</Button>
              <Button variant="ghost" className="w-full" onClick={() => setPicking(true)}>+ קובץ MP3 שלכם</Button>
            </div>
          )}
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[var(--primary)]" checked={originalAudio} onChange={(e) => setOriginalAudio(e.target.checked)} />
            <span><strong>הקול המקורי של הסרטונים</strong><span className="block text-xs text-muted">דיבור מסטורי או מסרטון שצילמתם נשמר. מתחת לקריינות הוא נשמע בשקט.</span></span>
          </label>
        </Field>

        <Field label="כתוביות">
          <label className="mb-2 flex w-full cursor-pointer items-center gap-2 text-sm font-semibold">
            <input type="checkbox" className="h-5 w-5 accent-[var(--primary)]" checked={captions.enabled}
              onChange={(e) => setCaptions({ ...captions, enabled: e.target.checked })} />
            הוספת כתוביות לריל
          </label>
          {captions.enabled && (
            <>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <Chip key={p.id} on={style.preset === p.id} onClick={() => setStyle(presetStyle(p.id, style.y))}>{p.label}</Chip>
                ))}
              </div>
              <Button size="sm" variant="primary" className="mt-3" onClick={() => setEditorOpen(true)} disabled={!payload.length}>
                עריכת כתוביות · גופן, צבע, טקסט
              </Button>
              <p className="mt-2 text-xs text-muted">
                {totalLines ? `${totalLines} שורות מוכנות. ` : ''}
                {talkingScenes > 0 && originalAudio ? 'סרטונים בלי קריינות יתומללו אוטומטית מהדיבור שבהם. ' : ''}
                הכתוביות מציגות את הטקסט כפי שנכתב, גם כשהקריין הוגה אותו אחרת.
              </p>
            </>
          )}
        </Field>
      </div>

      {!ready && <p className="mt-4 text-sm text-warn">כדי ליצור את הריל הסופי, כל הסצנות צריכות קליפ או תמונה מוכנים.</p>}
      {ready && missingNarration > 0 && !originalAudio && (
        <p className="mt-4 text-sm text-muted">ל-{missingNarration} סצנות אין קריינות — הן יופיעו בלי קול.</p>
      )}

      <div className="mt-4 border-t border-line pt-4">
        <Button variant="primary" size="lg" onClick={render} disabled={!ready || busy}>
          {busy ? <><Spinner />מרנדר…</> : final ? 'יצירת הריל הסופי מחדש' : 'יצירת הריל הסופי'}
        </Button>
        {stage && (
          <div className="mt-3">
            <p className="text-sm">{STAGE_HE[stage.stage]} {stage.pct !== undefined && <strong>{stage.pct}%</strong>}</p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${barPct}%` }} />
            </div>
          </div>
        )}
        {error && <div className="mt-3"><AdapterNote title="הרינדור נכשל.">{error}</AdapterNote></div>}
      </div>
      </>)}

      {final && (
        <div className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-[220px_1fr]">
          <video key={final.url} src={`${final.url}#t=0.1`} preload="metadata" controls playsInline className="aspect-[9/16] w-full rounded-xl bg-black object-cover" />
          <div className="min-w-0">
            <p className="font-semibold">הריל מוכן · {Math.round(final.durationSec)} שנ׳</p>
            <p className="mt-1 text-sm text-muted">נשמר בספריית המדיה ומשויך לפרויקט הזה.</p>
            {captionNote && <p className="mt-1 text-sm">{captionNote}</p>}
            {scheduledMsg && <p className="mt-1 text-sm text-ok">{scheduledMsg}</p>}
            {section !== 'render' && schedule && (
              <div className="mt-3 rounded-2xl border border-line p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>
                    {schedule.status === 'scheduled' ? '⏰ מתוזמן לפרסום' : schedule.status === 'publishing' ? '⏳ מתפרסם…'
                      : schedule.status === 'done' ? '✓ פורסם' : schedule.status === 'partial' ? '⚠ פורסם חלקית' : '✗ הפרסום נכשל'}
                    {' · '}{new Date(schedule.runAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
                  </strong>
                  {schedule.status === 'scheduled' && <button type="button" className="text-xs text-[var(--danger)] hover:underline" onClick={cancelSchedule}>ביטול הפרסום האוטומטי</button>}
                </div>
                <ul className="mt-2 grid gap-1">
                  {schedule.destinations.map((d) => (
                    <li key={d.accountId} className="text-xs">
                      <span className={cx('font-semibold', d.result.state === 'failed' ? 'text-[var(--danger)]' : d.result.state === 'published' || d.result.state === 'sent_to_drafts' ? 'text-ok' : 'text-muted')}>
                        {d.result.state === 'published' ? '✓ פורסם' : d.result.state === 'sent_to_drafts' ? '✓ נשלח לטיוטות' : d.result.state === 'processing' ? '⏳ בעיבוד' : d.result.state === 'failed' ? '✗ נכשל' : '· ממתין'}
                      </span>{' '}{d.name}{d.target === 'story' ? ' (סטורי)' : ''}
                      {d.result.error && <span className="block text-[var(--danger)]" dir="auto">{d.result.error}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ---- post text + hashtags ---- */}
            {section !== 'render' && (<div className="mt-4 rounded-2xl bg-surface-2 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm">טקסט לפוסט והאשטגים</strong>
                <Button size="sm" variant="ghost" onClick={() => makeSocial()} disabled={socialBusy}>
                  {socialBusy ? <><Spinner />כותב…</> : social.caption || social.hashtags.length ? '✨ כתיבה מחדש' : '✨ יצירה עם AI'}
                </Button>
              </div>
              <Textarea value={social.caption} onChange={(e) => setSocial({ ...social, caption: e.target.value })}
                placeholder="הטקסט שיופיע מתחת לסרטון" className="min-h-[90px] bg-surface" />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {social.hashtags.map((h) => (
                  <button key={h} type="button" title="הסרה" onClick={() => setSocial({ ...social, hashtags: social.hashtags.filter((x) => x !== h) })}
                    className="rounded-full bg-surface px-2.5 py-1 text-xs font-semibold text-primary hover:line-through" dir="auto">{h} ×</button>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <Input value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                  placeholder="#האשטג_נוסף" className="h-9 bg-surface py-1 text-sm" />
                <Button size="sm" variant="ghost" onClick={addTag}>הוספה</Button>
                {social.hashtags.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(postText)}>העתקה</Button>
                )}
              </div>
              {socialError && <p className="mt-2 text-xs text-warn">{socialError}</p>}
              <p className="mt-2 text-xs text-muted">{social.hashtags.length} האשטגים · נשלחים אוטומטית עם הפרסום.</p>
            </div>)}

            {section === 'render' && (
              <p className="mt-3 text-sm">הריל מוכן. אפשר לצפות בו כאן, ולהמשיך לשלב <strong>פרסום</strong>.</p>
            )}
            {section !== 'render' && (<div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => setMetaOpen(true)}>פרסום באינסטגרם ובפייסבוק</Button>
              <Button size="sm" variant="ghost" onClick={() => setTiktokOpen(true)}>שליחה ל-TikTok</Button>
              <Button size="sm" variant="ghost" onClick={() => setPreviewing(true)}>תצוגה לפי פלטפורמה</Button>
              <a href={final.url} download={`${title}.mp4`} target="_blank" rel="noreferrer"
                className="inline-flex h-9 items-center rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2">הורדה</a>
              {section === 'all' && <Button size="sm" variant="ghost" onClick={() => document.getElementById('reel-scenes')?.scrollIntoView({ behavior: 'smooth' })}>עריכה</Button>}
              <Button size="sm" variant="ghost" onClick={duplicate} disabled={!projectId}>שכפול</Button>
              <Button size="sm" variant="ghost" onClick={saveDraft} disabled={!projectId}>שמירה בטיוטות</Button>
              <Button size="sm" variant="ghost" onClick={() => projectId && openEditor(projectId)} disabled={!projectId}>כל האפשרויות</Button>
              <Button size="sm" variant={section === 'publish' ? 'primary' : 'ghost'} onClick={openSchedule} disabled={!projectId}>תזמון פרסום</Button>
            </div>)}
          </div>
        </div>
      )}

      <CaptionEditor open={editorOpen} onClose={() => setEditorOpen(false)} scenes={scenesForEditor}
        style={style} onStyle={setStyle} onLines={setSceneCaption} brief={brief} />

      <MusicLibrary open={libraryOpen} onClose={() => setLibraryOpen(false)}
        onChoose={(m) => setMusic({ ...m, volume: textOnly ? 0.7 : music?.volume ?? 0.25 })} />
      <MediaPicker open={picking} onClose={() => setPicking(false)} accept="audio"
        onPick={(id) => {
          const m = useApp.getState().media.find((x) => x.id === id);
          if (m) setMusic({ mediaId: m.id, url: m.url, name: m.name, volume: music?.volume ?? 0.25 });
        }} selectedId={music?.mediaId} />

      <TikTokSend open={tiktokOpen} onClose={() => setTiktokOpen(false)} mediaId={final?.mediaId ?? null} contentId={projectId} caption={postText} />
      <MetaSend open={metaOpen} onClose={() => setMetaOpen(false)} mediaId={final?.mediaId ?? null} caption={postText} />
      <Modal open={scheduling} onClose={() => setScheduling(false)}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="font-display text-xl font-extrabold">תזמון הריל</h3>
          <CloseButton onClick={() => setScheduling(false)} />
        </div>
        <ScheduleFields date={when.date} time={when.time} onChange={setWhen} />
        <div className="mt-4">
          <p className="mb-2 text-sm font-semibold">לפרסם אוטומטית ב:</p>
          {schedAccounts === null ? <Spinner /> : !schedAccounts.length ? (
            <p className="rounded-2xl bg-surface-2 p-3 text-sm">אין חשבון מחובר לפרסום — הריל יישמר ביומן בלבד. מחברים במסך החיבורים.</p>
          ) : (
            <div className="grid gap-2">
              {schedAccounts.map((a) => (
                <label key={a.id} className={cx('flex cursor-pointer items-center gap-3 rounded-2xl border px-3 py-2 text-sm', schedPick[a.id] ? 'border-primary bg-primary-soft' : 'border-line')}>
                  <input type="checkbox" className="h-5 w-5 accent-[var(--primary)]" checked={Boolean(schedPick[a.id])}
                    onChange={(e) => setSchedPick((p) => ({ ...p, [a.id]: e.target.checked }))} />
                  {a.avatar && <img src={a.avatar} alt="" className="h-7 w-7 rounded-full" />}
                  <span className="min-w-0 flex-1">
                    <span className="text-muted">{a.provider === 'instagram' ? 'Instagram' : a.provider === 'facebook' ? 'Facebook' : 'TikTok'} · </span>{a.name}
                    {a.provider === 'tiktok' && <span className="block text-xs text-muted">נשלח לטיוטות ב-TikTok בזמן שנקבע — מפרסמים משם בלחיצה.</span>}
                  </span>
                </label>
              ))}
              {schedAccounts.some((a) => a.provider === 'instagram' && schedPick[a.id]) && (
                <div className="flex gap-2">
                  <Chip on={schedIgTarget === 'feed'} onClick={() => setSchedIgTarget('feed')}>רילס באינסטגרם</Chip>
                  <Chip on={schedIgTarget === 'story'} onClick={() => setSchedIgTarget('story')}>סטורי באינסטגרם</Chip>
                </div>
              )}
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-sm font-semibold">שעות מומלצות</p>
              <div className="grid gap-2">
                {suggestions.map((s) => (
                  <button key={`${+s.at}-${s.format}`} type="button"
                    onClick={() => setWhen({ date: `${s.at.getFullYear()}-${pad(s.at.getMonth() + 1)}-${pad(s.at.getDate())}`, time: `${pad(s.at.getHours())}:${pad(s.at.getMinutes())}` })}
                    className="flex items-start gap-3 rounded-2xl border border-line px-3 py-2 text-start text-sm hover:border-primary hover:bg-primary-soft">
                    <span className="shrink-0 font-bold tabular-nums">{s.label}</span>
                    <span className="min-w-0 flex-1 text-xs text-muted">
                      <span className={cx('me-1 rounded-full px-1.5 py-0.5 font-semibold', s.mine ? 'bg-primary text-white' : 'bg-surface-2 text-ink-2')}>
                        {s.mine ? '★ מהנתונים שלך' : 'מחקר'}
                      </span>
                      {FORMAT_HE[s.format]} · {s.why}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted">
                "מחקר" = ממוצעים של מחקרי 2026, מותאמים לשעון ולשבוע בישראל. "מהנתונים שלך" = לייקים ותגובות של הפוסטים שלך לפי שעה — עדיף כשיש.
              </p>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">הפרסום קורה בשרת, גם כשהאפליקציה סגורה (בדיקה כל 5 דקות). הטקסט וההאשטגים מהריל נשלחים איתו.</p>
          {schedError && <p className="mt-2 text-sm text-warn">{schedError}</p>}
        </div>
        <div className="mt-5 flex gap-3 border-t border-line pt-4">
          <Button variant="primary" onClick={saveSchedule} disabled={schedBusy}>
            {schedBusy ? <><Spinner />שומר…</> : Object.values(schedPick).some(Boolean) && schedAccounts?.length ? 'תזמון פרסום' : 'שמירה ביומן'}
          </Button>
          <Button variant="ghost" onClick={() => setScheduling(false)}>ביטול</Button>
        </div>
      </Modal>

      <Modal open={previewing} onClose={() => setPreviewing(false)} wide>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="font-display text-xl font-extrabold">כך הריל ייראה</h3>
          <CloseButton onClick={() => setPreviewing(false)} />
        </div>
        {final && <PlatformPreview mediaId={final.mediaId} headline="" caption={postText} initial="ig-reel" />}
      </Modal>
    </Card>
  );
}
