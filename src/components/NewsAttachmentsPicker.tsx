import { ChangeEvent, useId, useRef, useState } from 'react'
import { FileText, Paperclip, X } from 'lucide-react'
import { NewsAttachment, MAX_NEWS_ATTACHMENTS } from '../lib/news'
import { formatNewsFileSize, NEWS_FILES_ACCEPT, validateNewsFiles } from '../lib/newsMedia'

type Props = {
  files: File[]
  onChange: (files: File[]) => void
  existing?: NewsAttachment[]
  onRemoveExisting?: (path: string) => void
  disabled?: boolean
}

export function NewsAttachmentsPicker({ files, onChange, existing = [], onRemoveExisting, disabled = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const [error, setError] = useState('')
  const count = existing.length + files.length

  const selectFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files || [])
    event.currentTarget.value = ''
    if (!selected.length) return
    const next = [...files]
    for (const file of selected) {
      if (!next.some((saved) => saved.name === file.name && saved.size === file.size && saved.lastModified === file.lastModified)) next.push(file)
    }
    try {
      validateNewsFiles(next, existing)
      setError('')
      onChange(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося додати файли.')
    }
  }

  return <div className="min-w-0 space-y-2">
    <p id={`${id}-label`} className="text-sm font-medium">Файли <span className="font-normal text-muted-foreground">(необов’язково)</span></p>
    <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP або фото. До 10 файлів, кожен до 20 МБ, разом до 50 МБ.</p>
    <input ref={inputRef} type="file" multiple accept={NEWS_FILES_ACCEPT} disabled={disabled} onChange={selectFiles} tabIndex={-1} aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} className="hidden" />
    {count > 0 && <ul className="space-y-2">
      {existing.map((file) => <li key={file.path} className="flex min-w-0 items-center gap-2 rounded-xl border border-border px-3 py-2">
        <FileText size={17} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm" title={file.file_name}>{file.file_name}</span><span className="text-xs text-muted-foreground">{formatNewsFileSize(file.file_size)}</span></span>
        {onRemoveExisting && <button type="button" disabled={disabled} onClick={() => { setError(''); onRemoveExisting(file.path) }} aria-label={`Видалити вкладення ${file.file_name}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-muted disabled:opacity-50"><X size={17} /></button>}
      </li>)}
      {files.map((file, index) => <li key={`${file.name}-${file.lastModified}-${index}`} className="flex min-w-0 items-center gap-2 rounded-xl border border-border px-3 py-2">
        <FileText size={17} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm" title={file.name}>{file.name}</span><span className="text-xs text-muted-foreground">{formatNewsFileSize(file.size)} · Новий файл</span></span>
        <button type="button" disabled={disabled} onClick={() => { setError(''); onChange(files.filter((_, item) => item !== index)) }} aria-label={`Прибрати файл ${file.name}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-muted disabled:opacity-50"><X size={17} /></button>
      </li>)}
    </ul>}
    <button type="button" onClick={() => inputRef.current?.click()} disabled={disabled || count >= MAX_NEWS_ATTACHMENTS} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Paperclip size={17} aria-hidden="true" /> Додати файли{count ? ` · ${count}/${MAX_NEWS_ATTACHMENTS}` : ''}</button>
    {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
}
