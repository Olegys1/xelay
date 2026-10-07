import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import { supabase } from './supabase'

export const PROFILE_COVERS = [
  { id: 'default', label: 'Без обкладинки' }, { id: 'rose', label: 'Бордо' },
  { id: 'ocean', label: 'Океан' }, { id: 'forest', label: 'Ліс' },
  { id: 'lavender', label: 'Лаванда' }, { id: 'sunrise', label: 'Світанок' },
] as const
export const CHAT_THEMES = [
  { id: 'default', label: 'Xelay' }, { id: 'rose', label: 'Бордо' },
  { id: 'ocean', label: 'Океан' }, { id: 'forest', label: 'Ліс' }, { id: 'lavender', label: 'Лаванда' },
] as const
export const CHAT_WALLPAPERS = [
  { id: 'default', label: 'Без візерунка' }, { id: 'dots', label: 'Крапки' },
  { id: 'grid', label: 'Сітка' }, { id: 'waves', label: 'Хвилі' },
] as const
export interface ParticipantAppearance { profileCover: string; chatTheme: string; chatWallpaper: string }
export const DEFAULT_APPEARANCE: ParticipantAppearance = { profileCover: 'default', chatTheme: 'default', chatWallpaper: 'default' }
export const APPEARANCE_UPDATED = 'xelay:participant-appearance-updated'

export function parseAppearance(data: any): ParticipantAppearance {
  return {
    profileCover: PROFILE_COVERS.some((item) => item.id === data?.profile_cover) ? data.profile_cover : 'default',
    chatTheme: CHAT_THEMES.some((item) => item.id === data?.chat_theme) ? data.chat_theme : 'default',
    chatWallpaper: CHAT_WALLPAPERS.some((item) => item.id === data?.chat_wallpaper) ? data.chat_wallpaper : 'default',
  }
}

export function useParticipantAppearance() {
  const { authUser } = useAuth()
  const { isPremium } = useBilling()
  const owner = authUser?.id
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const [snapshot, setSnapshot] = useState<{ owner?: string; appearance: ParticipantAppearance }>({ appearance: DEFAULT_APPEARANCE })
  const [isLoading, setLoading] = useState(false)
  useEffect(() => {
    let active = true
    let sequence = 0
    setSnapshot({ owner, appearance: DEFAULT_APPEARANCE })
    const refresh = async () => {
      const request = ++sequence
      if (!owner || !isPremium) { setLoading(false); return }
      setLoading(true)
      try {
        const { data: { session }, error: authError } = await supabase.auth.getSession()
        if (authError || session?.user.id !== owner) throw new Error('identity')
        const { data, error } = await supabase.rpc('xelay_get_participant_appearance').setHeader('Authorization', `Bearer ${session.access_token}`)
        if (active && ownerRef.current === owner && request === sequence) {
          setSnapshot({ owner, appearance: error ? DEFAULT_APPEARANCE : parseAppearance(data) })
        }
      } catch {
        if (active && ownerRef.current === owner && request === sequence) setSnapshot({ owner, appearance: DEFAULT_APPEARANCE })
      } finally { if (active && request === sequence) setLoading(false) }
    }
    const onStorage = (event: StorageEvent) => { if (event.key === APPEARANCE_UPDATED) void refresh() }
    void refresh()
    window.addEventListener(APPEARANCE_UPDATED, refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener('storage', onStorage)
    return () => { active = false; ++sequence; window.removeEventListener(APPEARANCE_UPDATED, refresh); window.removeEventListener('focus', refresh); window.removeEventListener('storage', onStorage) }
  }, [owner, isPremium])
  return { ...(isPremium && snapshot.owner === owner ? snapshot.appearance : DEFAULT_APPEARANCE), isLoading }
}

export function announceAppearanceUpdate() {
  window.dispatchEvent(new Event(APPEARANCE_UPDATED))
  try { localStorage.setItem(APPEARANCE_UPDATED, String(Date.now())) } catch { /* Changes still apply in this tab. */ }
}
