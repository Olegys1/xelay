import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useAuth } from '../context/AuthContext'
import { useOnboarding } from '../context/OnboardingContext'
import { ANNOUNCEMENT_SLOT_RELEASED, acquireAnnouncementSlot, releaseAnnouncementSlot } from '../lib/announcementSlot'
import {
  GROUP_JOIN_REMINDER_ID, hasSeenGroupJoinReminder, isGroupJoinReminderAudience,
  loadGroupJoinReminderState, persistGroupJoinReminder, rememberGroupJoinReminder,
} from '../lib/studyGroupJoinReminder'
import { StudyGroupJoinNotice } from './StudyGroupJoinNotice'

export function StudyGroupJoinReminder({ blocked = false }: { blocked?: boolean }) {
  const { authUser, xelayUser, isLoading, isPasswordRecovery } = useAuth()
  const { suspended } = useOnboarding()
  const paymentReturn = useRouterState({ select: (state) =>
    (state.location.pathname === '/support' || state.location.pathname === '/subscription')
      && new URLSearchParams(state.location.searchStr).has('orderReference') })
  const ready = Boolean(authUser && xelayUser?.id === authUser.id && !isLoading && !isPasswordRecovery
    && !blocked && !suspended && !paymentReturn && isGroupJoinReminderAudience(xelayUser!))
  return ready && authUser && xelayUser ? <AccountGroupJoinReminder key={authUser.id} userId={authUser.id}
    username={xelayUser.username || ''} membershipKey={(xelayUser.studyGroupIds || []).join(',')} /> : null
}

function AccountGroupJoinReminder({ userId, username, membershipKey }: { userId: string; username: string; membershipKey: string }) {
  const navigate = useNavigate()
  const [candidate, setCandidate] = useState<{ pendingInvites: boolean } | null>(null)
  const [open, setOpen] = useState(false)
  const displayed = useRef(false)
  const opening = useRef(false)
  const slotOwner = `${GROUP_JOIN_REMINDER_ID}:${userId}`

  useEffect(() => () => releaseAnnouncementSlot(slotOwner), [slotOwner])
  useEffect(() => { if (!open) releaseAnnouncementSlot(slotOwner) }, [open, slotOwner])

  useEffect(() => {
    let current = true
    let busy = false
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let controller: AbortController | null = null
    const syncReceipt = () => { void persistGroupJoinReminder(userId).catch(() => {}) }
    const check = async () => {
      if (!current || busy || document.visibilityState !== 'visible') return
      if (hasSeenGroupJoinReminder(userId)) { syncReceipt(); return }
      busy = true
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 12_000)
      try {
        const state = await loadGroupJoinReminderState(userId, controller.signal)
        if (!current) return
        if (state.seen) rememberGroupJoinReminder(userId)
        if (state.seen || state.inGroup) { setCandidate(null); setOpen(false); return }
        setCandidate({ pendingInvites: state.pendingInvites })
      } catch {
        if (!current) return
        setCandidate(null)
        attempts += 1
        if (attempts < 3) retryTimer = setTimeout(() => { retryTimer = null; void check() }, attempts === 1 ? 1500 : 5000)
      } finally { clearTimeout(timeout); busy = false }
    }
    const resume = () => {
      if (document.visibilityState !== 'visible') return
      attempts = 0
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      void check()
    }
    const storage = (event: StorageEvent) => {
      if (event.key !== null && !event.key.includes(GROUP_JOIN_REMINDER_ID)) return
      if (hasSeenGroupJoinReminder(userId)) { setCandidate(null); setOpen(false) }
    }
    void check()
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    window.addEventListener('storage', storage)
    document.addEventListener('visibilitychange', resume)
    return () => {
      current = false
      controller?.abort()
      if (retryTimer) clearTimeout(retryTimer)
      window.removeEventListener('online', resume)
      window.removeEventListener('focus', resume)
      window.removeEventListener('storage', storage)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [userId, membershipKey])

  useEffect(() => {
    if (!candidate || open || displayed.current) return
    let current = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let request: AbortController | null = null
    let requestTimeout: ReturnType<typeof setTimeout> | null = null
    const canDisplay = () => document.visibilityState === 'visible' && !Array.from(document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]',
    )).some((dialog) => dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden')
    const schedule = () => {
      if (timer || opening.current || !canDisplay() || hasSeenGroupJoinReminder(userId)) return
      timer = setTimeout(async () => {
        timer = null
        if (!current || !canDisplay() || hasSeenGroupJoinReminder(userId) || !acquireAnnouncementSlot(slotOwner)) return
        opening.current = true
        let handedOff = false
        request = new AbortController()
        requestTimeout = setTimeout(() => request?.abort(), 12_000)
        try {
          // A dialog may have waited behind onboarding/another announcement.
          // Check the working membership again, never the cached profile IDs.
          const state = await loadGroupJoinReminderState(userId, request.signal)
          if (!current) return
          if (state.seen) rememberGroupJoinReminder(userId)
          if (state.seen || state.inGroup) { setCandidate(null); return }
          if (!canDisplay() || hasSeenGroupJoinReminder(userId)) return
          setCandidate({ pendingInvites: state.pendingInvites })
          setOpen(true)
          handedOff = true
        } catch { if (current) setCandidate(null) }
        finally {
          if (requestTimeout) clearTimeout(requestTimeout)
          opening.current = false
          // The visible notice owns the slot until it is dismissed.
          if (!handedOff) releaseAnnouncementSlot(slotOwner)
        }
      }, 350)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['role', 'aria-modal', 'hidden', 'open', 'class', 'style'] })
    window.addEventListener(ANNOUNCEMENT_SLOT_RELEASED, schedule)
    document.addEventListener('visibilitychange', schedule)
    window.addEventListener('storage', schedule)
    schedule()
    return () => {
      current = false
      request?.abort()
      if (timer) clearTimeout(timer)
      if (requestTimeout) clearTimeout(requestTimeout)
      observer.disconnect()
      window.removeEventListener(ANNOUNCEMENT_SLOT_RELEASED, schedule)
      document.removeEventListener('visibilitychange', schedule)
      window.removeEventListener('storage', schedule)
    }
  }, [candidate, open, slotOwner, userId])

  const onDisplayed = useCallback(() => {
    if (displayed.current) return
    displayed.current = true
    rememberGroupJoinReminder(userId)
    void persistGroupJoinReminder(userId).catch(() => {})
  }, [userId])
  return open ? <StudyGroupJoinNotice username={username} pendingInvites={candidate?.pendingInvites === true}
    onDisplayed={onDisplayed} onClose={() => setOpen(false)}
    onOpenGroups={() => { setOpen(false); void navigate({ to: '/groups' }) }}
    onOpenProfile={() => { setOpen(false); void navigate({ to: '/profile' }) }} /> : null
}
