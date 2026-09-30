import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import { Download, FileText, Link as LinkIcon, Loader2, Plus, X } from 'lucide-react'
import {
  HOMEWORK_FILE_ACCEPT,
  MAX_HOMEWORK_FILE_BYTES,
  MAX_HOMEWORK_FILES,
  MAX_HOMEWORK_LINKS,
  formatHomeworkFileSize,
  getHomeworkFileUrl,
  validateHomeworkFile,
  type HomeworkAttachment,
} from '../lib/homeworkResources'

type HomeworkResourceFieldsProps = {
  links: string[]
  onLinksChange: (links: string[]) => void
  files: File[]
  onFilesChange: (files: File[]) => void
  attachments: HomeworkAttachment[]
  onAttachmentsChange: (attachments: HomeworkAttachment[]) => void
  disabled: boolean
}

const fileKey = (file: File) => JSON.stringify([file.name, file.size, file.lastModified, file.type])
const attachmentKey = (attachment: HomeworkAttachment) => JSON.stringify([
  attachment.storage_path, attachment.file_name, attachment.file_size, attachment.mime_type,
])

export function HomeworkResourceFields({
  links, onLinksChange, files, onFilesChange, attachments, onAttachmentsChange, disabled,
}: HomeworkResourceFieldsProps) {
  const fieldId = useId()
  const [fileError, setFileError] = useState('')
  const linkRows = links.length ? links : ['']
  const fileCount = attachments.length + files.length

  const changeLink = (index: number, value: string) => {
    if (disabled) return
    onLinksChange(linkRows.map((link, linkIndex) => linkIndex === index ? value : link))
  }

  const removeLink = (index: number) => {
    if (disabled) return
    const nextLinks = linkRows.filter((_, linkIndex) => linkIndex !== index)
    onLinksChange(nextLinks.length ? nextLinks : [''])
  }

  const selectFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.currentTarget.files || [])
    event.currentTarget.value = ''
    if (disabled || !selectedFiles.length) return
    setFileError('')
    try {
      selectedFiles.forEach(validateHomeworkFile)
      const uniqueFiles = new Map(files.map((file) => [fileKey(file), file]))
      selectedFiles.forEach((file) => {
        if (!uniqueFiles.has(fileKey(file))) uniqueFiles.set(fileKey(file), file)
      })
      if (attachments.length + uniqueFiles.size > MAX_HOMEWORK_FILES) {
        setFileError(`Можна додати щонайбільше ${MAX_HOMEWORK_FILES} файлів. Приберіть зайві файли та повторіть вибір.`)
        return
      }
      onFilesChange(Array.from(uniqueFiles.values()))
    } catch (failure) {
      setFileError(failure instanceof Error ? failure.message : 'Не вдалося додати файли. Перевірте формат і розмір та спробуйте ще раз.')
    }
  }

  return (
    <div className="mt-4 min-w-0 space-y-5">
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium">Посилання на матеріали</legend>
        <p id={`${fieldId}-links-help`} className="mt-1 text-xs text-muted-foreground">
          Необов’язково. До {MAX_HOMEWORK_LINKS} посилань, що починаються з http:// або https://.
        </p>
        <div className="mt-3 space-y-3">
          {linkRows.map((link, index) => (
            <div key={index} className="flex min-w-0 items-end gap-2">
              <label className="min-w-0 flex-1 text-sm font-medium" htmlFor={`${fieldId}-link-${index}`}>
                Посилання {index + 1}
                <input
                  id={`${fieldId}-link-${index}`}
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={2048}
                  pattern="[Hh][Tt][Tt][Pp][Ss]?://.+"
                  title="Введіть посилання, що починається з http:// або https://."
                  aria-describedby={`${fieldId}-links-help`}
                  value={link}
                  disabled={disabled}
                  onChange={(event) => changeLink(index, event.target.value)}
                  className="mt-1.5 min-h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-base disabled:opacity-50"
                  placeholder="https://…"
                />
              </label>
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeLink(index)}
                aria-label={`Прибрати посилання ${index + 1}`}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          disabled={disabled || linkRows.length >= MAX_HOMEWORK_LINKS}
          onClick={() => {
            if (!disabled && linkRows.length < MAX_HOMEWORK_LINKS) onLinksChange([...linkRows, ''])
          }}
          className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-primary/20 bg-background px-4 py-2.5 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-50"
        >
          <Plus size={16} aria-hidden="true" />Додати посилання
        </button>
      </fieldset>

      <fieldset className="min-w-0">
        <legend className="text-sm font-medium">Файли до завдання</legend>
        <p id={`${fieldId}-files-help`} className="mt-1 text-xs text-muted-foreground">
          До {MAX_HOMEWORK_FILES} файлів, до {formatHomeworkFileSize(MAX_HOMEWORK_FILE_BYTES)} кожен. Файли додадуться після збереження завдання.
        </p>
        <label htmlFor={`${fieldId}-files`} className="mt-3 block text-sm font-medium">Виберіть файли на комп’ютері або телефоні</label>
        <input
          id={`${fieldId}-files`}
          type="file"
          multiple
          accept={HOMEWORK_FILE_ACCEPT}
          disabled={disabled || fileCount >= MAX_HOMEWORK_FILES}
          onChange={selectFiles}
          aria-describedby={`${fieldId}-files-help ${fieldId}-files-count${fileError ? ` ${fieldId}-files-error` : ''}`}
          aria-invalid={Boolean(fileError)}
          className="mt-1.5 min-h-11 w-full min-w-0 rounded-xl border border-border bg-background text-sm text-muted-foreground file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-xl file:border-0 file:bg-primary/10 file:px-4 file:py-2.5 file:text-sm file:font-semibold file:text-primary hover:file:bg-primary/15 disabled:opacity-50"
        />
        <p id={`${fieldId}-files-count`} className="mt-2 text-xs text-muted-foreground">Вибрано файлів: {fileCount} із {MAX_HOMEWORK_FILES}.</p>
        {fileError && <p id={`${fieldId}-files-error`} role="alert" className="mt-2 text-sm text-destructive">{fileError}</p>}

        {fileCount > 0 && (
          <ul className="mt-3 min-w-0 space-y-2" aria-label="Файли до завдання">
            {attachments.map((attachment, index) => (
              <li key={attachmentKey(attachment)} className="flex min-w-0 items-start gap-2 rounded-xl border border-border bg-background p-2.5">
                <FileText size={18} aria-hidden="true" className="mt-2.5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1 py-1.5">
                  <p className="break-all text-sm font-medium">{attachment.file_name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{formatHomeworkFileSize(attachment.file_size)} · Збережений файл</p>
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return
                    setFileError('')
                    onAttachmentsChange(attachments.filter((_, attachmentIndex) => attachmentIndex !== index))
                  }}
                  aria-label={`Прибрати файл ${attachment.file_name}`}
                  className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </li>
            ))}
            {files.map((file, index) => (
              <li key={fileKey(file)} className="flex min-w-0 items-start gap-2 rounded-xl border border-primary/15 bg-primary/5 p-2.5">
                <FileText size={18} aria-hidden="true" className="mt-2.5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1 py-1.5">
                  <p className="break-all text-sm font-medium">{file.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{formatHomeworkFileSize(file.size)} · Новий файл</p>
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return
                    setFileError('')
                    onFilesChange(files.filter((_, fileIndex) => fileIndex !== index))
                  }}
                  aria-label={`Прибрати файл ${file.name}`}
                  className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </div>
  )
}

type HomeworkResourceListProps = {
  links: string[]
  attachments: HomeworkAttachment[]
}

const safeResourceUrl = (value: string) => {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.href : null
  } catch {
    return null
  }
}

export function HomeworkResourceList({ links, attachments }: HomeworkResourceListProps) {
  const listId = useId()
  const [loadingFiles, setLoadingFiles] = useState<Record<string, boolean>>({})
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  const active = useRef(true)
  const generation = useRef(0)
  const downloadLocks = useRef(new Set<string>())
  const currentAttachments = useRef(new Set<string>())
  currentAttachments.current = new Set(attachments.map(attachmentKey))
  const safeLinks = links.map(safeResourceUrl).filter((link): link is string => Boolean(link))

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      generation.current += 1
      downloadLocks.current.clear()
    }
  }, [])

  const downloadFile = async (attachment: HomeworkAttachment) => {
    const key = attachmentKey(attachment)
    if (downloadLocks.current.has(key)) return
    const currentGeneration = generation.current
    const isCurrent = () => active.current && currentGeneration === generation.current && currentAttachments.current.has(key)
    downloadLocks.current.add(key)
    setLoadingFiles((current) => ({ ...current, [key]: true }))
    setFileErrors((current) => ({ ...current, [key]: '' }))
    try {
      const url = await getHomeworkFileUrl(attachment.storage_path, attachment.file_name)
      if (!isCurrent()) return
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = attachment.file_name
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      try { anchor.click() } finally { anchor.remove() }
    } catch {
      if (isCurrent()) setFileErrors((current) => ({ ...current, [key]: 'Не вдалося завантажити файл. Спробуйте ще раз.' }))
    } finally {
      if (currentGeneration === generation.current) downloadLocks.current.delete(key)
      if (active.current && currentGeneration === generation.current) setLoadingFiles((current) => ({ ...current, [key]: false }))
    }
  }

  if (!safeLinks.length && !attachments.length) return null

  return (
    <div className="mt-3 min-w-0 space-y-3">
      {safeLinks.length > 0 && (
        <ol aria-label="Посилання на матеріали" className="min-w-0 space-y-2">
          {safeLinks.map((link, index) => (
            <li key={`${index}-${link}`} className="flex min-w-0 items-start gap-2 text-sm">
              <span aria-hidden="true" className="shrink-0 py-3 text-primary">{index + 1}.</span>
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Посилання на матеріал ${index + 1}: ${link}`}
                className="inline-flex min-h-11 min-w-0 items-start gap-2 py-3 font-medium text-primary hover:underline"
              >
                <LinkIcon size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-all">{link}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
      {attachments.length > 0 && (
        <ul aria-label="Завантажити файли до завдання" className="min-w-0 space-y-2">
          {attachments.map((attachment, index) => {
            const key = attachmentKey(attachment)
            const loading = Boolean(loadingFiles[key])
            const error = fileErrors[key]
            const errorId = `${listId}-file-error-${index}`
            return (
              <li key={key} className="min-w-0">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void downloadFile(attachment)}
                  aria-label={`${loading ? 'Готуємо файл' : error ? 'Повторити завантаження файлу' : 'Завантажити файл'} ${attachment.file_name}`}
                  aria-busy={loading}
                  aria-describedby={error ? errorId : undefined}
                  className="inline-flex min-h-11 w-full min-w-0 items-start gap-2.5 rounded-xl border border-primary/15 bg-primary/5 px-3 py-2.5 text-left text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                  {loading ? <Loader2 size={17} aria-hidden="true" className="mt-1 shrink-0 animate-spin" /> : <Download size={17} aria-hidden="true" className="mt-1 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="block break-all text-sm font-medium">{attachment.file_name}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {formatHomeworkFileSize(attachment.file_size)} · {loading ? 'Готуємо файл…' : error ? 'Повторити завантаження' : 'Завантажити'}
                    </span>
                  </span>
                </button>
                {error && <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">{error}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
