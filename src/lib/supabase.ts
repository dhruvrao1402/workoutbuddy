// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

const url = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
const anon = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null =
  typeof url === 'string' && url && typeof anon === 'string' && anon
    ? createClient(url, anon)
    : null;

export function isSupabaseConfigured(): boolean {
  return Boolean(url && anon);
}
