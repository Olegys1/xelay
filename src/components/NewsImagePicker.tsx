import { ChangeEvent, useEffect, useId, useRef, useState } from 'react'
import { ImagePlus, RefreshCw, Trash2 } from 'lucide-react'
import { NEWS_IMAGE_ACCEPT, validateNewsImage } from '../lib/newsMedia'

type NewsImagePickerProps = {
  file: File | null
  onChange: (file: File | null) => void
  disabled?: boolean
}

export function NewsImagePicker({ file, onChange, disabled = false }: NewsImagePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    if (!file) {
      setPreview(null)
      return
    }

    const url = URL.createObjectURL(file)
    setPreview({ file, url })
    return () => URL.revokeObjectURL(url)
  }, [file])

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!selectedFile) return

    try {
      validateNewsImage(selectedFile)
      setError('')
      onChange(selectedFile)
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : 'Не вдалося відкрити фото. Оберіть інший файл.')
    }
  }

  const removeFile = () => {
    setError('')
    if (inputRef.current) inputRef.current.value = ''
    onChange(null)
  }

  return (
    <div className="min-w-0 space-y-2">
      <p id={`${id}-label`} className="text-sm font-medium">Фото <span className="font-normal text-muted-foreground">(необов’язково)</span></p>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">Оберіть фото з галереї телефону або комп’ютера. JPEG, PNG, WebP, GIF чи AVIF, до 10 МБ.</p>
      <input
        ref={inputRef}
        type="file"
        accept={NEWS_IMAGE_ACCEPT}
        onChange={selectFile}
        disabled={disabled}
        tabIndex={-1}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        aria-invalid={Boolean(error)}
        className="hidden"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {file ? <RefreshCw size={16} aria-hidden="true" /> : <ImagePlus size={16} aria-hidden="true" />}
          {file ? 'Змінити фото' : 'Додати фото'}
        </button>
        {file && (
          <button
            type="button"
            onClick={removeFile}
            disabled={disabled}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={16} aria-hidden="true" /> Видалити фото
          </button>
        )}
      </div>
      {file && (
        <div className="min-w-0 space-y-2 pt-1">
          {preview?.file === file && <img src={preview.url} alt="Попередній перегляд обраного фото" className="block max-h-64 w-auto max-w-full rounded-xl border border-border object-contain" />}
          <p className="break-all text-xs text-muted-foreground">{file.name}</p>
        </div>
      )}
      {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
