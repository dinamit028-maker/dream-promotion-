// the browser Supabase client reads its public keys when its module loads — a test that calls it imports this first (fake values)
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://sb.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test-key';
export {};
