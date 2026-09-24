'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/primitives';
import { CloseButton, Modal } from '@/components/ui/feedback';
import { AuthForm, type Mode } from './AuthForm';

/** Signed-in visitors skip the landing page; everyone else logs in right here, in a dialog. */
export function LandingRedirect() {
  const router = useRouter();
  useEffect(() => {
    if (!isCloudConfigured) return;
    supabase().auth.getSession().then(({ data }) => { if (data.session?.user) router.replace('/dashboard'); });
  }, [router]);
  return null;
}

export function AuthButton({ mode, children, variant = 'primary', size = 'sm' }: {
  mode: Mode; children: ReactNode; variant?: 'primary' | 'ghost'; size?: 'sm' | 'lg';
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>{children}</Button>
      <Modal open={open} onClose={() => setOpen(false)}>
        <div className="mx-auto max-w-md">
          <div className="-mb-2 flex justify-end"><CloseButton onClick={() => setOpen(false)} /></div>
          <AuthForm key={mode} initialMode={mode} compact />
        </div>
      </Modal>
    </>
  );
}
