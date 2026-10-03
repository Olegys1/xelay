import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('[Xelay] Missing Supabase environment variables. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Email pages validate the link identity and ask for explicit confirmation.
    // A URL opened elsewhere must never replace the current browser session.
    detectSessionInUrl: false,
  },
})

// A link's refresh credential is checked without touching the signed-in account.
export function emailLinkVerifier() {
  return createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
}
