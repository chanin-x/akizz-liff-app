// src/lib/supabaseClient.ts
import { createClient } from '@supabase/supabase-js'
import { env } from '$env/dynamic/public' // ‼️ Import Key สาธารณะ

const supabaseUrl = env.VITE_SUPABASE_URL
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase public URL or Anon Key is missing');
}

// สร้าง Client ธรรมดา
export const supabase = createClient(supabaseUrl, supabaseAnonKey)