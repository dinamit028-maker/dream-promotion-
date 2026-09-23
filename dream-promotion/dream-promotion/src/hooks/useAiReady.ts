'use client';
import { useEffect, useState } from 'react';
import { AIService } from '@/lib/services';

/** null = still checking. Components must not offer generation until this is true. */
export function useAiReady() {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => { AIService.available().then(setReady); }, []);
  return ready;
}
