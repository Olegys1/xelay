import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { supabase } from '../lib/supabase'

type PremiumIdentity = { is_premium: boolean; emoji_status: string | null }

export function PremiumBadge({ userId, isPremium, emojiStatus, compact = false }: {
  userId?: string
  isPremium?: boolean
  emojiStatus?: string | null
  compact?: boolean
}) {
  const [snapshot, setSnapshot] = useState<{ userId: string; identity: PremiumIdentity } | null>(null)
  const identity = snapshot && snapshot.userId === userId ? snapshot.identity : null
  useEffect(() => {
    let active = true
    let busy = false
    setSnapshot(null)
    if (!userId || isPremium !== undefined) return
    const refresh = async () => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const { data, error } = await supabase.rpc('xelay_public_premium', { p_user_ids: [userId] })
        if (active) setSnapshot(!error && Array.isArray(data) && data[0] ? { userId, identity: data[0] } : null)
      } finally { busy = false }
    }
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    const interval = window.setInterval(onFocus, 60_000)
    return () => { active = false; window.removeEventListener('focus', onFocus); window.clearInterval(interval) }
  }, [userId, isPremium])
  const premium = isPremium ?? identity?.is_premium ?? false
  const status = emojiStatus ?? identity?.emoji_status
  if (!premium) return null
  return <span className="inline-flex shrink-0 items-center gap-1.5 align-middle">
    <span title="Підписка «Учасник»" aria-label="Підписка Учасник" className={`inline-flex items-center gap-1 rounded-full bg-primary/10 font-semibold text-primary ${compact ? 'p-1' : 'px-2 py-1 text-[10px]'}`}>
      <Sparkles size={compact ? 13 : 12} aria-hidden="true" />
      {!compact && 'Учасник'}
    </span>
    {status && <span title="Емодзі-статус" aria-label={`Емодзі-статус: ${status}`} className="text-base leading-none">{status}</span>}
  </span>
}
