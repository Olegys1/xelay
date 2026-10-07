import { useEffect, useRef, useState } from 'react'
import { BellRing, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import { useNotificationPreferences } from '../context/NotificationPreferencesContext'
import { bindPushOwner, pushRequest, supportsParticipantPush, vapidApplicationKey } from '../lib/participantPush'

export function PushReminderSettings() {
  const { authUser } = useAuth()
  const { isPremium, isLoading: billingLoading } = useBilling()
  const { preferences } = useNotificationPreferences()
  const [available, setAvailable] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const publicKey = useRef<string | null>(null)
  const owner = useRef(authUser?.id)
  owner.current = authUser?.id
  const lock = useRef(false)
  const supported = supportsParticipantPush()
  useEffect(() => {
    let active = true
    const actor = authUser?.id
    setSubscribed(false); setAvailable(false); setError(''); setNotice(''); setLoading(true); setBusy(false)
    const load = async () => {
      try {
        if (!supported || !actor) return
        const configuration = await pushRequest('/api/participant/push', {}, actor)
        if (!active) return
        publicKey.current = configuration.publicKey
        setAvailable(configuration.available === true)
        const registration = await navigator.serviceWorker.getRegistration('/')
        const subscription = await registration?.pushManager.getSubscription()
        if (subscription) {
          const status = await pushRequest('/api/participant/push', { method: 'POST', body: JSON.stringify({ operation: 'status', endpoint: subscription.endpoint }) }, actor)
          if (active) setSubscribed(status.subscribed === true)
        }
      } catch { /* Available=false gives a clear configuration message without repeated error toasts. */ }
      finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [authUser?.id, supported])
  const toggle = async () => {
    if (!authUser || lock.current || (!subscribed && (!isPremium || !available || !preferences.notificationsEnabled))) return
    const actor = authUser.id
    lock.current = true; setBusy(true); setError(''); setNotice('')
    let newlyCreated: PushSubscription | null = null
    try {
      // Safari requires the permission prompt to start within the click gesture.
      const permission = subscribed ? 'granted' : await Notification.requestPermission()
      if (owner.current !== actor) return
      if (permission !== 'granted') throw new Error('Сповіщення заборонені. Дозвольте їх у налаштуваннях браузера.')
      const registration = await navigator.serviceWorker.register('/push-sw.js', { scope: '/' })
      await navigator.serviceWorker.ready
      if (owner.current !== actor) return
      const previous = await registration.pushManager.getSubscription()
      if (subscribed) {
        if (previous) {
          await pushRequest('/api/participant/push', { method: 'DELETE', body: JSON.stringify({ endpoint: previous.endpoint }) }, actor)
          await previous.unsubscribe()
        }
        await bindPushOwner(registration, null)
        if (owner.current === actor) { setSubscribed(false); setNotice('Push-нагадування вимкнено на цьому пристрої.') }
      } else {
        if (!publicKey.current) throw new Error('Фонові нагадування ще не підключені.')
        const subscription = previous || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidApplicationKey(publicKey.current) })
        if (!previous) newlyCreated = subscription
        if (owner.current !== actor) { await subscription.unsubscribe(); return }
        await bindPushOwner(registration, actor)
        await pushRequest('/api/participant/push', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON(), label: 'Браузер Xelay' }) }, actor)
        if (owner.current === actor) { setSubscribed(true); setNotice('Push-нагадування ввімкнено на цьому пристрої.') }
      }
    } catch (reason) {
      if (newlyCreated) await newlyCreated.unsubscribe().catch(() => false)
      if (owner.current === actor) setError(reason instanceof Error ? reason.message : 'Не вдалося налаштувати нагадування.')
    } finally { lock.current = false; if (owner.current === actor) setBusy(false) }
  }
  return <div className="mt-4 rounded-2xl border border-border bg-background/70 p-4" id="participant-push">
    <p className="flex items-center gap-2 text-sm font-semibold"><BellRing size={16} className="text-primary" />Нагадування, коли Xelay закритий</p>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Лише ваші особисті задачі. Потрібні активна підписка, дозвіл браузера й інтернет. На iPhone/iPad додайте Xelay на головний екран і відкрийте звідти.</p>
    {!supported ? <p className="mt-2 text-xs text-muted-foreground">Цей браузер не підтримує push. Нагадування всередині Xelay залишаються доступними.</p>
      : <><button type="button" disabled={busy || loading || billingLoading || (!subscribed && (!available || !isPremium || !preferences.notificationsEnabled))} onClick={() => void toggle()}
        className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-full border border-primary/20 px-4 text-xs font-semibold text-primary disabled:opacity-50">{(busy || loading) && <Loader2 size={14} className="animate-spin" />}{subscribed ? 'Вимкнути на цьому пристрої' : 'Увімкнути на цьому пристрої'}</button>
        {!loading && !available && <p className="mt-2 text-xs text-muted-foreground">Фонові нагадування ще підключаються.</p>}
        {!preferences.notificationsEnabled && <p className="mt-2 text-xs text-muted-foreground">Спочатку ввімкніть сповіщення Xelay у налаштуваннях дзвіночка.</p>}
      </>}
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-2 text-xs text-primary">{notice}</p>}
  </div>
}
