import { useEffect, useId, useRef, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { getCommunityDeletionError } from '../lib/communityDeletion'

type OwnContentDeleteButtonProps = {
  kind: 'question' | 'answer'
  onDelete: () => Promise<void>
  disabled?: boolean
  compact?: boolean
}

export function OwnContentDeleteButton({ kind, onDelete, disabled = false, compact = false }: OwnContentDeleteButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const deletingRef = useRef(false)
  const id = useId()
  const deleteLabel = kind === 'question' ? 'Видалити запитання' : 'Видалити відповідь'
  const titleId = `${id}-delete-title`
  const descriptionId = `${id}-delete-description`

  useEffect(() => {
    if (confirmOpen && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal()
  }, [confirmOpen])

  const openConfirmation = () => {
    if (disabled || deletingRef.current) return
    setError('')
    setConfirmOpen(true)
  }

  const closeConfirmation = () => {
    if (deletingRef.current) return
    dialogRef.current?.close()
    setConfirmOpen(false)
  }

  const confirmDeletion = async () => {
    if (disabled || deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    setError('')
    try {
      await onDelete()
      dialogRef.current?.close()
      setConfirmOpen(false)
    } catch (deleteError) {
      console.error(`Could not delete own ${kind}:`, deleteError)
      setError(getCommunityDeletionError(deleteError))
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  return (
    <div className="inline-flex shrink-0">
      <button
        type="button"
        disabled={disabled || deleting}
        onClick={openConfirmation}
        aria-label={deleteLabel}
        className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-primary/20 text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${compact ? 'w-11 p-2' : 'px-4 py-2.5 text-sm font-medium'}`}
      >
        <Trash2 size={16} aria-hidden="true" />
        <span className={compact ? 'sr-only' : undefined}>{compact ? deleteLabel : 'Видалити'}</span>
      </button>
      {confirmOpen && <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={deleting}
        onCancel={(event) => { event.preventDefault(); closeConfirmation() }}
        onClose={() => setConfirmOpen(false)}
        className="m-auto max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto rounded-2xl border border-border bg-background p-5 text-foreground shadow-2xl backdrop:bg-foreground/45 backdrop:backdrop-blur-sm sm:p-6"
      >
        <h2 id={titleId} className="break-words text-lg font-bold">{deleteLabel}?</h2>
        <p id={descriptionId} className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {kind === 'question'
            ? 'Запитання, усі відповіді та коментарі до нього буде видалено без можливості відновлення.'
            : 'Відповідь і всі її обговорення буде видалено без можливості відновлення.'}
        </p>
        {error && <p role="alert" className="mt-4 break-words text-sm text-destructive">{error}</p>}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" autoFocus disabled={deleting} onClick={closeConfirmation} className="inline-flex min-h-11 items-center justify-center rounded-full border border-border px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50">Скасувати</button>
          <button type="button" disabled={disabled || deleting} onClick={() => void confirmDeletion()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {deleting ? <Loader2 size={16} className="shrink-0 animate-spin" aria-hidden="true" /> : <Trash2 size={16} className="shrink-0" aria-hidden="true" />}
            {deleting ? 'Видаляємо…' : deleteLabel}
          </button>
        </div>
      </dialog>}
    </div>
  )
}
