/**
 * Browser-side media helpers. Client photos live as blob: URLs, which the video
 * model can't reach — so we shrink them and send them inline as a data URI.
 */
export async function imageToDataUri(src: string, maxSide = 1280): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('image_load_failed'));
    i.src = src;
  });
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}

/**
 * The last frame of a finished clip, to use as the first frame of the next one —
 * this is what makes stitched clips feel like one continuous take.
 * Throws if the video host doesn't allow cross-origin frame reads; callers fall back.
 */
export async function lastFrameDataUri(videoUrl: string, maxSide = 1280): Promise<string> {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  v.src = videoUrl;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('frame_timeout')), 30_000);
    v.onloadedmetadata = () => { v.currentTime = Math.max(0, v.duration - 0.08); };
    v.onseeked = () => { clearTimeout(t); resolve(); };
    v.onerror = () => { clearTimeout(t); reject(new Error('video_load_failed')); };
  });
  const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9); // throws SecurityError on a tainted canvas
}
