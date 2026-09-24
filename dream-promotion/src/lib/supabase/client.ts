'use client';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** False until the two public keys exist — the app still runs, just without accounts. */
export const isCloudConfigured = Boolean(url && key);

let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  if (!client) {
    if (!isCloudConfigured) throw new Error('supabase_not_configured');
    client = createClient(url!, key!, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  return client;
}
