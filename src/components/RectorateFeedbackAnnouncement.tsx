import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, MessageSquareHeart, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useOnboarding } from '../context/OnboardingContext'
import {
  feedbackReceiptKey, hasSeenFeedbackAnnouncement, loadFeedbackAnnouncementSeen,
  persistFeedbackAnnouncement, rememberFeedbackAnnouncement, XELAY_FEEDBACK_FORM_URL,
} from '../lib/rectorateFeedbackAnnouncement'

export function RectorateFeedbackAnnouncement({ blocked = false }: { blocked?: boolean }) {
  const { authUser, xelayUser, isLoading, isPasswordRecovery } = useAuth()
  const { suspended } = useOnboarding()
  if (isLoading || isPasswordRecovery || suspended || blocked || (authUser && xelayUser?.id !== authUser.id)) return null
  return <AccountFeedbackAnnouncement key={authUser?.id || 'guest'} userId={authUser?.id} />
}

function AccountFeedbackAnnouncement({ userId }: { userId?: string }) {
  const [show, setShow] = useState(false)
  const card = useRef<HTMLElement>(null)
  const recorded = useRef(false)
  const record = useCallback(() => {
    if (recorded.current) return
    recorded.current = true
    rememberFeedbackAnnouncement(userId)
    void persistFeedbackAnnouncement(userId).catch(() => {})
  }, [userId])

  useEffect(() => {
    let active = true, busy = false, attempts = 0
    let controller: AbortController | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      if (!active || busy || document.visibilityState !== 'visible') return
      if (hasSeenFeedbackAnnouncement(userId)) {
        // A receipt must not collapse the card while someone is reading it.
        void persistFeedbackAnnouncement(userId).catch(() => {})
        return
      }
      busy = true
      const request = new AbortController()
      controller = request
      const timeout = setTimeout(() => request.abort(), 10000)
      try {
        const alreadySeen = await loadFeedbackAnnouncementSeen(userId, request.signal)
        if (active) setShow(!alreadySeen && !hasSeenFeedbackAnnouncement(userId))
      } catch {
        attempts += 1
        if (active && attempts < 3) retry = setTimeout(() => { retry = undefined; void check() }, attempts * 2000)
      } finally { clearTimeout(timeout); busy = false }
    }
    const resume = () => {
      if (document.visibilityState !== 'visible') return
      attempts = 0
      if (retry) clearTimeout(retry)
      retry = undefined
      void check()
    }
    const storage = (event: StorageEvent) => {
      if ((event.key === null || event.key === feedbackReceiptKey(userId)) && hasSeenFeedbackAnnouncement(userId)) setShow(false)
    }
    void check()
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    window.addEventListener('storage', storage)
    document.addEventListener('visibilitychange', resume)
    return () => {
      active = false; controller?.abort()
      if (retry) clearTimeout(retry)
      window.removeEventListener('online', resume)
      window.removeEventListener('focus', resume)
      window.removeEventListener('storage', storage)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [userId])

  useEffect(() => {
    const element = card.current
    if (!show || !element) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const visible = () => {
      if (document.visibilityState !== 'visible' || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
      const style = getComputedStyle(element)
      const obstructed = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]'))
        .some(dialog => dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden')
      return !obstructed && rect.width > 0 && rect.height > 0 && visibleHeight >= rect.height / 2
        && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const schedule = () => {
      if (timer) { clearTimeout(timer); timer = undefined }
      if (recorded.current || !visible()) return
      timer = setTimeout(() => { timer = undefined; if (visible()) record() }, 1200)
    }
    const observer = new IntersectionObserver(schedule, { threshold: [0, 0.5, 1] })
    observer.observe(element)
    const modals = new MutationObserver(schedule)
    modals.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'open', 'hidden', 'style', 'class'] })
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('visibilitychange', schedule)
    schedule()
    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect(); modals.disconnect()
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [show, record])

  return show ? <RectorateFeedbackNotice cardRef={card} onOpen={record} onClose={() => { record(); setShow(false) }} /> : null
}

export function RectorateFeedbackNotice({ cardRef, onOpen, onClose }: {
  cardRef?: React.Ref<HTMLElement>; onOpen: () => void; onClose: () => void
}) {
  return <aside ref={cardRef} aria-label="Відгук про Xelay перед презентацією ректорату"
    className="mb-5 flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/[.045] p-4 text-left">
    <MessageSquareHeart size={21} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <h2 className="text-sm font-semibold leading-5 text-foreground">Ваш відгук важливий для Xelay 💛</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Готуємо презентацію ректорату КНУ. Студенти, старости та викладачі — розкажіть, що зручно, а що варто покращити.</p>
      <a href={XELAY_FEEDBACK_FORM_URL} target="_blank" rel="noopener noreferrer" onClick={onOpen}
        className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        Залишити відгук <ArrowUpRight size={15} aria-hidden="true" />
      </a>
      <span className="ml-2 inline-block text-xs text-muted-foreground">2–3 хвилини</span>
    </div>
    <button type="button" aria-label="Закрити запрошення залишити відгук" onClick={onClose}
      className="-mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      <X size={17} aria-hidden="true" />
    </button>
  </aside>
}
