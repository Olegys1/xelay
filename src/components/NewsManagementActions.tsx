import { useEffect, useRef, useState } from 'react'
import { Loader2, Pencil, Trash2 } from 'lucide-react'

export function NewsManagementActions({ title, onEdit, onDelete }: {
  title: string
  onEdit: () => void
  onDelete: () => Promise<void>
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const deletingRef = useRef(false)

  useEffect(() => {
    if (confirmOpen && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal()
  }, [confirmOpen])

  const closeConfirmation = () => {
    if (deletingRef.current) return
    dialogRef.current?.close()
    setConfirmOpen(false)
  }

  const confirmDeletion = async () => {
    if (deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    setError('')
    try {
      await onDelete()
      dialogRef.current?.close()
      setConfirmOpen(false)
    } catch (deleteError) {
      console.error('Could not delete news:', deleteError)
      setError('Не вдалося видалити новину. Перевірте права доступу й налаштування новин у Supabase та спробуйте ще раз.')
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <button type="button" disabled={deleting} onClick={onEdit} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-2.5 text-sm font-semibold text-primary hover:bg-primary/10 disabled:opacity-50">
        <Pencil size={16} /> Редагувати
      </button>
      <button type="button" disabled={deleting} onClick={() => { setError(''); setConfirmOpen(true) }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-destructive/20 px-4 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/5 disabled:opacity-50">
        <Trash2 size={16} /> Видалити
      </button>
      {confirmOpen && <dialog ref={dialogRef} aria-labelledby="delete-news-title" aria-describedby="delete-news-description"
        onCancel={(event) => { event.preventDefault(); closeConfirmation() }}
        onClose={() => setConfirmOpen(false)}
        className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-border bg-background p-5 text-foreground shadow-2xl backdrop:bg-foreground/45 backdrop:backdrop-blur-sm sm:p-6">
        <h2 id="delete-news-title" className="text-lg font-bold">Видалити новину?</h2>
        <p className="mt-3 break-words text-sm font-semibold">{title}</p>
        <p id="delete-news-description" className="mt-2 text-sm leading-relaxed text-muted-foreground">Публікацію, її коментарі та вподобання буде видалено без можливості відновлення. Заявка на публікацію залишиться в історії з позначкою «видалено».</p>
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" autoFocus disabled={deleting} onClick={closeConfirmation} className="inline-flex min-h-11 items-center justify-center rounded-full border border-border px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50">Скасувати</button>
          <button type="button" disabled={deleting} onClick={() => void confirmDeletion()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
            {deleting ? 'Видаляємо…' : 'Видалити новину'}
          </button>
        </div>
      </dialog>}
    </div>
  )
}
