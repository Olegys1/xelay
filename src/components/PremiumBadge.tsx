import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { ParticipantStatusEmojis } from './ParticipantStatusEmoji'
import { BadgeInfo } from './BadgeInfo'

type PremiumIdentity = { is_premium: boolean; emoji_status: string | null; status_text?: string | null }

export function PremiumBadge({ userId, isPremium, emojiStatus, textStatus, compact = false, showBadge = true }: {
  userId?: string
  isPremium?: boolean
  emojiStatus?: string | null
  textStatus?: string | null
  compact?: boolean
  showBadge?: boolean
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
  const status = emojiStatus !== undefined ? emojiStatus : identity?.emoji_status
  const text = textStatus !== undefined ? textStatus : identity?.status_text
  if (!premium) return null
  return <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5 align-middle">
    {showBadge && <BadgeInfo label="Учасник" description="Цей бейдж означає активну особисту підписку «Учасник» у Xelay. Вона відкриває додаткові можливості й оформлення профілю. Це окремий бейдж від добровільної підтримки команди." aria-label="Підписка Учасник" className={`inline-flex cursor-pointer items-center gap-1 rounded-full bg-primary/10 font-semibold text-primary ${compact ? 'p-1' : 'px-2 py-1 text-[10px]'}`}>
      <Sparkles size={compact ? 13 : 12} aria-hidden="true" />
      {!compact && 'Учасник'}
    </BadgeInfo>}
    {status && <ParticipantStatusEmojis status={status} />}
    {text && <span title={text} aria-label={`Статус: ${text}`} className={`truncate rounded-full bg-muted px-2 py-1 font-normal text-muted-foreground ${compact ? 'max-w-[7rem] text-[10px] sm:max-w-[10rem]' : 'max-w-[14rem] text-xs'}`}>{text}</span>}
  </span>
}
