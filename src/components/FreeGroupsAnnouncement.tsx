import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { ArrowRight, BookOpen, CalendarDays, Check, FileText, Sparkles, UsersRound, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useOnboarding } from '../context/OnboardingContext'
import { supabase } from '../lib/supabase'
import './freeGroupsAnnouncement.css'

const ANNOUNCEMENT_ID = 'free-study-groups-2026-10-07'
const seenThisSession = new Set<string>()
const receiptKey = (userId: string) => `xelay:announcement:${ANNOUNCEMENT_ID}:${userId}`

function remembered(userId: string) {
  if (seenThisSession.has(userId)) return true
  try { return localStorage.getItem(receiptKey(userId)) === 'seen' } catch { return false }
}

async function persistReceipt(userId: string) {
  // The table grants only own-account SELECT/INSERT. Its server timestamp and
  // immutable receipt cannot alter permissions, subscription or profile data.
  try {
    await supabase.from('account_announcement_receipts').upsert({ user_id: userId, announcement_id: ANNOUNCEMENT_ID }, {
      onConflict: 'user_id,announcement_id', ignoreDuplicates: true,
    })
  } catch { /* Local receipt still prevents repeat display if the network fails. */ }
}

function remember(userId: string) {
  seenThisSession.add(userId)
  try { localStorage.setItem(receiptKey(userId), 'seen') } catch { /* Keep the receipt in memory if storage is blocked. */ }
  void persistReceipt(userId)
}

export function FreeGroupsAnnouncement({ blocked = false }: { blocked?: boolean }) {
  const { authUser, xelayUser, isLoading, isPasswordRecovery } = useAuth()
  const { suspended } = useOnboarding()
  const paymentReturn = useRouterState({ select: (state) =>
    (state.location.pathname === '/support' || state.location.pathname === '/subscription')
      && new URLSearchParams(state.location.searchStr).has('orderReference') })
  const ready = Boolean(authUser && xelayUser?.id === authUser.id && !isLoading && !isPasswordRecovery && !blocked && !suspended && !paymentReturn)
  return ready && authUser ? <AccountAnnouncement key={authUser.id} userId={authUser.id} /> : null
}

function AccountAnnouncement({ userId }: { userId: string }) {
  const navigate = useNavigate()
  const [candidate, setCandidate] = useState(false)
  const [open, setOpen] = useState(false)
  const displayed = useRef(false)

  useEffect(() => {
    let current = true
    let busy = false
    let done = false
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const check = async () => {
      if (!current || busy || done || document.visibilityState !== 'visible') return
      busy = true
      attempts += 1
      try {
        // Deployment order must never announce free access while the working
        // database still enforces a paid or trial group entitlement.
        const available = await supabase.rpc('xelay_free_groups_available')
        if (!current) return
        if (available.error) throw available.error
        if (available.data !== true) return
        if (remembered(userId)) { done = true; void persistReceipt(userId); return }
        const receipt = await supabase.from('account_announcement_receipts').select('announcement_id')
          .eq('user_id', userId).eq('announcement_id', ANNOUNCEMENT_ID).maybeSingle()
        if (!current) return
        if (receipt.error) throw receipt.error
        if (receipt.data) {
          done = true
          seenThisSession.add(userId)
          try { localStorage.setItem(receiptKey(userId), 'seen') } catch { /* Optional cache of the server receipt. */ }
          return
        }
        // A new display requires a successful server receipt read. Unknown
        // state must not repeat a notice already viewed on another device.
        done = true
        setCandidate(true)
      } catch {
        // A temporary lost connection must not consume the announcement or
        // require signing in again. Retries are short and bounded.
        if (current && attempts < 3 && !retryTimer) {
          retryTimer = setTimeout(() => { retryTimer = null; void check() }, attempts === 1 ? 1500 : 5000)
        }
      } finally { busy = false }
    }
    const resume = () => {
      if (document.visibilityState !== 'visible') return
      if (done) {
        // Synchronize a previously displayed local receipt after reconnection.
        if (remembered(userId)) void persistReceipt(userId)
        return
      }
      attempts = 0
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      void check()
    }
    void check()
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      current = false
      if (retryTimer) clearTimeout(retryTimer)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [userId])

  useEffect(() => {
    if (!candidate || open || displayed.current) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const canDisplay = () => document.visibilityState === 'visible' && !Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]'))
      .some((dialog) => dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden')
    const schedule = () => {
      if (!canDisplay()) { if (timer) clearTimeout(timer); timer = null; return }
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (!canDisplay() || remembered(userId)) return
        setOpen(true)
      }, 600)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'hidden'] })
    document.addEventListener('visibilitychange', schedule)
    window.addEventListener('storage', schedule)
    schedule()
    return () => { if (timer) clearTimeout(timer); observer.disconnect(); document.removeEventListener('visibilitychange', schedule); window.removeEventListener('storage', schedule) }
  }, [candidate, open, userId])

  const onDisplayed = useCallback(() => {
    if (displayed.current) return
    displayed.current = true
    // Record only when the dialog has actually mounted in a visible tab.
    // Loading, auth, recovery, MFA and onboarding do not consume the notice.
    remember(userId)
  }, [userId])

  return open ? <FreeGroupsNotice onDisplayed={onDisplayed} onClose={() => setOpen(false)} onOpenGroups={() => {
    setOpen(false)
    void navigate({ to: '/groups' })
  }} /> : null
}

function FreeGroupsNotice({ onDisplayed, onClose, onOpenGroups }: {
  onDisplayed: () => void
  onClose: () => void
  onOpenGroups: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus({ preventScroll: true })
    let firstFrame = 0
    let paintedFrame = 0
    const recordVisibleDisplay = () => {
      if (document.visibilityState !== 'visible') return
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(paintedFrame)
      // Wait until the card has reached a painted frame. A background tab or
      // an interrupted mount must leave the announcement available next time.
      firstFrame = requestAnimationFrame(() => {
        paintedFrame = requestAnimationFrame(() => {
          if (document.visibilityState === 'visible' && dialogRef.current?.isConnected) onDisplayed()
        })
      })
    }
    recordVisibleDisplay()
    document.addEventListener('visibilitychange', recordVisibleDisplay)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || [])
        .filter((button) => button.getClientRects().length > 0)
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      const outside = !buttons.includes(document.activeElement as HTMLButtonElement)
      if (!first || !last) { event.preventDefault(); dialogRef.current?.focus(); return }
      if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('visibilitychange', recordVisibleDisplay)
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(paintedFrame)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [onDisplayed])

  return createPortal(<div className="xelay-free-groups-overlay fixed inset-0 z-[105] flex items-center justify-center overflow-y-auto bg-black/40 px-4 py-5 backdrop-blur-sm"
    onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
      className="xelay-free-groups-card relative my-auto w-full min-w-0 max-w-md overflow-hidden rounded-[28px] border border-primary/15 bg-card p-5 shadow-2xl outline-none sm:p-7">
      <button type="button" onClick={onClose} aria-label="Закрити повідомлення" className="absolute right-2 top-2 z-10 flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><X size={18} /></button>
      <div className="xelay-free-groups-sparks" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => {
        const angle = index * Math.PI / 4
        const style = { '--free-x': `${Math.round(Math.cos(angle) * 105)}px`, '--free-y': `${Math.round(Math.sin(angle) * 85)}px`, '--free-delay': `${120 + (index % 3) * 70}ms` } as CSSProperties
        return <span key={index} style={style}><Sparkles size={index % 2 ? 13 : 17} /></span>
      })}</div>
      <div className="relative">
        <div className="relative mx-auto mb-4 mt-2 flex h-20 w-20 items-center justify-center">
          <span className="xelay-free-groups-ring absolute inset-0 rounded-3xl border border-primary/20" aria-hidden="true" />
          <span className="xelay-free-groups-icon relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-primary/15 to-rose-100/25 text-primary"><UsersRound size={37} strokeWidth={1.6} aria-hidden="true" /></span>
          <span className="xelay-free-groups-check absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border-[3px] border-card bg-primary text-primary-foreground"><Check size={14} strokeWidth={3} aria-hidden="true" /></span>
        </div>
        <p className="text-center text-xs font-medium text-primary">Для всіх груп · безстроково</p>
        <h2 id={titleId} className="mt-2 text-center text-2xl font-semibold leading-tight tracking-tight sm:text-[27px]">Навчальні групи —<br />тепер безкоштовні</h2>
        <p id={descriptionId} className="mx-auto mt-3 max-w-xs text-center text-sm leading-6 text-muted-foreground">Без оплат і пробних періодів. Усе потрібне для навчання вашої групи — в одному місці.</p>
        <div className="xelay-free-groups-features mt-5 grid min-w-0 grid-cols-2 gap-2 text-xs sm:text-sm">{[
          { icon: CalendarDays, label: 'Розклад і ДЗ' },
          { icon: BookOpen, label: 'Семінари' },
          { icon: FileText, label: 'Матеріали' },
          { icon: UsersRound, label: 'Спільна робота' },
        ].map(({ icon: Icon, label }) => <span key={label} className="flex min-w-0 items-center gap-2 rounded-xl border border-primary/10 bg-primary/[0.035] px-3 py-2.5"><Icon size={16} className="shrink-0 text-primary" aria-hidden="true" /><span className="min-w-0 break-words">{label}</span></span>)}</div>
        <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">Приватність і права старости та заступників збережено. Підписка «Учасник» залишається окремою.</p>
        <button type="button" onClick={onOpenGroups} className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">До навчальних груп<ArrowRight size={17} aria-hidden="true" /></button>
        <button type="button" onClick={onClose} className="mt-2 min-h-10 w-full rounded-2xl text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">Зрозуміло, дякую</button>
      </div>
    </div>
  </div>, document.body)
}
