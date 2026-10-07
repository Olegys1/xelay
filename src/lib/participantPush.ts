import { supabase } from './supabase'

export function supportsParticipantPush() {
  return typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}
export async function pushRequest(path: string, options: RequestInit = {}, expectedOwner?: string) {
  const { data: { session }, error } = await supabase.auth.getSession()
  if (expectedOwner && (error || session?.user.id !== expectedOwner)) throw new Error('Акаунт змінився. Оновіть сторінку.')
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) } })
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Фонові нагадування ще не підключені.')
  const payload = await response.json()
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Не вдалося налаштувати нагадування.')
  const { data: after } = await supabase.auth.getSession()
  if (expectedOwner && after.session?.user.id !== expectedOwner) throw new Error('Акаунт змінився. Оновіть сторінку.')
  return payload
}
export async function bindPushOwner(registration: ServiceWorkerRegistration, userId: string | null) {
  const worker = registration.active
  if (!worker) throw new Error('Нагадування ще запускаються. Спробуйте ще раз.')
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel()
    const timeout = window.setTimeout(() => { channel.port1.close(); reject(new Error('Не вдалося підключити нагадування до акаунта.')) }, 4000)
    channel.port1.onmessage = () => { window.clearTimeout(timeout); channel.port1.close(); resolve() }
    worker.postMessage({ type: 'XELAY_PUSH_OWNER', userId }, [channel.port2])
  })
  try { if (userId) localStorage.setItem('xelay.push.owner', userId); else localStorage.removeItem('xelay.push.owner') } catch { /* Worker storage still enforces the binding. */ }
}
export function vapidApplicationKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + '='.repeat((4 - value.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}
