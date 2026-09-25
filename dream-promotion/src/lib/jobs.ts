'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Paid video renders, tracked outside any screen. A render keeps going on fal
 * even if the editor closes, the tab reloads, or the user presses stop too late —
 * so the job is written down here and the JobRunner finishes it and files the
 * result in the media library. Nothing that was paid for can go missing.
 */
export interface VideoJob {
  id: string;
  requestId: string;
  model: string;
  name: string;
  contentId: string | null;   // the post it was made for, if any
  seconds: number;
  cost: number;
  status: 'running' | 'ready' | 'failed';
  phase?: 'queued' | 'running';
  position?: number | null;
  mediaId?: string;           // set when ready — waiting for the user to approve it
  error?: string;
  createdAt: number;
}

interface JobsState {
  jobs: VideoJob[];
  add: (j: VideoJob) => void;
  update: (id: string, patch: Partial<VideoJob>) => void;
  remove: (id: string) => void;
}

export const useJobs = create<JobsState>()(
  persist(
    (set) => ({
      jobs: [],
      add: (j) => set((s) => ({ jobs: [j, ...s.jobs] })),
      update: (id, patch) => set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),
      remove: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
    }),
    { name: 'dp-video-jobs', version: 1 },
  ),
);
