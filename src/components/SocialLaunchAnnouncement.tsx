import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouterState } from '@tanstack/react-router'
import { ArrowUpRight, Music2, Send, Sparkles, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useOnboarding } from '../context/OnboardingContext'
import { supabase } from '../lib/supabase'
import { ANNOUNCEMENT_SLOT_RELEASED, acquireAnnouncementSlot, releaseAnnouncementSlot } from '../lib/announcementSlot'
import './socialLaunchAnnouncement.css'

export const SOCIAL_LAUNCH_START = Date.parse('2026-10-15T10:10:00Z')
const ANNOUNCEMENT_ID = 'social-launch-2026-10-15'
const seenThisSession = new Set<string>()
const receiptKey = (userId: string) => `xelay:announcement:${ANNOUNCEMENT_ID}:${userId}`

function Instagram({ size = 24, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r=".7" fill="currentColor" stroke="none" /></svg>
}

function remembered(userId: string) {
  if (seenThisSession.has(userId)) return true
  try { return localStorage.getItem(receiptKey(userId)) === 'seen' } catch { return false }
}

async function persistReceipt(userId: string) {
  try {
    await supabase.from('account_announcement_receipts').upsert({ user_id: userId, announcement_id: ANNOUNCEMENT_ID }, {
      onConflict: 'user_id,announcement_id', ignoreDuplicates: true,
    })
  } catch { /* The local receipt remains available when the connection is lost. */ }
}

function cacheReceipt(userId: string) {
  seenThisSession.add(userId)
  try { localStorage.setItem(receiptKey(userId), 'seen') } catch { /* Keep the in-memory receipt. */ }
}

export function SocialLaunchAnnouncement({ blocked = false }: { blocked?: boolean }) {
  const { authUser, xelayUser, isLoading, isPasswordRecovery } = useAuth()
  const { suspended } = useOnboarding()
  const paymentReturn = useRouterState({ select: (state) =>
    (state.location.pathname === '/support' || state.location.pathname === '/subscription')
      && new URLSearchParams(state.location.searchStr).has('orderReference') })
  const ready = Boolean(authUser && xelayUser?.id === authUser.id && !isLoading && !isPasswordRecovery && !blocked && !suspended && !paymentReturn)
  return ready && authUser ? <AccountSocialAnnouncement key={authUser.id} userId={authUser.id} /> : null
}

function AccountSocialAnnouncement({ userId }: { userId: string }) {
  const [candidate, setCandidate] = useState(false)
  const [open, setOpen] = useState(false)
  const displayed = useRef(false)
  const slotOwner = `${ANNOUNCEMENT_ID}:${userId}`

  useEffect(() => () => releaseAnnouncementSlot(slotOwner), [slotOwner])
  useEffect(() => { if (!open) releaseAnnouncementSlot(slotOwner) }, [open, slotOwner])

  useEffect(() => {
    let current = true
    let busy = false
    let done = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const later = (delay: number) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void check() }, delay)
    }
    const check = async () => {
      if (!current || busy || done) return
      const remaining = SOCIAL_LAUNCH_START - Date.now()
      if (remaining > 0) { later(Math.min(remaining, 2_147_483_647)); return }
      if (document.visibilityState !== 'visible') return
      busy = true
      try {
        // The server clock also gates launch, including devices with an incorrect clock.
        const available = await supabase.rpc('xelay_social_launch_available')
        if (!current) return
        if (available.error) throw available.error
        if (available.data !== true) { later(15_000); return }
        if (remembered(userId)) { done = true; void persistReceipt(userId); return }
        const receipt = await supabase.from('account_announcement_receipts').select('announcement_id')
          .eq('user_id', userId).eq('announcement_id', ANNOUNCEMENT_ID).maybeSingle()
        if (!current) return
        if (receipt.error) throw receipt.error
        if (receipt.data) { done = true; cacheReceipt(userId); return }
        done = true
        setCandidate(true)
      } catch {
        attempts += 1
        if (current && attempts < 3) later(attempts === 1 ? 1500 : 5000)
      } finally { busy = false }
    }
    const resume = () => {
      if (document.visibilityState !== 'visible') return
      if (done) {
        if (remembered(userId)) void persistReceipt(userId)
        return
      }
      attempts = 0
      if (timer) clearTimeout(timer)
      timer = null
      void check()
    }
    void check()
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      current = false
      if (timer) clearTimeout(timer)
      window.removeEventListener('online', resume)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [userId])

  useEffect(() => {
    if (!candidate || open || displayed.current) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const canDisplay = () => document.visibilityState === 'visible' && !Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]'))
      .some((dialog) => dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden')
    const schedule = () => {
      if (!canDisplay()) { if (timer) clearTimeout(timer); timer = null; return }
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (!canDisplay() || remembered(userId) || !acquireAnnouncementSlot(slotOwner)) return
        setOpen(true)
      }, 900)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'hidden', 'open', 'class', 'style'] })
    window.addEventListener(ANNOUNCEMENT_SLOT_RELEASED, schedule)
    document.addEventListener('visibilitychange', schedule)
    window.addEventListener('storage', schedule)
    schedule()
    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
      window.removeEventListener(ANNOUNCEMENT_SLOT_RELEASED, schedule)
      document.removeEventListener('visibilitychange', schedule)
      window.removeEventListener('storage', schedule)
    }
  }, [candidate, open, slotOwner, userId])

  const onDisplayed = useCallback(() => {
    if (displayed.current) return
    displayed.current = true
    cacheReceipt(userId)
    void persistReceipt(userId)
  }, [userId])

  return open ? <SocialLaunchNotice onDisplayed={onDisplayed} onClose={() => setOpen(false)} /> : null
}

export function SocialLaunchNotice({ onDisplayed, onClose }: { onDisplayed: () => void; onClose: () => void }) {
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
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]') || [])
        .filter((element) => element.getClientRects().length > 0)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const outside = !focusable.includes(document.activeElement as HTMLElement)
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

  return createPortal(<div className="xelay-social-launch-overlay fixed inset-0 z-[105] flex items-center justify-center overflow-y-auto bg-black/40 px-4 py-5 backdrop-blur-sm"
    onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
      className="xelay-social-launch-card relative my-auto w-full min-w-0 max-w-md overflow-hidden rounded-[28px] border border-primary/15 bg-card p-5 shadow-2xl outline-none sm:p-7">
      <div className="xelay-social-launch-glow" aria-hidden="true" />
      <button type="button" onClick={onClose} aria-label="Закрити повідомлення" className="absolute right-2 top-2 z-10 flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><X size={18} aria-hidden="true" /></button>
      <div className="relative">
        <div className="mx-auto mb-4 mt-2 flex h-16 w-16 items-center justify-center rounded-[22px] border border-primary/10 bg-primary/[0.07] text-primary"><Sparkles size={29} strokeWidth={1.5} aria-hidden="true" /></div>
        <p className="text-center text-xs font-medium tracking-wide text-primary">Ще ближче до спільноти</p>
        <h2 id={titleId} className="mx-auto mt-2 max-w-xs text-center text-2xl font-semibold leading-tight tracking-tight sm:text-[27px]">Xelay тепер<br />у соцмережах</h2>
        <p id={descriptionId} className="mx-auto mt-3 max-w-sm text-center text-sm leading-6 text-muted-foreground">Ми запустили наші соцмережі! Підписуйтеся, щоб першими дізнаватися про оновлення Xelay, нові можливості та життя нашої спільноти.</p>
        <div className="xelay-social-launch-links mt-5 flex flex-col gap-2.5">
          {[
            { name: 'Telegram', handle: '@xelayknu', icon: Send, href: 'https://t.me/xelayknu', style: 'telegram' },
            { name: 'Instagram', handle: '@xelay.knu', icon: Instagram, href: 'https://www.instagram.com/xelay.knu/', style: 'instagram' },
            { name: 'TikTok', handle: '@xelayknu', icon: Music2, href: 'https://www.tiktok.com/@xelayknu', style: 'tiktok' },
          ].map(({ name, handle, icon: Icon, href, style }) => <a key={name} href={href} target="_blank" rel="noopener noreferrer" aria-label={`${name} ${handle} — відкрити в новій вкладці`}
            className="xelay-social-launch-link flex min-h-16 items-center gap-3 rounded-2xl border border-border bg-background/60 px-3.5 py-3 transition-colors hover:border-primary/35 hover:bg-primary/[0.035] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            <span className={`xelay-social-launch-brand xelay-social-launch-brand-${style}`}><Icon size={21} strokeWidth={1.7} aria-hidden="true" /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-foreground">{name}</span><span className="block text-xs leading-5 text-muted-foreground">{handle}</span></span>
            <ArrowUpRight size={18} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          </a>)}
        </div>
        <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">Побачимося у стрічці 💛</p>
        <button type="button" onClick={onClose} className="mt-4 flex min-h-11 w-full items-center justify-center rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">Продовжити в Xelay</button>
      </div>
    </div>
  </div>, document.body)
}
