import { useEffect, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useOnboarding } from '../context/OnboardingContext'
import { hasSeenSecretBadgeAnnouncement, loadSecretBadgeAnnouncementSeen, persistSecretBadgeAnnouncement, rememberSecretBadgeAnnouncement, secretBadgeReceiptKey } from '../lib/secretBadgeAnnouncement'

export function SecretBadgeAnnouncement({ blocked = false }: { blocked?: boolean }) {
  const { authUser, isLoading, isPasswordRecovery } = useAuth()
  const { suspended } = useOnboarding()
  return !isLoading && !isPasswordRecovery && !suspended && !blocked
    ? <AccountSecretBadgeAnnouncement key={authUser?.id || 'guest'} userId={authUser?.id} /> : null
}

function AccountSecretBadgeAnnouncement({ userId }: { userId?: string }) {
  const [state, setState] = useState<'loading' | 'show' | 'hidden'>('loading')
  const card = useRef<HTMLElement>(null)
  const recorded = useRef(false)
  const record = () => {
    if (recorded.current) return
    recorded.current = true
    rememberSecretBadgeAnnouncement(userId)
    void persistSecretBadgeAnnouncement(userId).catch(() => {})
  }
  useEffect(() => {
    let active = true, busy = false, attempts = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const check = async () => {
      if (!active || busy || document.visibilityState !== 'visible') return
      if (hasSeenSecretBadgeAnnouncement(userId)) {
        setState('hidden'); void persistSecretBadgeAnnouncement(userId).catch(() => {}); return
      }
      busy = true; controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 10000)
      try {
        const alreadySeen = await loadSecretBadgeAnnouncementSeen(userId, controller.signal)
        if (active) setState(alreadySeen ? 'hidden' : 'show')
      } catch {
        attempts += 1
        if (active && attempts < 3) retry = setTimeout(() => { retry = undefined; void check() }, attempts * 2000)
      } finally { clearTimeout(timeout); busy = false }
    }
    const resume = () => {
      if (hasSeenSecretBadgeAnnouncement(userId)) { void persistSecretBadgeAnnouncement(userId).catch(() => {}); return }
      attempts = 0; if (retry) clearTimeout(retry); retry = undefined; void check()
    }
    const storage = (event: StorageEvent) => {
      if ((event.key === null || event.key === secretBadgeReceiptKey(userId)) && hasSeenSecretBadgeAnnouncement(userId)) setState('hidden')
    }
    void check()
    window.addEventListener('online', resume); window.addEventListener('focus', resume); window.addEventListener('storage', storage)
    document.addEventListener('visibilitychange', resume)
    return () => { active = false; controller?.abort(); if (retry) clearTimeout(retry)
      window.removeEventListener('online', resume); window.removeEventListener('focus', resume); window.removeEventListener('storage', storage)
      document.removeEventListener('visibilitychange', resume) }
  }, [userId])

  useEffect(() => {
    const element = card.current
    if (state !== 'show' || !element) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (timer) { clearTimeout(timer); timer = undefined }
      if (recorded.current || document.visibilityState !== 'visible') return
      const rect = element.getBoundingClientRect()
      const obstructed = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]'))
        .some((dialog) => dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden')
      const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
      if (obstructed || visibleHeight < rect.height / 2 || rect.width === 0 || getComputedStyle(element).visibility === 'hidden') return
      timer = setTimeout(() => { timer = undefined; record() }, 700)
    }
    const observer = new IntersectionObserver(schedule, { threshold: [0, 0.5, 1] })
    observer.observe(element)
    const modals = new MutationObserver(schedule)
    modals.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'open', 'hidden', 'style', 'class'] })
    document.addEventListener('visibilitychange', schedule); window.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => { if (timer) clearTimeout(timer); observer.disconnect(); modals.disconnect()
      document.removeEventListener('visibilitychange', schedule); window.removeEventListener('scroll', schedule) }
  }, [state, userId])

  return state === 'show' ? <aside ref={card} aria-label="Секретний бейдж Xelay" className="mb-7 flex items-start gap-3 rounded-2xl border border-primary/15 bg-primary/[.035] p-3 text-left sm:p-4">
    <Sparkles size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
    <div className="min-w-0 flex-1"><p className="text-sm font-semibold">Псс… у Xelay є секретний бейдж ✨</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Знайдете Six Seven? Підказка чекає у підтримці команди.</p>
      <a href="/support" onClick={record} className="mt-1 inline-flex min-h-9 items-center text-xs font-semibold text-primary underline underline-offset-4">Знайти бейдж →</a>
    </div>
    <button type="button" aria-label="Закрити підказку про секретний бейдж" onClick={() => { record(); setState('hidden') }} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"><X size={16} /></button>
  </aside> : null
}
