import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Final reel renderer: scene clips (or stills) + per-scene narration + burned-in
 * Hebrew captions + optional background music → one 720×1280 H.264 MP4.
 * Narration drives the pacing; music is looped, set to the chosen level and ducked
 * automatically under the voice.
 */

export interface RenderCue { start: number; end: number; text: string }
export interface RenderScene {
  url: string; kind: 'video' | 'image'; seconds?: number;
  narrationUrl?: string; cues?: RenderCue[];
}
export interface RenderJob {
  scenes: RenderScene[];
  music?: { url: string; volume: number } | null;   // volume 0..1
  captions: { enabled: boolean; position: 'bottom' | 'middle'; size: 'md' | 'lg' };
}
export type Progress = (p: { stage: 'download' | 'render' | 'upload'; pct?: number }) => void;

const W = 720, H = 1280, FPS = 30;
const FADE = 0.5;

export function ffmpegBin(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = process.env.FFMPEG_PATH || (require('ffmpeg-static') as string);
  if (!p) throw new Error('ffmpeg binary not found');
  return p;
}
export const fontsDir = () => process.env.REEL_FONTS_DIR || path.join(process.cwd(), 'assets', 'fonts');

function run(args: string[], onLine?: (l: string) => void): Promise<{ code: number; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.on('data', (d) => String(d).split('\n').forEach((l) => l && onLine?.(l)));
    p.stderr.on('data', (d) => { err += String(d); if (err.length > 200_000) err = err.slice(-100_000); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, err }));
  });
}

/** Media duration in seconds, read from ffmpeg's own banner (no ffprobe needed). */
export async function probeDuration(file: string): Promise<number> {
  const { err } = await run(['-hide_banner', '-i', file]);
  const m = err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

async function download(url: string, file: string) {
  if (url.startsWith('data:')) {
    const b64 = url.slice(url.indexOf(',') + 1);
    await writeFile(file, Buffer.from(b64, 'base64'));
    return;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download_failed ${res.status}: ${url.slice(0, 80)}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file));
}

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const assEscape = (t: string) => t.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, '\\N');
// Hebrew lines start with a right-to-left mark, so mixed lines ("ה-eSIM של Tasimli", "252 מדינות!")
// keep their word order and punctuation on the correct side.
const rtl = (t: string) => (/[\u0590-\u05FF]/.test(t) ? `\u200F${t}` : t);

/** ASS subtitle file — keeps the script's own wording; right-to-left handled by libass/fribidi. */
export function buildAss(cues: RenderCue[], opt: RenderJob['captions']): string {
  const size = opt.size === 'lg' ? 64 : 52;
  const align = opt.position === 'middle' ? 5 : 2;
  const marginV = opt.position === 'middle' ? 0 : 250; // clear of TikTok / Reels buttons
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Rubik,${size},&H00FFFFFF,&H00FFFFFF,&H00141028,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,${align},60,60,${marginV},-1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${rtl(assEscape(c.text))}`).join('\n')}
`;
}

export async function renderReel(job: RenderJob, dir: string, onProgress: Progress): Promise<{ file: string; durationSec: number }> {
  if (!job.scenes.length) throw new Error('no_scenes');
  await mkdir(dir, { recursive: true });

  // ---- 1. inputs ---------------------------------------------------------
  onProgress({ stage: 'download', pct: 0 });
  const files = job.scenes.map((s, i) => ({
    media: path.join(dir, `scene${i}.${s.kind === 'image' ? 'img' : 'mp4'}`),
    voice: s.narrationUrl ? path.join(dir, `voice${i}.audio`) : null,
  }));
  const musicFile = job.music?.url ? path.join(dir, 'music.audio') : null;
  let done = 0;
  const total = files.length + files.filter((f) => f.voice).length + (musicFile ? 1 : 0);
  const tick = () => onProgress({ stage: 'download', pct: Math.round((++done / total) * 100) });
  await Promise.all([
    ...job.scenes.map((s, i) => download(s.url, files[i].media).then(tick)),
    ...job.scenes.map((s, i) => (s.narrationUrl ? download(s.narrationUrl, files[i].voice!).then(tick) : null)),
    musicFile ? download(job.music!.url, musicFile).then(tick) : null,
  ]);

  // ---- 2. timing: narration sets the pace --------------------------------
  const lengths: number[] = [];
  for (let i = 0; i < job.scenes.length; i++) {
    const s = job.scenes[i];
    const clip = s.kind === 'video' ? await probeDuration(files[i].media) : (s.seconds || 4);
    const voice = files[i].voice ? await probeDuration(files[i].voice!) : 0;
    const L = voice > 0 ? Math.max(voice + 0.4, Math.min(clip || 3, 3)) : (clip || s.seconds || 4);
    lengths.push(Math.round(L * 100) / 100);
  }
  const T = lengths.reduce((a, b) => a + b, 0);
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));

  // captions on the reel timeline, in the original wording
  const cues: RenderCue[] = [];
  job.scenes.forEach((s, i) => (s.cues || []).forEach((c) => {
    const st = starts[i] + c.start, en = Math.min(starts[i] + c.end + 0.15, starts[i] + lengths[i]);
    if (en > st && c.text.trim()) cues.push({ start: st, end: en, text: c.text.trim() });
  }));
  // one caption at a time: each line ends before the next begins, never stacked
  cues.sort((x, y) => x.start - y.start);
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start - 0.02);
  const assFile = path.join(dir, 'captions.ass');
  const burn = job.captions.enabled && cues.length > 0;
  if (burn) await writeFile(assFile, buildAss(cues, job.captions), 'utf8');

  // ---- 3. one ffmpeg graph ------------------------------------------------
  const args: string[] = ['-hide_banner', '-y'];
  const f: string[] = [];
  let idx = 0;
  const sceneIn: number[] = [], voiceIn: (number | null)[] = [];
  job.scenes.forEach((s, i) => {
    if (s.kind === 'image') args.push('-loop', '1', '-t', String(lengths[i]), '-i', files[i].media);
    else args.push('-i', files[i].media);
    sceneIn.push(idx++);
  });
  files.forEach((fl) => { if (fl.voice) { args.push('-i', fl.voice); voiceIn.push(idx++); } else voiceIn.push(null); });
  let musicIn: number | null = null;
  if (musicFile) { args.push('-stream_loop', '-1', '-i', musicFile); musicIn = idx++; }

  job.scenes.forEach((_, i) => {
    const L = lengths[i];
    f.push(`[${sceneIn[i]}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,` +
      `tpad=stop_mode=clone:stop_duration=${L},trim=duration=${L},setpts=PTS-STARTPTS[v${i}]`);
    f.push(voiceIn[i] !== null
      ? `[${voiceIn[i]}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${L},asetpts=PTS-STARTPTS[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${L},aformat=sample_fmts=fltp,asetpts=PTS-STARTPTS[a${i}]`);
  });
  const n = job.scenes.length;
  f.push(`${job.scenes.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vcat]`);
  f.push(`${job.scenes.map((_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[narr]`);

  const fadeOut = Math.max(0, T - FADE);
  const subs = burn ? `ass='${assFile.replace(/'/g, "\\'")}':fontsdir='${fontsDir().replace(/'/g, "\\'")}',` : '';
  f.push(`[vcat]${subs}fade=t=in:st=0:d=${FADE},fade=t=out:st=${fadeOut}:d=${FADE}[vout]`);

  if (musicIn !== null) {
    const vol = Math.min(1, Math.max(0, job.music!.volume ?? 0.25));
    f.push(`[narr]asplit=2[narr1][narrkey]`);
    f.push(`[${musicIn}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${T},asetpts=PTS-STARTPTS,volume=${vol.toFixed(2)}[mus]`);
    // music dips automatically whenever the narrator speaks
    f.push(`[mus][narrkey]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350:makeup=1[musd]`);
    f.push(`[narr1][musd]amix=inputs=2:duration=first:normalize=0[mix]`);
  } else {
    f.push(`[narr]anull[mix]`);
  }
  f.push(`[mix]afade=t=in:st=0:d=${FADE},afade=t=out:st=${Math.max(0, T - 0.8)}:d=0.8,alimiter=limit=0.95[aout]`);

  const out = path.join(dir, 'reel.mp4');
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', T.toFixed(2),
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out);

  onProgress({ stage: 'render', pct: 0 });
  const { code, err } = await run(args, (line) => {
    const m = line.match(/^out_time_(?:ms|us)=(\d+)/);
    if (m) onProgress({ stage: 'render', pct: Math.min(99, Math.round((+m[1] / 1e6 / T) * 100)) });
  });
  if (code !== 0) throw new Error(`ffmpeg_failed: ${err.split('\n').filter(Boolean).slice(-6).join(' | ')}`);
  onProgress({ stage: 'render', pct: 100 });
  return { file: out, durationSec: T };
}
