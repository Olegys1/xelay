import { useEffect, useRef, useState } from 'react'
import { BIRTHDAY_PROFILE_CHANGED, loadGroupBirthdays, type GroupBirthday } from '../../lib/birthdayProfile'
import { GroupBirthdayList } from './GroupBirthdayList'

export function GroupBirthdays({ userId, groupId }: { userId: string; groupId: string }) {
  const identity = `${userId}:${groupId}`, current = useRef(identity); current.current = identity
  const [snapshot, setSnapshot] = useState<{ identity: string; members: GroupBirthday[]; loading: boolean; error: string }>({ identity, members: [], loading: true, error: '' })
  const [retry, setRetry] = useState(0)
  const refreshAt = useRef(0)
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (window.location.hash !== '#group-birthdays-area') return
    const frame = window.requestAnimationFrame(() => {
      const element = anchor.current
      if (current.current !== identity || window.location.hash !== '#group-birthdays-area' || !element?.isConnected) return
      element.scrollIntoView({ block: 'start', behavior: 'instant' })
      element.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [identity])
  useEffect(() => {
    let active = true, request: AbortController | null = null, inFlight = false
    const reload = async (force = false) => {
      if (inFlight && !force) return
      if (force) setSnapshot({ identity, members: [], loading: true, error: '' })
      request?.abort(); request = new AbortController(); inFlight = true
      const signal = request.signal
      try {
        const members = await loadGroupBirthdays(userId, groupId, signal)
        if (active && !signal.aborted && current.current === identity) { refreshAt.current = Date.now(); setSnapshot({ identity, members, loading: false, error: '' }) }
      } catch {
        if (active && !signal.aborted && current.current === identity) setSnapshot({ identity, members: [], loading: false, error: 'Дні народження зараз недоступні. Спробуйте оновити цей блок.' })
      } finally { if (request?.signal === signal) inFlight = false }
    }
    setSnapshot({ identity, members: [], loading: true, error: '' })
    void reload()
    const focused = () => { if (document.visibilityState === 'visible' && Date.now() - refreshAt.current > 60000) void reload() }
    const changed = () => { void reload(true) }
    window.addEventListener('focus', focused); window.addEventListener('online', focused); document.addEventListener('visibilitychange', focused)
    window.addEventListener(BIRTHDAY_PROFILE_CHANGED, changed)
    return () => { active = false; request?.abort(); window.removeEventListener('focus', focused); window.removeEventListener('online', focused); document.removeEventListener('visibilitychange', focused); window.removeEventListener(BIRTHDAY_PROFILE_CHANGED, changed) }
  }, [identity, userId, groupId, retry])
  const visible = snapshot.identity === identity ? snapshot : { identity, members: [], loading: true, error: '' }
  return <div ref={anchor} id="group-birthdays-area" tabIndex={-1} className="mb-5 scroll-mt-24 outline-none"><GroupBirthdayList members={visible.members} loading={visible.loading} error={visible.error} onRetry={() => setRetry(value => value + 1)} /></div>
}
