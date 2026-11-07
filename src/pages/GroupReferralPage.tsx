import { useEffect, useMemo, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useAuth } from '../context/AuthContext'
import { AuthModal } from '../components/AuthModal'
import { GroupReferralCampaign } from '../components/referrals/GroupReferralCampaign'
import { createSupabaseGroupReferralRepository } from '../lib/groupReferralRepository'
import { normalizeGroupReferralCode, rememberGroupReferralInvitation } from '../lib/groupReferralInvitation'
import { supabase } from '../lib/supabase'

export function GroupReferralPage() {
  const { authUser, isLoading } = useAuth()
  const search = useSearch({ strict: false }) as { code?: string }
  const code = normalizeGroupReferralCode(search.code)
  const [showAuth, setShowAuth] = useState(false)
  const repository = useMemo(() => createSupabaseGroupReferralRepository(supabase, authUser?.id || null), [authUser?.id])
  useEffect(() => { if (authUser && code) rememberGroupReferralInvitation(authUser.id, code) }, [authUser?.id, code])
  if (isLoading) return <main role="status" className="min-h-[60vh] p-10 text-center">Відкриваємо акцію…</main>
  return <><GroupReferralCampaign key={authUser?.id || 'guest'} repository={repository} initialCode={code} onAuthRequest={() => setShowAuth(true)} />{showAuth && <AuthModal onClose={() => setShowAuth(false)} />}</>
}
