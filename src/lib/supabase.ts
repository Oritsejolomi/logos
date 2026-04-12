import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set');
}

// Single shared client instance. No auth persistence — we use device-local
// identity from src/lib/identity.ts instead.
export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

export const SUPABASE_URL = url;
export const SUPABASE_ANON_KEY = anonKey;
export const FUNCTIONS_BASE = `${url}/functions/v1`;
