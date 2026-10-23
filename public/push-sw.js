/* The shell cache contains public application code only. Auth/API/user files are never cached here. */
const SHELL_BUILD_ID = '__XELAY_OFFLINE_SHELL_BUILD_ID__'
const SHELL_CACHE_PREFIX = 'xelay-public-shell-'
const SHELL_META = new URL('/__xelay_public_shell_meta__', self.location.origin).href
const PREVIEW_CACHE = `${SHELL_CACHE_PREFIX}local-preview-v1`
const LOCAL_PREVIEW = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname)
  && SHELL_BUILD_ID.startsWith('__XELAY_')
const MAX_SHELL_BYTES = 32 * 1024 * 1024
let shellFailure = ''

function cacheName() { return LOCAL_PREVIEW ? PREVIEW_CACHE : `${SHELL_CACHE_PREFIX}${SHELL_BUILD_ID}` }
function publicAssetPath(pathname) {
  return /^\/assets\/[A-Za-z0-9_./-]+\.(?:js|css|woff2?)$/.test(pathname)
    || pathname === '/theme-init.js' || pathname === '/icons/xelay-app-20261008-192.png'
}
function previewAssetPath(pathname) {
  return LOCAL_PREVIEW && (/^\/(?:src\/|node_modules\/\.vite\/|@id\/)/.test(pathname)
    || pathname === '/node_modules/vite/dist/client/env.mjs'
    || pathname === '/@vite/client' || pathname === '/@react-refresh')
}
function approvedNavigation(url) {
  if (url.origin !== self.location.origin) return false
  if ([...url.searchParams.keys()].some((key) => /^(?:code|state|error|token|access_token|refresh_token|xelay_oauth|attempt)$/i.test(key))) return false
  return url.pathname === '/' || url.pathname === '/offline' || url.pathname === '/groups'
    || (LOCAL_PREVIEW && url.pathname === '/.offline-study-preview.local/index.html')
    || /^\/groups\/[0-9a-f-]{36}\/?$/i.test(url.pathname)
}
async function currentManifest() {
  try {
    const cache = await caches.open(cacheName())
    const response = await cache.match(SHELL_META)
    if (!response) return null
    const manifest = await response.json()
    if (manifest.version !== (LOCAL_PREVIEW ? 'local-preview-v1' : SHELL_BUILD_ID)) return null
    for (const url of manifest.urls) if (!await cache.match(url)) return null
    return manifest
  } catch { return null }
}
async function status() {
  return { type: 'XELAY_OFFLINE_SHELL_STATUS', ready: Boolean(await currentManifest()),
    version: LOCAL_PREVIEW ? 'local-preview-v1' : SHELL_BUILD_ID, preview: LOCAL_PREVIEW, error: shellFailure }
}
async function announceStatus() {
  const message = await status()
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    if (new URL(client.url).origin === self.location.origin) client.postMessage(message)
  }
}
function staticRequest(url) {
  return new Request(url, { cache: 'no-store', credentials: 'omit', redirect: 'error' })
}
function localPreviewViteClient() {
  // Vite's development HMR client is not needed by a saved reader. In the
  // explicit loopback preview use a compatible, network-free implementation;
  // this branch cannot be reached in a production release.
  return new Response(`
const data = new Map();
const styles = new Map();
export function updateStyle(id, content) {
  let style = styles.get(id);
  if (!style) {
    style = Array.from(document.querySelectorAll('style[data-vite-dev-id]')).find(item => item.getAttribute('data-vite-dev-id') === id);
    if (!style) { style = document.createElement('style'); style.setAttribute('data-vite-dev-id', id); document.head.appendChild(style); }
    styles.set(id, style);
  }
  style.textContent = content;
}
export function removeStyle(id) { styles.get(id)?.remove(); styles.delete(id); }
export function createHotContext(id) {
  if (!data.has(id)) data.set(id, {});
  return { data: data.get(id), accept() {}, acceptExports() {}, acceptDeps() {}, dispose() {}, prune() {}, decline() {}, invalidate() {}, on() {}, off() {}, send() {}, _internal: { updateStyle, removeStyle } };
}
export function injectQuery(value, query) {
  if (value[0] !== '.' && value[0] !== '/') return value;
  const url = new URL(value, 'http://vite.dev');
  return value.replace(/[?#].*$/, '') + '?' + query + (url.search ? '&' + url.search.slice(1) : '') + url.hash;
}
export class ErrorOverlay extends HTMLElement {
  constructor(error) { super(); this.textContent = error?.message || 'Помилка локального перегляду'; }
  close() { this.remove(); }
}
`, { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' } })
}
async function fillShell(manifest, preview = false) {
  const expected = preview ? 'local-preview-v1' : SHELL_BUILD_ID
  if (!manifest || manifest.version !== expected || manifest.shell !== '/index.html'
    || !Array.isArray(manifest.urls) || !manifest.urls.includes('/index.html')
    || manifest.urls.length > 600 || manifest.urls.length < 2) throw new Error('Некоректний список файлів офлайн-версії.')
  const urls = [...new Set(manifest.urls)]
  for (const value of urls) {
    if (typeof value !== 'string' || value.length > 1500) throw new Error('Некоректний шлях офлайн-файлу.')
    const url = new URL(value, self.location.origin)
    const badPreviewQuery = preview && [...url.searchParams.keys()].some((key) => !['v', 't', 'import', 'direct', 'url', 'raw'].includes(key))
    if (!value.startsWith('/') || url.origin !== self.location.origin || url.username || url.password || url.hash
      || url.pathname.includes('..') || (url.pathname !== '/index.html' && !publicAssetPath(url.pathname) && !(preview && previewAssetPath(url.pathname)))
      || (!preview && url.search) || badPreviewQuery) throw new Error('Офлайн-файл виходить за дозволені межі.')
    if (!preview && (!manifest.integrity || !/^[0-9a-f]{64}$/.test(manifest.integrity[value] || ''))) throw new Error('Не вдалося перевірити версію офлайн-файлу.')
  }
  const target = await caches.open(cacheName())
  // Remove readiness first; an incomplete preparation must never be advertised as available.
  await target.delete(SHELL_META)
  const aborter = new AbortController()
  const timer = setTimeout(() => aborter.abort(), 90000)
  let total = 0
  try {
    for (const value of urls) {
      const url = new URL(value, self.location.origin)
      const response = preview && LOCAL_PREVIEW && url.pathname === '/@vite/client'
        ? localPreviewViteClient()
        : await fetch(staticRequest(url), { signal: aborter.signal })
      if (!response.ok || response.type === 'opaque' || response.redirected) throw new Error('Не вдалося завантажити файли офлайн-версії.')
      const mime = response.headers.get('content-type') || ''
      if (url.pathname === '/index.html' ? !mime.includes('text/html') : mime.includes('text/html')) {
        throw new Error('Сервер повернув сторінку замість офлайн-файлу.')
      }
      const announcedSize = Number(response.headers.get('content-length'))
      if (Number.isFinite(announcedSize) && announcedSize > MAX_SHELL_BYTES - total) throw new Error('Завеликий розмір офлайн-версії.')
      const body = await response.arrayBuffer()
      total += body.byteLength
      if (total > MAX_SHELL_BYTES) throw new Error('Завеликий розмір офлайн-версії.')
      if (!preview) {
        const digest = await crypto.subtle.digest('SHA-256', body)
        const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
        if (actual !== manifest.integrity[value]) throw new Error('Платформа щойно оновилася. Спробуйте підготувати офлайн-версію ще раз.')
      }
      // Never retain Set-Cookie or server cache variations from shell responses.
      const headers = new Headers({ 'Content-Type': mime, 'Cache-Control': 'no-store' })
      for (const name of ['Content-Security-Policy', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy', 'X-Content-Type-Options']) {
        const value = response.headers.get(name)
        if (value) headers.set(name, value)
      }
      await target.put(url.href, new Response(body, { status: 200, headers }))
    }
    const selected = new Set(urls.map((url) => new URL(url, self.location.origin).href))
    for (const key of await target.keys()) if (!selected.has(key.url) && key.url !== SHELL_META) await target.delete(key)
    await target.put(SHELL_META, new Response(JSON.stringify({ version: expected, shell: '/index.html', urls }), { headers: { 'Content-Type': 'application/json' } }))
    shellFailure = ''
  } finally { clearTimeout(timer) }
}
async function prepareProductionShell() {
  if (LOCAL_PREVIEW) return
  try {
    if (await currentManifest()) return
    const aborter = new AbortController()
    const timer = setTimeout(() => aborter.abort(), 15000)
    let response
    try { response = await fetch(staticRequest(new URL(`/assets/offline-shell-manifest-${SHELL_BUILD_ID}.json`, self.location.origin)), { signal: aborter.signal }) }
    finally { clearTimeout(timer) }
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Офлайн-файли ще не підготовлені.')
    const raw = await response.text()
    if (raw.length > 128 * 1024) throw new Error('Завеликий список офлайн-файлів.')
    await fillShell(JSON.parse(raw))
  } catch (reason) {
    shellFailure = reason instanceof Error ? reason.message : 'Не вдалося підготувати офлайн-версію.'
    // A broken/incomplete release must never replace the last usable shell worker.
    throw reason
  }
}
async function ownPage(event) {
  if (!event.source?.id) return false
  const client = await self.clients.get(event.source.id)
  return Boolean(client && new URL(client.url).origin === self.location.origin)
}
function pageShellVersion(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => { channel.port1.close(); resolve(undefined) }, 1500)
    channel.port1.onmessage = (event) => {
      if (event.data?.type !== 'XELAY_OFFLINE_PAGE_VERSION') return
      clearTimeout(timer); channel.port1.close()
      const version = event.data.version
      resolve(typeof version === 'string' && /^[0-9a-f]{24}$/.test(version) ? version : null)
    }
    try { client.postMessage({ type: 'XELAY_OFFLINE_PAGE_VERSION_REQUEST' }, [channel.port2]) }
    catch { clearTimeout(timer); channel.port1.close(); resolve(undefined) }
  })
}
async function prunePublicShells() {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const versions = await Promise.all(pages.map(pageShellVersion))
  // An unresponsive older tab may still need its lazy chunks. Keep it working.
  if (versions.some(version => version === undefined)) return
  const pinned = new Set(versions.filter(Boolean).map(version => `${SHELL_CACHE_PREFIX}${version}`))
  const unreferenced = (await caches.keys()).filter(name => name.startsWith(SHELL_CACHE_PREFIX) && name !== cacheName() && !pinned.has(name))
  for (const name of unreferenced.slice(0, Math.max(0, unreferenced.length - 2))) await caches.delete(name)
}
async function cachedShellResponse(request) {
  try {
    if (new URL(request.url).pathname === '/index.html' && !await currentManifest()) return null
    const cache = await caches.open(cacheName())
    if (await cache.match(SHELL_META)) {
      const cached = await cache.match(request)
      if (cached) return cached
    }
    // Pinned old tabs may span several daily releases, so search every retained public-code cache.
    if (new URL(request.url).pathname.startsWith('/assets/')) {
      for (const name of (await caches.keys()).filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== cacheName()).reverse()) {
        const previous = await (await caches.open(name)).match(request)
        if (previous) return previous
      }
    }
  } catch { /* Storage restrictions must never break the normal online application. */ }
  return null
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || request.headers.has('Authorization') || request.headers.has('Range')) return
  if (request.mode === 'navigate' && approvedNavigation(url)) {
    event.respondWith((async () => {
      const aborter = new AbortController()
      const timer = setTimeout(() => aborter.abort(), 5000)
      try {
        const response = await fetch(request, { signal: aborter.signal })
        if (response.ok || response.status < 500) return response
        const fallback = await cachedShellResponse(new Request(new URL('/index.html', self.location.origin)))
        if (!fallback) return response
        return url.pathname === '/offline' ? fallback : Response.redirect(new URL('/offline', self.location.origin).href, 302)
      } catch (reason) {
        const fallback = await cachedShellResponse(new Request(new URL('/index.html', self.location.origin)))
        if (fallback) return url.pathname === '/offline' ? fallback : Response.redirect(new URL('/offline', self.location.origin).href, 302)
        throw reason
      } finally { clearTimeout(timer) }
    })())
    return
  }
  if (publicAssetPath(url.pathname) || previewAssetPath(url.pathname)) {
    event.respondWith((async () => {
      if (LOCAL_PREVIEW && previewAssetPath(url.pathname)) {
        const aborter = new AbortController()
        const timer = setTimeout(() => aborter.abort(), 1500)
        try {
          const fresh = await fetch(request, { signal: aborter.signal })
          if (fresh.ok) return fresh
          return (await cachedShellResponse(request)) || fresh
        } catch (reason) {
          const cached = await cachedShellResponse(request)
          if (cached) return cached
          throw reason
        } finally { clearTimeout(timer) }
      }
      return (await cachedShellResponse(request)) || fetch(request)
    })())
  }
})

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
self.addEventListener('install', (event) => event.waitUntil(prepareProductionShell()))
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  await self.clients.claim()
  // Keep live pages' public code and two unreferenced releases. Account storage is never touched.
  try {
    await prunePublicShells()
  } catch { /* Push and online operation remain available when cache storage is blocked. */ }
  await announceStatus()
})()))
self.addEventListener('message', (event) => {
  if (['XELAY_OFFLINE_SHELL_STATUS', 'XELAY_OFFLINE_SHELL_ACTIVATE', 'XELAY_OFFLINE_SHELL_PREPARE', 'XELAY_OFFLINE_PREVIEW_PREPARE'].includes(event.data?.type)) {
    event.waitUntil((async () => {
      if (!await ownPage(event)) return
      if (event.data.type === 'XELAY_OFFLINE_SHELL_ACTIVATE') {
        // Only an explicit application action asks a waiting release to activate. No automatic reload.
        if (await currentManifest()) await self.skipWaiting()
      } else if (event.data.type === 'XELAY_OFFLINE_SHELL_PREPARE' && !LOCAL_PREVIEW) {
        try { await prepareProductionShell() } catch { /* The status reply reports the failure without activating. */ }
        await announceStatus()
      } else if (event.data.type === 'XELAY_OFFLINE_PREVIEW_PREPARE' && LOCAL_PREVIEW) {
        try { await fillShell({ version: 'local-preview-v1', shell: '/index.html', urls: event.data.urls }, true) }
        catch (reason) { shellFailure = reason instanceof Error ? reason.message : 'Не вдалося підготувати локальний перегляд.' }
        await announceStatus()
      }
      event.ports?.[0]?.postMessage(await status())
    })())
    return
  }
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
