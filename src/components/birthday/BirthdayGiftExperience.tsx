import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useBilling } from '../../context/BillingContext'
import { useNotificationPreferences } from '../../context/NotificationPreferencesContext'
import { useToast } from '../../context/ToastContext'
import { BIRTHDAY_GIFT_EVENT, BIRTHDAY_REFRESH_EVENT, claimBirthdayGift, loadBirthdayGifts, type BirthdayGift } from '../../lib/birthdayGifts'
import { BirthdayGiftCard } from './BirthdayGiftCard'
import { AppreciationGiftExperience } from '../community/AppreciationGiftExperience'

const dismissedKey = (user: string, gift: string) => `xelay:birthday-dismissed:${user}:${gift}`
function dismissed(user: string, gift: string) { try { return sessionStorage.getItem(dismissedKey(user, gift)) === '1' } catch { return false } }
export function BirthdayGiftExperience({ blocked = false }: { blocked?: boolean }) {
  const [appreciationReady, setAppreciationReady] = useState(false)
  const birthdayAvailability = useCallback((ready: boolean, open: boolean) => setAppreciationReady(ready && !open), [])
  return <><BirthdayGiftInbox blocked={blocked} onAvailability={birthdayAvailability} /><AppreciationGiftExperience blocked={blocked || !appreciationReady} /></>
}

export function BirthdayGiftInbox({ blocked = false, onAvailability }: { blocked?: boolean; onAvailability?: (ready: boolean, open: boolean) => void }) {
  const { authUser } = useAuth()
  const { refreshBilling } = useBilling()
  const { notify } = useToast()
  const notification = useRef(notify); notification.current = notify
  const { preferences, loading: preferencesLoading } = useNotificationPreferences()
  const userId = authUser?.id || ''
  const owner = useRef(userId); owner.current = userId
  const automatic = useRef(false); automatic.current = !preferencesLoading && preferences.notificationsEnabled
  const explicitlyOpened = useRef(false)
  const dismissedForAvailability = useRef(false)
  const [snapshot, setSnapshot] = useState<{ owner: string; gifts: BirthdayGift[]; openId: string | null }>({ owner: '', gifts: [], openId: null })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [celebrating, setCelebrating] = useState(false)
  const [loadedOwner, setLoadedOwner] = useState<string | null>(null)
  const locked = useRef(false), alive = useRef(false), generation = useRef(0)
  const readRequest = useRef<AbortController | null>(null), claimRequest = useRef<AbortController | null>(null)
  const open = useRef<string | null>(null); open.current = snapshot.owner === userId ? snapshot.openId : null
  const selection = snapshot.owner === userId ? snapshot.gifts.find(gift => gift.id === snapshot.openId) : undefined
  const visible = !blocked && Boolean(selection) && (automatic.current || explicitlyOpened.current)
  const birthdayWaiting = !dismissedForAvailability.current && automatic.current && snapshot.owner === userId && snapshot.gifts.some(gift => !gift.claimed_at && !dismissed(userId, gift.id))
  useEffect(() => { onAvailability?.(!blocked && !preferencesLoading && loadedOwner === userId, visible || birthdayWaiting) }, [blocked, preferencesLoading, loadedOwner, userId, visible, birthdayWaiting, onAvailability])
  useEffect(() => {
    alive.current = true; const actor = userId
    setSnapshot({ owner: actor, gifts: [], openId: null }); setLoadedOwner(null); setBusy(false); setError(''); setCelebrating(false); locked.current = false; explicitlyOpened.current = false; dismissedForAvailability.current = false
    if (!actor || blocked) return () => { alive.current = false }
    let lastLoaded = 0
    const refresh = async (notificationId?: string) => {
      if (locked.current || owner.current !== actor) return
      readRequest.current?.abort()
      const controller = new AbortController(); readRequest.current = controller; const sequence = ++generation.current
      try {
        const gifts = await loadBirthdayGifts(actor, controller.signal)
        if (!alive.current || controller.signal.aborted || owner.current !== actor || sequence !== generation.current) return
        lastLoaded = Date.now()
        const requested = notificationId ? gifts.find(gift => gift.notification_id === notificationId) : undefined
        if (notificationId && !requested) notification.current({ id: 'birthday-gift', title: 'Подарунок недоступний', description: 'Оновіть сповіщення та перевірте, що ви увійшли у свій акаунт.', tone: 'error' })
        const retained = open.current ? gifts.find(gift => gift.id === open.current) : undefined
        const pending = automatic.current ? gifts.find(gift => !gift.claimed_at && !dismissed(actor, gift.id)) : undefined
        setSnapshot({ owner: actor, gifts, openId: requested?.id || retained?.id || pending?.id || null })
        setLoadedOwner(actor)
        setError('')
      } catch {
        // A gift is optional; an unavailable check never interrupts the app.
        if (alive.current && owner.current === actor && !controller.signal.aborted && sequence === generation.current) setLoadedOwner(actor)
        if (notificationId && alive.current && owner.current === actor && !controller.signal.aborted) {
          notification.current({ id: 'birthday-gift', title: 'Не вдалося відкрити подарунок', description: 'Перевірте з’єднання й відкрийте сповіщення ще раз.', tone: 'error' })
        }
      } finally { if (readRequest.current === controller) readRequest.current = null }
    }
    const onFocus = () => { if (document.visibilityState === 'visible' && Date.now() - lastLoaded > 60000) void refresh() }
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; notificationId?: string }>).detail
      if (detail?.userId === actor && detail.notificationId) { explicitlyOpened.current = true; void refresh(detail.notificationId) }
    }
    const onRefresh = (event: Event) => { if ((event as CustomEvent<{ userId?: string }>).detail?.userId === actor) void refresh() }
    void refresh()
    window.addEventListener('focus', onFocus); window.addEventListener('online', onFocus)
    window.addEventListener(BIRTHDAY_GIFT_EVENT, onOpen); window.addEventListener(BIRTHDAY_REFRESH_EVENT, onRefresh)
    return () => {
      alive.current = false; ++generation.current; readRequest.current?.abort(); claimRequest.current?.abort()
      window.removeEventListener('focus', onFocus); window.removeEventListener('online', onFocus)
      window.removeEventListener(BIRTHDAY_GIFT_EVENT, onOpen); window.removeEventListener(BIRTHDAY_REFRESH_EVENT, onRefresh)
    }
  }, [userId, blocked])
  useEffect(() => {
    if (blocked || preferencesLoading || !preferences.notificationsEnabled || !userId) return
    setSnapshot(current => {
      if (current.owner !== userId || current.openId) return current
      const pending = current.gifts.find(gift => !gift.claimed_at && !dismissed(userId, gift.id))
      return pending ? { ...current, openId: pending.id } : current
    })
  }, [userId, blocked, preferencesLoading, preferences.notificationsEnabled])
  useEffect(() => {
    if (!celebrating) return
    const timer = window.setTimeout(() => setCelebrating(false), 3000)
    return () => window.clearTimeout(timer)
  }, [celebrating])
  const close = () => {
    if (locked.current) return
    if (selection) { try { sessionStorage.setItem(dismissedKey(userId, selection.id), '1') } catch { /* Session dismissal is optional. */ } }
    explicitlyOpened.current = false
    dismissedForAvailability.current = true
    setSnapshot(current => ({ ...current, openId: null })); setError(''); setCelebrating(false)
  }
  async function claim() {
    if (!selection || selection.claimed_at || locked.current || !userId || blocked) return
    const actor = userId, giftId = selection.id
    locked.current = true; ++generation.current; readRequest.current?.abort()
    const controller = new AbortController(); claimRequest.current = controller
    setBusy(true); setError(''); setCelebrating(false)
    try {
      const gift = await claimBirthdayGift(actor, giftId, controller.signal)
      if (!alive.current || owner.current !== actor || controller.signal.aborted) return
      setSnapshot(current => current.owner !== actor ? current : { ...current, gifts: current.gifts.map(item => item.id === gift.id ? gift : item), openId: gift.id })
      setCelebrating(gift.newly_claimed)
      void refreshBilling()
      window.dispatchEvent(new CustomEvent('xelay-notifications-updated', { detail: { userId: actor } }))
    } catch (problem) {
      if (alive.current && owner.current === actor && !controller.signal.aborted) setError(problem instanceof Error ? problem.message : 'Не вдалося забрати подарунок. Спробуйте ще раз.')
    } finally {
      if (claimRequest.current === controller) {
        claimRequest.current = null
        if (alive.current && owner.current === actor) { locked.current = false; setBusy(false) }
      }
    }
  }
  if (!visible || !selection) return null
  return <aside className="fixed inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[65] mx-auto max-h-[calc(100dvh-2rem)] max-w-[420px] overflow-y-auto overscroll-contain rounded-[28px] sm:left-auto sm:right-5 sm:mx-0 sm:w-[390px]" aria-label="Подарунок від Xelay">
    <BirthdayGiftCard recipientName={selection.recipient_name} claimedAt={selection.claimed_at} validUntil={selection.valid_until} busy={busy} error={error} celebrating={celebrating} onClaim={claim} onClose={close} />
  </aside>
}
