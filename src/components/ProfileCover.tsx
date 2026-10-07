import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { PROFILE_COVERS } from '../lib/participantAppearance'
import { APPEARANCE_UPDATED } from '../lib/participantAppearance'
import '../pages/participantAppearance.css'

export function ProfileCover({ userId }: { userId?: string }) {
  const [cover, setCover] = useState<{ userId?: string; value: string }>({ value: 'default' })
  useEffect(() => {
    let active = true
    let sequence = 0
    setCover({ userId, value: 'default' })
    const load = async () => {
      const request = ++sequence
      if (!userId) return
      try {
        const { data, error } = await supabase.rpc('xelay_public_appearance', { p_user_ids: [userId] })
        if (!active || request !== sequence) return
        const value = !error && Array.isArray(data) ? data.find((item) => item.user_id === userId)?.profile_cover : 'default'
        setCover({ userId, value: PROFILE_COVERS.some((item) => item.id === value) ? value : 'default' })
      } catch {
        if (active && request === sequence) setCover({ userId, value: 'default' })
      }
    }
    void load()
    window.addEventListener(APPEARANCE_UPDATED, load)
    window.addEventListener('focus', load)
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 60000)
    return () => { active = false; ++sequence; window.clearInterval(interval); window.removeEventListener(APPEARANCE_UPDATED, load); window.removeEventListener('focus', load) }
  }, [userId])
  if (cover.userId !== userId || cover.value === 'default') return null
  return <div aria-hidden="true" className={`xelay-cover-${cover.value} mb-5 h-24 rounded-xl sm:h-32`} />
}
