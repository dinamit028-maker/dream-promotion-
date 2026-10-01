import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { safeFetch } from './safe-fetch';
import { pipeline } from 'node:stream/promises';

/**
 * Final reel renderer: scene clips (or stills) + per-scene narration and/or the clip's own
 * sound + burned-in Hebrew captions + optional background music → one 720×1280 H.264 MP4.
 * Narration drives the pacing; music is looped, set to the chosen level and ducked
 * automatically under the voice.
 *
 * Captions arrive as full-frame transparent PNGs (720×1280) already drawn by the browser —
 * font, style, position and the highlighted word are all baked in. The server joins them
 * into ONE transparent caption track and lays it over the video in a single overlay.
 */

export type Motion = 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'none';
export const MOTIONS: Motion[] = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'none'];

/**
 * The zoompan expressions for one camera move over `frames` frames. The still is first scaled
 * to twice the output size, so the slow move stays smooth (no 1-pixel jitter).
 */
function kenBurns(m: Motion, frames: number): string {
  const D = Math.max(1, frames - 1);
  const center = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  switch (m) {
    case 'zoom_in':   return `z='1+0.14*on/${D}':${center}`;
    case 'zoom_out':  return `z='1.14-0.14*on/${D}':${center}`;
    case 'pan_left':  return `z='1.12':x='(iw-iw/zoom)*(1-on/${D})':y='ih/2-(ih/zoom/2)'`;
    case 'pan_right': return `z='1.12':x='(iw-iw/zoom)*on/${D}':y='ih/2-(ih/zoom/2)'`;
    default:          return `z='1':x='0':y='0'`;
  }
}

/** png: one caption frame drawn by the browser (transparent PNG 720×1280, data URL). */
export interface RenderCue { start: number; end: number; text: string; png?: string }
export interface RenderScene {
  url: string; kind: 'video' | 'image'; seconds?: number;
  /** stills only: camera move made by ffmpeg (Ken Burns) — motion without paying for AI video */
  motion?: Motion;
  narrationUrl?: string; cues?: RenderCue[];
  text?: string; // the original narration text — used for captions if no timing came back
  /** keep the clip's own sound (a story, someone talking). Quieter under narration. */
  keepAudio?: boolean;
}
export interface RenderJob {
  scenes: RenderScene[];
  music?: { url: string; volume: number } | null;   // volume 0..1
  captions: { enabled: boolean; position: 'bottom' | 'middle'; size: 'md' | 'lg' };
}
export type Progress = (p: { stage: 'download' | 'render' | 'upload'; pct?: number }) => void;

const W = 720, H = 1280, FPS = 30;
const FADE = 0.5;
/** A fully transparent full-frame PNG — the gap between caption lines (same size as every caption frame). */
function blankPng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h); // every row: filter byte 0 + transparent pixels
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function ffmpegBin(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = process.env.FFMPEG_PATH || (require('ffmpeg-static') as string);
  if (!p) throw new Error('ffmpeg binary not found');
  return p;
}
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

/** Media duration in seconds and whether it has a sound track, read from ffmpeg's own banner. */
export async function probe(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  const { err } = await run(['-hide_banner', '-i', file]);
  const m = err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  return { duration: m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0, hasAudio: /Stream #\d+:\d+.*Audio:/.test(err) };
}
export async function probeDuration(file: string): Promise<number> {
  return (await probe(file)).duration;
}

async function download(url: string, file: string) {
  if (url.startsWith('data:')) {
    const b64 = url.slice(url.indexOf(',') + 1);
    await writeFile(file, Buffer.from(b64, 'base64'));
    return;
  }
  const res = await safeFetch(url, { maxBytes: 400 * 1024 * 1024 });
  if (!res.ok || !res.body) throw new Error(`download_failed ${res.status}: ${url.slice(0, 80)}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file));
}

export async function renderReel(job: RenderJob, dir: string, onProgress: Progress): Promise<{ file: string; durationSec: number; captionLines: number }> {
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
  const voiceLen: number[] = [];
  const clipAudio: boolean[] = [];
  for (let i = 0; i < job.scenes.length; i++) {
    const s = job.scenes[i];
    const info = s.kind === 'video' ? await probe(files[i].media) : { duration: s.seconds || 4, hasAudio: false };
    const clip = info.duration;
    clipAudio.push(Boolean(s.keepAudio && info.hasAudio));
    const voice = files[i].voice ? await probeDuration(files[i].voice!) : 0;
    voiceLen.push(voice);
    const L = voice > 0 ? Math.max(voice + 0.4, Math.min(clip || 3, 3)) : (clip || s.seconds || 4);
    lengths.push(Math.round(L * 100) / 100);
  }
  const T = lengths.reduce((a, b) => a + b, 0);
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));

  // captions on the reel timeline, in the original wording
  const cues: RenderCue[] = [];
  // no word timing for a narrated scene: spread its original text evenly over the voice
  job.scenes.forEach((s, i) => {
    if ((s.cues && s.cues.length) || !s.text?.trim() || !voiceLen[i]) return;
    const words = s.text.trim().split(/\s+/);
    const groups: string[] = [];
    for (let k = 0; k < words.length; k += 5) groups.push(words.slice(k, k + 5).join(' '));
    const per = voiceLen[i] / groups.length;
    s.cues = groups.map((t, k) => ({ start: k * per, end: (k + 1) * per, text: t }));
  });
  job.scenes.forEach((s, i) => (s.cues || []).forEach((c) => {
    const st = starts[i] + c.start, en = Math.min(starts[i] + c.end + 0.15, starts[i] + lengths[i]);
    if (en > st && c.text.trim()) cues.push({ start: st, end: en, text: c.text.trim(), png: c.png });
  }));
  // one caption at a time: each line ends before the next begins, never stacked
  cues.sort((x, y) => x.start - y.start);
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
  // captions arrive already drawn by the browser (real Hebrew shaping, the chosen font and style),
  // as full-frame transparent images; they become one caption track with blank gaps between lines
  const capCues = job.captions.enabled ? cues.filter((c) => c.png?.startsWith('data:image/png') && c.end - c.start >= 0.03) : [];
  let capTrack: string | null = null;
  if (capCues.length) {
    const blank = path.join(dir, 'blank.png');
    await writeFile(blank, blankPng(W, H));
    const lines = ['ffconcat version 1.0'];
    let t = 0;
    for (const [k, c] of capCues.entries()) {
      const f = path.join(dir, `cap${k}.png`);
      await writeFile(f, Buffer.from(c.png!.slice(c.png!.indexOf(',') + 1), 'base64'));
      // tiny gaps between karaoke frames are absorbed, so the text never flickers
      if (c.start - t > 0.05) { lines.push(`file '${blank}'`, `duration ${(c.start - t).toFixed(3)}`); t = c.start; }
      if (c.end - t <= 0.01) continue;
      lines.push(`file '${f}'`, `duration ${(c.end - t).toFixed(3)}`);
      t = c.end;
    }
    if (T - t > 0.01) lines.push(`file '${blank}'`, `duration ${(T - t).toFixed(3)}`);
    lines.push(`file '${blank}'`); // the concat reader needs the last entry repeated to honour its duration
    capTrack = path.join(dir, 'captions.ffconcat');
    await writeFile(capTrack, lines.join('\n'));
  }

  // ---- 3. one ffmpeg graph ------------------------------------------------
  const args: string[] = ['-hide_banner', '-y'];
  const f: string[] = [];
  let idx = 0;
  const sceneIn: number[] = [], voiceIn: (number | null)[] = [];
  job.scenes.forEach((s, i) => {
    if (s.kind === 'image' && s.motion && s.motion !== 'none') args.push('-i', files[i].media); // one frame; zoompan makes the rest
    else if (s.kind === 'image') args.push('-loop', '1', '-t', String(lengths[i]), '-i', files[i].media);
    else args.push('-i', files[i].media);
    sceneIn.push(idx++);
  });
  files.forEach((fl) => { if (fl.voice) { args.push('-i', fl.voice); voiceIn.push(idx++); } else voiceIn.push(null); });
  let capIn: number | null = null;
  if (capTrack) { args.push('-f', 'concat', '-safe', '0', '-i', capTrack); capIn = idx++; }
  let musicIn: number | null = null;
  if (musicFile) { args.push('-stream_loop', '-1', '-i', musicFile); musicIn = idx++; }

  job.scenes.forEach((_, i) => {
    const L = lengths[i];
    const sc = job.scenes[i];
    if (sc.kind === 'image' && sc.motion && sc.motion !== 'none') {
      const frames = Math.ceil(L * FPS) + 1;
      f.push(`[${sceneIn[i]}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},setsar=1,` +
        `zoompan=${kenBurns(sc.motion, frames)}:d=${frames}:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p,` +
        `trim=duration=${L},setpts=PTS-STARTPTS[v${i}]`);
    } else {
      f.push(`[${sceneIn[i]}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,` +
        `tpad=stop_mode=clone:stop_duration=${L},trim=duration=${L},setpts=PTS-STARTPTS[v${i}]`);
    }
    const fmt = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${L},asetpts=PTS-STARTPTS`;
    if (voiceIn[i] !== null && clipAudio[i]) {
      // narration on top of the clip's own sound: the original stays, quietly, underneath
      f.push(`[${voiceIn[i]}:a]${fmt}[vo${i}]`);
      f.push(`[${sceneIn[i]}:a]${fmt},volume=0.2[or${i}]`);
      f.push(`[vo${i}][or${i}]amix=inputs=2:duration=first:normalize=0[a${i}]`);
    } else if (voiceIn[i] !== null) {
      f.push(`[${voiceIn[i]}:a]${fmt}[a${i}]`);
    } else if (clipAudio[i]) {
      f.push(`[${sceneIn[i]}:a]${fmt}[a${i}]`);
    } else {
      f.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${L},aformat=sample_fmts=fltp,asetpts=PTS-STARTPTS[a${i}]`);
    }
  });
  const n = job.scenes.length;
  f.push(`${job.scenes.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vcat]`);
  f.push(`${job.scenes.map((_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[narr]`);

  const fadeOut = Math.max(0, T - FADE);
  let last = 'vcat';
  if (capIn !== null) {
    f.push(`[${capIn}:v]fps=${FPS},scale=${W}:${H},format=rgba,setpts=PTS-STARTPTS[captrack]`);
    f.push(`[vcat][captrack]overlay=0:0:eof_action=pass:format=auto[capd]`);
    last = 'capd';
  }
  // no fade-in: the very first frame is the real picture, so covers and previews are never black
  f.push(`[${last}]fade=t=out:st=${fadeOut}:d=${FADE},format=yuv420p[vout]`);

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
  f.push(`[mix]afade=t=in:st=0:d=0.15,afade=t=out:st=${Math.max(0, T - 0.8)}:d=0.8,alimiter=limit=0.95[aout]`);

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
  return { file: out, durationSec: T, captionLines: new Set(capCues.map((c) => c.text)).size };
}
