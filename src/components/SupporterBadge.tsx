import { useEffect, useState } from 'react'
import { Heart } from 'lucide-react'
import { supabase } from '../lib/supabase'

export function SupporterMark() {
  return <span title="Знак подяки за добровільну підтримку команди. Не надає платних прав."
    className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-rose-300/50 bg-gradient-to-r from-rose-100 to-amber-50 px-2.5 py-1 text-[10px] font-semibold text-rose-800 dark:border-rose-400/30 dark:from-rose-950 dark:to-amber-950 dark:text-rose-200">
    <Heart size={12} fill="currentColor" strokeWidth={1.5} aria-hidden="true" />Підтримую Xelay
  </span>
}

export function SupporterBadge({ userId }: { userId?: string }) {
  const [snapshot, setSnapshot] = useState<{ userId: string; active: boolean } | null>(null)
  useEffect(() => {
    let active = true
    let busy = false
    setSnapshot(null)
    if (!userId) return
    const refresh = async () => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const { data, error } = await supabase.rpc('xelay_supporter_badge', { p_user_id: userId })
        if (active) setSnapshot({ userId, active: !error && data === true })
      } catch { if (active) setSnapshot(null) }
      finally { busy = false }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const interval = window.setInterval(refresh, 60_000)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.clearInterval(interval)
    }
  }, [userId])
  return snapshot?.userId === userId && snapshot?.active ? <SupporterMark /> : null
}
