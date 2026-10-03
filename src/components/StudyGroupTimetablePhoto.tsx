import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, Maximize2, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import {
  loadTimetablePhoto, removeDetachedTimetablePhoto, setTimetablePhoto, timetablePhotoError,
  timetablePhotoUrl, uploadTimetablePhoto, type TimetablePhoto,
} from '../lib/studyGroupTimetablePhoto'

type Props = { groupId: string; currentUserId: string; canEdit: boolean }
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50'

export function StudyGroupTimetablePhoto(props: Props) {
  return <PhotoWorkspace key={`${props.groupId}:${props.currentUserId}`} {...props} />
}

function PhotoWorkspace({ groupId, currentUserId, canEdit }: Props) {
  const [photo, setPhoto] = useState<TimetablePhoto | null>(null)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [zoom, setZoom] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const alive = useRef(true)
  const request = useRef(0)
  const mutation = useRef(false)
  const latestCanEdit = useRef(canEdit)
  latestCanEdit.current = canEdit

  const reload = useCallback(async (silent = false) => {
    const sequence = ++request.current
    if (!silent) setLoading(true)
    try {
      const next = await loadTimetablePhoto(groupId)
      const nextUrl = next ? await timetablePhotoUrl(next.storage_path) : ''
      if (!alive.current || sequence !== request.current) return
      setPhoto(next); setUrl(nextUrl); setError('')
      if (!next) setZoom(false)
    } catch (failure) {
      if (alive.current && sequence === request.current) {
        setPhoto(null); setUrl(''); setZoom(false)
        setError(timetablePhotoError(failure))
      }
    } finally {
      if (alive.current && sequence === request.current) setLoading(false)
    }
  }, [groupId])

  useEffect(() => {
    alive.current = true
    void reload()
    const refresh = () => { if (document.visibilityState === 'visible') void reload(true) }
    const channel = supabase.channel(`timetable-photo:${groupId}:${currentUserId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_timetable_photos', filter: `group_id=eq.${groupId}` }, refresh)
      .subscribe()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const interval = window.setInterval(refresh, 45_000)
    return () => {
      alive.current = false; ++request.current
      void supabase.removeChannel(channel)
      window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh)
      window.clearInterval(interval)
    }
  }, [groupId, currentUserId, reload])

  useEffect(() => {
    if (!zoom) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoom(false)
      if (event.key === 'Tab') { event.preventDefault(); closeButton.current?.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', keydown); previous?.focus()
    }
  }, [zoom])

  const save = async (file: File) => {
    if (mutation.current || !latestCanEdit.current) return
    mutation.current = true; setBusy(true); setError(''); setNotice('')
    let uploadedPath: string | null = null
    let committed = false
    try {
      const uploaded = await uploadTimetablePhoto(groupId, currentUserId, file)
      uploadedPath = uploaded.storage_path
      if (!alive.current || !latestCanEdit.current) throw new Error('Доступ до редагування розкладу змінився. Оновіть сторінку.')
      const result = await setTimetablePhoto(groupId, uploaded)
      committed = true
      if (result.previousPath && result.previousPath !== uploadedPath) await removeDetachedTimetablePhoto(result.previousPath)
      if (!alive.current) return
      setPhoto(result.photo)
      setNotice('Фото розкладу оновлено для всієї групи.')
      await reload(true)
    } catch (failure) {
      if (alive.current) setError(timetablePhotoError(failure))
      // The server refuses deletion of a referenced photo even if a committed
      // setter response was lost. Only detached uploads can be cleaned up.
      if (!committed && uploadedPath) await removeDetachedTimetablePhoto(uploadedPath)
    } finally {
      mutation.current = false
      if (alive.current) setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const useExample = async () => {
    if (!latestCanEdit.current || mutation.current || !window.confirm('Завантажити фото розкладу ЕУБ-4 для цієї групи?')) return
    mutation.current = true; setBusy(true); setError('')
    let example: File | null = null
    try {
      const response = await fetch('/images/eub-4-timetable-example.png')
      if (!response.ok) throw new Error('TIMETABLE_PHOTO_NOT_FOUND')
      const blob = await response.blob()
      if (alive.current && latestCanEdit.current) example = new File([blob], 'ЕУБ-4-розклад.png', { type: 'image/png' })
    } catch (failure) { if (alive.current) setError(timetablePhotoError(failure)) }
    finally { mutation.current = false; if (alive.current) setBusy(false) }
    if (example) await save(example)
  }

  const remove = async () => {
    if (mutation.current || !latestCanEdit.current || !photo || !window.confirm('Прибрати фото розкладу? Таблиця пар і домашні завдання збережуться.')) return
    mutation.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await setTimetablePhoto(groupId, null)
      if (result.previousPath) await removeDetachedTimetablePhoto(result.previousPath)
      if (alive.current) { setPhoto(null); setUrl(''); setZoom(false); setNotice('Фото розкладу прибрано.'); await reload(true) }
    } catch (failure) { if (alive.current) setError(timetablePhotoError(failure)) }
    finally { mutation.current = false; if (alive.current) setBusy(false) }
  }

  return <section aria-label="Фото розкладу" className="xelay-card overflow-hidden">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 sm:p-5">
      <div><h2 className="font-semibold">Фото розкладу</h2><p className="mt-1 text-xs text-muted-foreground">Верхній і нижній тижні — як у розкладі вашої групи.</p></div>
      {canEdit && <div className="flex flex-wrap gap-2">
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Обрати фото розкладу" disabled={busy || !canEdit} onChange={(event) => { const file = event.target.files?.[0]; if (file) void save(file) }} />
        <button type="button" disabled={busy || loading} onClick={() => fileInput.current?.click()} className={`${button} border-primary/20 text-primary`}>{busy ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <Upload size={16} />}{photo ? 'Оновити фото' : 'Завантажити фото'}</button>
        {photo && <button type="button" disabled={busy} onClick={() => void remove()} className={button} aria-label="Прибрати фото розкладу"><Trash2 size={16} /></button>}
      </div>}
    </header>
    <div className="p-4 sm:p-5">
      {error && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"><p>{error}</p><button type="button" disabled={busy || loading} className="inline-flex min-h-10 items-center gap-2 rounded-full px-3 font-medium" onClick={() => void reload()}><RefreshCw size={15} />Спробувати ще раз</button></div>}
      {notice && <p role="status" className="mb-3 text-sm text-primary">{notice}</p>}
      {loading ? <div className="flex min-h-44 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 size={18} className="animate-spin motion-reduce:animate-none" />Завантажуємо розклад…</div>
        : photo && url ? <>
          <button type="button" onClick={() => setZoom(true)} className="relative block w-full overflow-hidden rounded-xl bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label="Відкрити фото розкладу на весь екран">
            <img src={url} alt="Фото розкладу навчальної групи: верхній і нижній тижні" className="mx-auto max-h-[75dvh] w-full object-contain" />
            <span className="absolute bottom-3 right-3 inline-flex items-center gap-2 rounded-full bg-background/95 px-3 py-2 text-xs font-medium text-foreground shadow-sm"><Maximize2 size={14} />Збільшити</span>
          </button>
          <p className="mt-3 text-xs text-muted-foreground">Оновлено {new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', timeZone: 'Europe/Kyiv' }).format(new Date(photo.updated_at))}.</p>
        </> : !error && <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <ImagePlus size={28} className="mx-auto text-primary/70" /><p className="mt-3 text-sm text-muted-foreground">Староста може завантажити фото — воно буде доступне всім учасникам групи.</p>
          {canEdit && <><p className="mt-2 text-xs text-muted-foreground">JPG, PNG або WebP до 8 МБ. Фото відкривається зі збільшенням.</p><button type="button" disabled={busy} onClick={() => void useExample()} className={`${button} mt-4`}>Використати фото ЕУБ-4</button></>}
        </div>}
    </div>
    {zoom && photo && url && <div role="dialog" aria-modal="true" aria-label="Фото розкладу на весь екран" className="fixed inset-0 z-[85] flex items-center justify-center bg-black/85 p-3 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) setZoom(false) }}>
      <button ref={closeButton} type="button" onClick={() => setZoom(false)} aria-label="Закрити фото" className="absolute right-3 top-3 z-10 rounded-full bg-background p-3 text-foreground shadow-sm"><X size={22} /></button>
      <div className="max-h-[90dvh] w-full overflow-auto rounded-xl"><img src={url} alt="Фото розкладу навчальної групи" className="mx-auto h-auto w-auto min-w-[720px] max-w-none bg-white sm:min-w-0 sm:max-h-[90dvh]" /></div>
    </div>}
  </section>
}
