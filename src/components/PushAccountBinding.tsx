import { useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { bindPushOwner, supportsParticipantPush } from '../lib/participantPush'

function savedOwner() { try { return localStorage.getItem('xelay.push.owner') } catch { return null } }

// Keeps lock-screen reminders bound to the active account on this browser.
export function PushAccountBinding() {
  const { authUser, isLoading } = useAuth()
  const ownerRef = useRef(authUser?.id || null)
  ownerRef.current = authUser?.id || null
  const previousOwner = useRef<string | null>(savedOwner())
  useEffect(() => {
    if (isLoading || !supportsParticipantPush()) return
    let active = true
    const owner = authUser?.id || null
    const sync = async () => {
      const registration = await navigator.serviceWorker.getRegistration('/')
      if (!active || !registration?.active) return
      await bindPushOwner(registration, null)
      if (!active || ownerRef.current !== owner) return
      if (!owner || previousOwner.current !== owner) {
        const subscription = await registration.pushManager.getSubscription()
        await subscription?.unsubscribe()
      }
      await bindPushOwner(registration, owner)
      previousOwner.current = owner
    }
    void sync().catch(() => { /* Missing/blocked worker never affects login. */ })
    return () => { active = false }
  }, [authUser?.id, isLoading])
  return null
}
