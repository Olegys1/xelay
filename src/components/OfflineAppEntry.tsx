import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { CloudOff, RefreshCw, Wifi } from 'lucide-react'
import { OfflineStudyReader } from './OfflineStudyReader'
import { applyOfflineShellUpdate, getOfflineShellStatus, subscribeOfflineShell } from '../lib/offlineShell'
import { getOfflineOwner, listOfflineGroups, OFFLINE_STUDY_CHANGED } from '../lib/offlineStudy'

const loopback = typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
const LocalPreview = import.meta.env.DEV && loopback
  ? lazy(() => import('./OfflineStudyPreview').then(module => ({ default: module.OfflineStudyPreview })))
  : null

function previewMarker(): boolean {
  if (!import.meta.env.DEV || !loopback) return false
  try { return sessionStorage.getItem('xelay-offline-local-preview') === '1' } catch { return false }
}

// A saved reader is deliberately separate from the normal authenticated app.
// It can never restore roles, send homework, or authorize a network operation.
export function OfflineAppEntry({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [initialReader] = useState(() => location.pathname === '/offline' || !navigator.onLine)
  const [readerOpen, setReaderOpen] = useState(initialReader)
  const [shell, setShell] = useState(getOfflineShellStatus)
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [hasSavedData, setHasSavedData] = useState(false)
  useEffect(() => {
    const connected = () => setOnline(true)
    const disconnected = () => setOnline(false)
    window.addEventListener('online', connected)
    window.addEventListener('offline', disconnected)
    const unsubscribe = subscribeOfflineShell(() => setShell(getOfflineShellStatus()))
    return () => {
      window.removeEventListener('online', connected)
      window.removeEventListener('offline', disconnected)
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    let alive = true
    let generation = 0
    const read = async () => {
      const current = ++generation
      try {
        const owner = await getOfflineOwner()
        const groups = owner ? await listOfflineGroups(owner.id) : []
        if (alive && current === generation) setHasSavedData(groups.length > 0)
      } catch { if (alive && current === generation) setHasSavedData(false) }
    }
    void read()
    window.addEventListener(OFFLINE_STUDY_CHANGED, read)
    return () => { alive = false; ++generation; window.removeEventListener(OFFLINE_STUDY_CHANGED, read) }
  }, [])

  if (LocalPreview && location.pathname === '/.offline-study-preview.local/index.html') {
    return <Suspense fallback={<main className="p-8 text-center text-muted-foreground">Відкриваємо локальний приклад…</main>}><LocalPreview /></Suspense>
  }

  const reconnect = () => {
    if (!navigator.onLine) return
    location.assign('/groups')
  }
  const closeReader = !initialReader ? () => setReaderOpen(false) : undefined
  const update = async () => {
    setUpdating(true); setUpdateError('')
    try { await applyOfflineShellUpdate(); location.reload() }
    catch { setUpdateError('Не вдалося оновити Xelay. Спробуйте ще раз, коли буде стабільне з’єднання.'); setUpdating(false) }
  }
  return <>
    {previewMarker() && <div className="border-b border-amber-400/40 bg-amber-100 px-4 py-2 text-center text-xs font-medium text-amber-950">Локальний приклад · вигадані навчальні дані · нічого не опубліковано</div>}
    {!readerOpen && !online && <aside role="status" className="sticky top-0 z-[100] flex flex-wrap items-center justify-center gap-3 border-b border-amber-500/30 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
      <CloudOff size={18} aria-hidden="true" /><span>Немає інтернету. Збережені розклад і ДЗ можна переглянути на цьому пристрої.</span>
      <button type="button" onClick={() => setReaderOpen(true)} className="rounded-full border border-current px-3 py-1.5 font-semibold">Відкрити збережене</button>
    </aside>}
    {shell.updateAvailable && online && <aside role="status" className="flex flex-wrap items-center justify-center gap-3 border-b border-primary/20 bg-primary/5 px-4 py-2 text-xs text-foreground">
      <RefreshCw size={15} aria-hidden="true" /><span>Доступне оновлення Xelay. Спочатку збережіть введені дані.</span>
      <button type="button" disabled={updating} onClick={() => void update()} className="rounded-full border border-primary/30 px-3 py-1.5 font-semibold disabled:opacity-50">{updating ? 'Оновлюємо…' : 'Оновити Xelay'}</button>
      {updateError && <span role="alert">{updateError}</span>}
    </aside>}
    {!initialReader && <div hidden={readerOpen}>{children}</div>}
    {!readerOpen && online && hasSavedData && <button type="button" onClick={() => setReaderOpen(true)} className="fixed bottom-5 right-4 z-40 inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground shadow-lg sm:right-6" aria-label="Відкрити збережені розклад і ДЗ"><CloudOff size={17} aria-hidden="true" />Збережені розклад і ДЗ</button>}
    {readerOpen && <div className="min-h-screen bg-background text-foreground">
      {online && <div className="flex items-center justify-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground"><Wifi size={14} aria-hidden="true" />Нижче показано збережену копію. Оновлення доступні на платформі після підключення.</div>}
      <OfflineStudyReader onClose={closeReader} onReconnect={reconnect} />
    </div>}
  </>
}
