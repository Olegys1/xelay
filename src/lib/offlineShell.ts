/** Public code cache only. Private schedule snapshots live in a separate, account-bound store. */
export type OfflineShellStatus = {
  supported: boolean
  ready: boolean
  checking: boolean
  updateAvailable: boolean
  preview: boolean
  error: string
}

const supported = typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'caches' in window
const localPreview = import.meta.env.DEV && typeof location !== 'undefined'
  && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
let state: OfflineShellStatus = { supported, ready: false, checking: false, updateAvailable: false, preview: localPreview, error: '' }
const listeners = new Set<() => void>()
let registration: ServiceWorkerRegistration | null = null
let registrationPromise: Promise<void> | null = null

export function getOfflineShellStatus(): OfflineShellStatus { return state }
export function subscribeOfflineShell(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(next: Partial<OfflineShellStatus>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}
type WorkerStatus = { type: 'XELAY_OFFLINE_SHELL_STATUS'; ready: boolean; preview: boolean; error?: string }
function isStatus(value: unknown): value is WorkerStatus {
  return Boolean(value && typeof value === 'object' && (value as WorkerStatus).type === 'XELAY_OFFLINE_SHELL_STATUS'
    && typeof (value as WorkerStatus).ready === 'boolean' && typeof (value as WorkerStatus).preview === 'boolean')
}
function askWorker(worker: ServiceWorker, message: object, timeout = 12000): Promise<WorkerStatus> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => { channel.port1.close(); reject(new Error('Офлайн-версія не відповідає. Спробуйте ще раз.')) }, timeout)
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer)
      channel.port1.close()
      if (isStatus(event.data)) resolve(event.data)
      else reject(new Error('Не вдалося перевірити офлайн-версію.'))
    }
    worker.postMessage(message, [channel.port2])
  })
}
async function refreshStatus() {
  if (!registration) return
  const active = registration.active
  const waiting = registration.waiting
  if (!waiting) publish({ updateAvailable: false })
  await Promise.all([
    (async () => {
      if (!active) return
      try {
        const value = await askWorker(active, { type: 'XELAY_OFFLINE_SHELL_STATUS' })
        if (registration?.active === active) publish({ ready: value.ready, preview: value.preview, checking: false, error: value.error || '' })
      } catch {
        // The previously deployed notification-only worker does not understand shell messages.
        if (registration?.active === active) publish({ checking: false })
      }
    })(),
    (async () => {
      if (!waiting) return
      const value = await askWorker(waiting, { type: 'XELAY_OFFLINE_SHELL_STATUS' })
      if (registration?.waiting === waiting) publish({ updateAvailable: value.ready })
    })(),
  ])
}

/** Register independently of notification permissions. It never prompts for permissions or reloads a page. */
export function registerOfflineShell(): Promise<void> {
  if (!supported) return Promise.resolve()
  if (registrationPromise) return registrationPromise
  publish({ checking: true, error: '' })
  registrationPromise = (async () => {
    registration = await navigator.serviceWorker.register('/push-sw.js', { scope: '/', updateViaCache: 'none' })
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'XELAY_OFFLINE_PAGE_VERSION_REQUEST') {
        const source = event.source as ServiceWorker | null
        if (!source?.scriptURL || new URL(source.scriptURL).origin !== location.origin || new URL(source.scriptURL).pathname !== '/push-sw.js') return
        const version = document.querySelector<HTMLMetaElement>('meta[name="xelay-shell-version"]')?.content
        event.ports[0]?.postMessage({ type: 'XELAY_OFFLINE_PAGE_VERSION', version: version && /^[0-9a-f]{24}$/.test(version) ? version : null })
        return
      }
      if (!isStatus(event.data) || event.source !== registration?.active) return
      publish({ ready: event.data.ready, preview: event.data.preview, checking: false, error: event.data.error || '' })
    })
    navigator.serviceWorker.addEventListener('controllerchange', () => { void refreshStatus().catch(() => {}) })
    window.addEventListener('online', () => {
      if (!localPreview && !state.ready) void retryOfflineShellPreparation().catch(() => {})
    })
    const watchInstalling = () => {
      const worker = registration?.installing
      if (!worker) return
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' || worker.state === 'activated') void refreshStatus().catch(() => {})
      })
    }
    registration.addEventListener('updatefound', watchInstalling)
    watchInstalling()
    if (!registration.active) {
      // The first installation activates naturally. Updated releases wait for an explicit action.
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => window.setTimeout(() => reject(new Error('Підготовка офлайн-версії триває довше звичайного.')), 120000)),
      ])
    }
    await refreshStatus()
  })().catch((reason) => {
    registrationPromise = null
    publish({ checking: false, error: reason instanceof Error ? reason.message : 'Не вдалося підготувати офлайн-версію.' })
  })
  return registrationPromise
}

/** Activate a prepared update only after the user chooses to do so. The caller decides when to reload. */
export async function applyOfflineShellUpdate(): Promise<void> {
  const worker = registration?.waiting
  if (!worker) return
  const value = await askWorker(worker, { type: 'XELAY_OFFLINE_SHELL_ACTIVATE' })
  if (!value.ready) throw new Error('Нова офлайн-версія ще не готова.')
  if (worker.state !== 'activated') await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error('Не вдалося ввімкнути нову офлайн-версію.')) }, 15000)
    const changed = () => {
      if (worker.state !== 'activated' && worker.state !== 'redundant') return
      window.clearTimeout(timer)
      worker.removeEventListener('statechange', changed)
      if (worker.state === 'activated') resolve()
      else reject(new Error('Офлайн-версію замінено новішою. Оновіть сторінку пізніше.'))
    }
    worker.addEventListener('statechange', changed)
    changed()
  })
  await refreshStatus()
}

/** Retry after a temporary download/storage failure; it still never activates a waiting release. */
export async function retryOfflineShellPreparation(): Promise<void> {
  if (!supported || localPreview) return
  await registerOfflineShell()
  const worker = registration?.waiting || registration?.active
  if (!worker) return
  publish({ checking: true, error: '' })
  try {
    await askWorker(worker, { type: 'XELAY_OFFLINE_SHELL_PREPARE' }, 110000)
    await refreshStatus()
  } catch (reason) {
    publish({ checking: false, error: reason instanceof Error ? reason.message : 'Не вдалося підготувати офлайн-версію.' })
  }
}

function devResourcePath(url: URL) {
  if (url.origin !== location.origin || url.username || url.password || url.hash) return false
  if ([...url.searchParams.keys()].some((key) => !['v', 't', 'import', 'direct', 'url', 'raw'].includes(key))) return false
  return /^\/(?:src\/|node_modules\/\.vite\/|@id\/)/.test(url.pathname)
    || url.pathname === '/node_modules/vite/dist/client/env.mjs'
    || url.pathname === '/@vite/client' || url.pathname === '/@react-refresh'
    || /^\/assets\/[A-Za-z0-9_./-]+\.(?:js|css|woff2?)$/.test(url.pathname)
}

/**
 * Explicit local demonstration only: preserve modules already loaded by Vite, without running a production build.
 * Production uses the complete release manifest instead; it never caches Vite paths.
 */
export async function prepareOfflineShellPreview(): Promise<void> {
  if (!localPreview || !supported) throw new Error('Локальний перегляд доступний лише на цьому комп’ютері в режимі розробки.')
  await registerOfflineShell()
  const worker = registration?.active
  if (!worker) throw new Error('Сервіс офлайн-перегляду ще не готовий.')
  publish({ checking: true, error: '' })
  try {
    const urls = new Set(['/index.html', '/theme-init.js', '/icons/xelay-app-20261008-192.png'])
    for (const resource of performance.getEntriesByType('resource')) {
      const url = new URL(resource.name, location.origin)
      if (devResourcePath(url)) urls.add(`${url.pathname}${url.search}`)
    }
    const value = await askWorker(worker, { type: 'XELAY_OFFLINE_PREVIEW_PREPARE', urls: [...urls] }, 100000)
    publish({ ready: value.ready, preview: true, checking: false, error: value.error || '' })
    if (!value.ready) throw new Error(value.error || 'Не вдалося підготувати локальний перегляд.')
  } catch (reason) {
    publish({ checking: false, error: reason instanceof Error ? reason.message : 'Не вдалося підготувати локальний перегляд.' })
    throw reason
  }
}
