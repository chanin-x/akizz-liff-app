// src/lib/supabaseClient.ts
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/public';

const publicEnv = env as Record<string, string | undefined>;
const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL ?? publicEnv.VITE_SUPABASE_URL;
const supabaseAnonKey = publicEnv.PUBLIC_SUPABASE_ANON_KEY ?? publicEnv.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase public URL or Anon Key is missing');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

