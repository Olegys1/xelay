/* Only handles notifications. No page, auth, or private-data cache. */
const STORE = 'owner'
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('xelay-push-binding', 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function binding(next) {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, next === undefined ? 'readonly' : 'readwrite')
      const store = transaction.objectStore(STORE)
      const request = next === undefined ? store.get('current') : store.put(next, 'current')
      let result = null
      request.onsuccess = () => { result = request.result }
      transaction.oncomplete = () => resolve(next === undefined ? result : next)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { db.close() }
}
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'XELAY_PUSH_OWNER') return
  const owner = typeof event.data.userId === 'string' && /^[0-9a-f-]{36}$/i.test(event.data.userId) ? event.data.userId : null
  event.waitUntil((async () => {
    // Messages are accepted only from a page controlled on our own origin.
    if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return
    await binding(owner)
    if (!owner) for (const item of await self.registration.getNotifications()) item.close()
    event.ports?.[0]?.postMessage({ bound: true })
  })())
})
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data
    try { data = event.data?.json() } catch { return }
    if (!data || data.userId !== await binding() || data.path !== '/organizer'
      || typeof data.tag !== 'string' || !/^organizer-[0-9a-f-]{36}$/i.test(data.tag)) return
    await self.registration.showNotification('Нагадування Xelay', {
      body: 'У вас є нагадування в особистому органайзері.', icon: '/icons/xelay-app-20261008-192.png',
      tag: data.tag, renotify: false, data: { path: '/organizer', userId: data.userId },
    })
  })())
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    if (event.notification.data?.userId !== await binding()) return
    const target = new URL('/organizer', self.location.origin).href
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const page of pages) if (new URL(page.url).origin === self.location.origin) {
      await page.navigate(target)
      await page.focus()
      return
    }
    await self.clients.openWindow(target)
  })())
})
