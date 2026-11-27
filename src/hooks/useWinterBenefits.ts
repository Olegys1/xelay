import { useCallback, useEffect, useRef, useState } from 'react'
import { requestWinterBenefits } from '../lib/winterBenefitsClient'
import type { WinterBenefitAction, WinterBenefitsState } from '../lib/winterBenefits'
import { acceptWinterFriendCoupon, createWinterSubscriptionCheckout, getWinterBillingOffers, issueWinterFriendCoupon, openHostedCheckout, quoteWinterSubscription, reconcilePayment, type WinterBillingOffers, type WinterSubscriptionSelection } from '../lib/billing'
import { WINTER_BENEFITS_TERMS_VERSION } from '../lib/aiCreditTerms'

const messageOf = (cause: unknown) => cause instanceof Error && cause.name !== 'AbortError' ? cause.message : 'Не вдалося перевірити подарунки. Оновіть статус перед повторною дією.'

/** Isolated from the advent clock: a failed wallet fetch never rolls back a saved day. */
export function useWinterBenefits(userId: string | null, disabled = false) {
  const owner = useRef(userId); owner.current = userId
  const enabled = useRef(!disabled); enabled.current = !disabled
  const stateOwner = useRef<string | null>(null), offersOwner = useRef<string | null>(null)
  const epoch = useRef(0)
  const active = useRef<AbortController | null>(null)
  const operation = useRef(false)
  const queued = useRef(false)
  const [state, setState] = useState<WinterBenefitsState | null>(null)
  const [offers, setOffers] = useState<WinterBillingOffers | null>(null)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const account = owner.current, version = epoch.current
    if (!account || !enabled.current) return
    if (operation.current || active.current) { queued.current = true; return }
    const controller = new AbortController(); active.current = controller
    const timer = window.setTimeout(() => controller.abort(), 15_000)
    setLoading(true); setError('')
    const results = await Promise.allSettled([requestWinterBenefits(account, undefined, controller.signal), getWinterBillingOffers(account)])
    window.clearTimeout(timer)
    if (epoch.current !== version || owner.current !== account) return
    active.current = null; setLoading(false)
    const [wallet, prices] = results
    if (wallet.status === 'fulfilled') { stateOwner.current = account; setState(wallet.value) }
    if (prices.status === 'fulfilled') { offersOwner.current = account; setOffers(prices.value) }
    const errors = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map(item => messageOf(item.reason))
    if (errors.length) setError([...new Set(errors)].join(' '))
    if (queued.current) { queued.current = false; void load() }
  }, [])
  useEffect(() => {
    ++epoch.current; active.current?.abort(); active.current = null; operation.current = false; queued.current = false
    stateOwner.current = null; offersOwner.current = null
    setState(null); setOffers(null); setError(''); setPending(false); setLoading(false)
    if (userId && !disabled) void load()
    return () => { ++epoch.current; active.current?.abort(); active.current = null; queued.current = false }
  }, [userId, disabled, load])
  useEffect(() => {
    if (!userId || disabled) return
    const online = () => { void load() }
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [userId, disabled, load])
  const execute = useCallback(async <T,>(task: (account: string, stillCurrent: () => boolean) => Promise<T>, refreshAfter = false): Promise<T> => {
    const account = owner.current, version = epoch.current
    if (!account || !enabled.current) throw new Error('Увійдіть у свій акаунт.')
    if (operation.current || active.current) throw new Error('Попередня дія ще триває. Зачекайте кілька секунд.')
    operation.current = true; setPending(true); setError('')
    const stillCurrent = () => owner.current === account && epoch.current === version
    try {
      const value = await task(account, stillCurrent)
      if (!stillCurrent()) throw new Error('Акаунт змінився. Подарунки потрібно перевірити повторно.')
      if (refreshAfter) queued.current = true
      return value
    } catch (cause) {
      if (stillCurrent()) setError(messageOf(cause))
      throw cause
    } finally {
      if (stillCurrent()) {
        operation.current = false; setPending(false)
        if (queued.current) { queued.current = false; void load() }
      }
    }
  }, [load])
  const onAction = useCallback(async (action: WinterBenefitAction) => {
    await execute(async (account, stillCurrent) => {
      const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 15_000)
      try { const value = await requestWinterBenefits(account, action, controller.signal); if (stillCurrent()) { stateOwner.current = account; setState(value) } }
      finally { window.clearTimeout(timer) }
    }, true)
  }, [execute])
  const onQuote = useCallback((selection: WinterSubscriptionSelection) => execute(account => quoteWinterSubscription(selection, account)), [execute])
  const onCheckout = useCallback(async (selection: WinterSubscriptionSelection) => {
    await execute(async (account, stillCurrent) => {
      const checkout = await createWinterSubscriptionCheckout({ ...selection, acceptedTerms: true, termsVersion: WINTER_BENEFITS_TERMS_VERSION }, account)
      if (!stillCurrent()) throw new Error('Акаунт змінився. Оплату не відкрито.')
      openHostedCheckout(checkout.checkout)
    }, true)
  }, [execute])
  const onCheckPayment = useCallback(async (reference: string) => { await execute(account => reconcilePayment(reference, account), true) }, [execute])
  const onIssueFriend = useCallback(() => execute(account => issueWinterFriendCoupon(account), true), [execute])
  const onAcceptFriend = useCallback((token: string) => execute(account => acceptWinterFriendCoupon(token, account), true), [execute])
  const refresh = useCallback(() => { void load() }, [load])
  return { state: !disabled && stateOwner.current === userId ? state : null, offers: !disabled && offersOwner.current === userId ? offers : null, loading, pending, error, onRefresh: refresh, onAction, onQuote, onCheckout, onCheckPayment, onIssueFriend, onAcceptFriend }
}
