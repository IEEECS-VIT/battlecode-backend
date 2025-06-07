import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL; // Add your Supabase URL
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY; // Add your Supabase anon key

const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default supabase;