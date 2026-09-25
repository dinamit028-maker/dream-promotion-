'use client';
import { useApp } from '@/lib/store';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';

/**
 * Sign out and land on the home page. A full page load (not a client-side route change),
 * so no screen can bounce the user to onboarding while the local data is being cleared.
 */
export async function signOutEverywhere() {
  if (isCloudConfigured) { try { await supabase().auth.signOut(); } catch { /* already signed out */ } }
  location.replace('/');
  useApp.getState().signOutLocal();
}
