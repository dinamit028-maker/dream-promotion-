import type { Storyboard } from '@/types';

/**
 * VideoService — reel rendering adapter.
 * The storyboard comes from AIService; turning it into an MP4 needs an external
 * renderer (Runway / Pika / HeyGen / Creatomate / Shotstack).
 */
export class VideoProviderMissingError extends Error {
  constructor() { super('No video provider configured (VIDEO_PROVIDER)'); }
}

export const VideoService = {
  configured: Boolean(process.env.NEXT_PUBLIC_VIDEO_READY),
  async render(_board: Storyboard): Promise<never> { throw new VideoProviderMissingError(); },
};
