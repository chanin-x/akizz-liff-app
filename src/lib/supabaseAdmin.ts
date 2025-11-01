// src/lib/supabaseAdmin.ts
import { createClient } from '@supabase/supabase-js'
import { env } from '$env/dynamic/private' // ‼️ Import Key ลับ

// ดึงค่า Private (จาก Netlify)
const supabaseUrl = env.SUPABASE_URL 
const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Supabase URL or Service Key is missing in env');
}

// ‼️ สร้าง Admin Client (ข้าม RLS ได้)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);