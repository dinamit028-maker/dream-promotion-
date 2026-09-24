'use client';
import { useEffect, useState } from 'react';
import { AuthForm, type Mode } from '@/features/auth/AuthForm';

export default function AuthPage() {
  const [mode, setMode] = useState<Mode | null>(null);
  useEffect(() => {
    const m = new URLSearchParams(location.search).get('mode');
    setMode(m === 'up' ? 'up' : 'in');
  }, []);
  return mode ? <AuthForm initialMode={mode} /> : null;
}
