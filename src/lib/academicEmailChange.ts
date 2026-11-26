import type { SupabaseClient } from '@supabase/supabase-js'
import { isKnuEmail } from './academicEmail.ts'

/** Isolate this mutation from a sign-in in another tab. Never move credentials
 * or content to another user; Auth confirms the new address on the same UUID. */
export async function requestAcademicEmailChange({ client, createIsolated, userId, email, redirectTo, isActive }: {
  client: SupabaseClient; createIsolated: () => SupabaseClient; userId: string; email: string; redirectTo: string; isActive: () => boolean
}): Promise<void> {
  if (!isKnuEmail(email)) throw new Error('KNU_EMAIL_REQUIRED')
  const snapshot = await client.auth.getSession()
  const session = snapshot.data.session
  if (snapshot.error || session?.user.id !== userId || !isActive()) throw new Error('SESSION_CHANGED')
  const isolated = createIsolated()
  const prepared = await isolated.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
  if (prepared.error || prepared.data.user?.id !== userId) throw new Error('SESSION_CHANGED')
  const verified = await isolated.auth.getUser()
  const current = await client.auth.getSession()
  if (verified.error || verified.data.user?.id !== userId || current.error || current.data.session?.user.id !== userId || !isActive()) throw new Error('SESSION_CHANGED')
  const result = await isolated.auth.updateUser({ email: email.trim().toLowerCase() }, { emailRedirectTo: redirectTo })
  if (result.error) throw result.error
  if (result.data.user?.id !== userId) throw new Error('SESSION_CHANGED')
}
