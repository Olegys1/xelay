import { useEffect, useId, useRef, useState } from 'react'
import { Download, Link as LinkIcon, Loader2 } from 'lucide-react'
import { HomeworkResourceFields } from './HomeworkResources'
import {
  cleanupPendingSeminarFiles,
  formatSeminarFileSize,
  getSeminarFileUrl,
  getSeminarLinks,
  type SeminarAttachment,
} from '../lib/seminarResources'

export type SeminarResourceFieldsProps = {
  links: string[]
  onLinksChange: (links: string[]) => void
  files: File[]
  onFilesChange: (files: File[]) => void
  attachments: SeminarAttachment[]
  onAttachmentsChange: (attachments: SeminarAttachment[]) => void
  disabled: boolean
}

export function SeminarResourceFields(props: SeminarResourceFieldsProps) {
  useEffect(() => { void cleanupPendingSeminarFiles() }, [])
  // The existing accessible editor shares the same limits and accepted file
  // formats; persistence and downloads use the separate private seminar bucket.
  return <HomeworkResourceFields {...props} />
}

export type SeminarResourceListProps = { links: string[]; attachments: SeminarAttachment[] }
const attachmentKey = (item: SeminarAttachment) => JSON.stringify([
  item.storage_path, item.file_name, item.file_size, item.mime_type,
])

export function SeminarResourceList({ links, attachments }: SeminarResourceListProps) {
  const listId = useId()
  const [loadingFiles, setLoadingFiles] = useState<Record<string, boolean>>({})
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  const active = useRef(true)
  const generation = useRef(0)
  const locks = useRef(new Set<string>())
  const currentFiles = useRef(new Set<string>())
  currentFiles.current = new Set(attachments.map(attachmentKey))
  const safeLinks = getSeminarLinks(links)

  useEffect(() => {
    active.current = true
    void cleanupPendingSeminarFiles()
    return () => {
      active.current = false
      generation.current += 1
      locks.current.clear()
    }
  }, [])

  const downloadFile = async (attachment: SeminarAttachment) => {
    const key = attachmentKey(attachment)
    if (locks.current.has(key)) return
    const downloadGeneration = generation.current
    const isCurrent = () => active.current && generation.current === downloadGeneration && currentFiles.current.has(key)
    locks.current.add(key)
    setLoadingFiles((current) => ({ ...current, [key]: true }))
    setFileErrors((current) => ({ ...current, [key]: '' }))
    try {
      const url = await getSeminarFileUrl(attachment.storage_path, attachment.file_name)
      if (!isCurrent()) return
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = attachment.file_name
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      try { anchor.click() } finally { anchor.remove() }
    } catch (error) {
      if (isCurrent()) setFileErrors((current) => ({
        ...current, [key]: error instanceof Error ? error.message : 'Не вдалося завантажити файл. Спробуйте ще раз.',
      }))
    } finally {
      if (generation.current === downloadGeneration) locks.current.delete(key)
      if (active.current && generation.current === downloadGeneration) {
        setLoadingFiles((current) => ({ ...current, [key]: false }))
      }
    }
  }

  if (!safeLinks.length && !attachments.length) return null

  return (
    <section aria-label="Матеріали завдання семінару" className="mt-4 min-w-0 space-y-3 rounded-xl border border-border bg-muted/20 p-3 sm:p-4">
      <h4 className="text-sm font-semibold">Матеріали до семінару</h4>
      {safeLinks.length > 0 && (
        <ol aria-label="Посилання на матеріали семінару" className="min-w-0 space-y-1">
          {safeLinks.map((link, index) => (
            <li key={link} className="flex min-w-0 items-start gap-2 text-sm">
              <span aria-hidden="true" className="shrink-0 py-3 text-primary">{index + 1}.</span>
              <a href={link} target="_blank" rel="noopener noreferrer"
                aria-label={`Відкрити матеріал ${index + 1}: ${link}`}
                className="inline-flex min-h-11 min-w-0 items-start gap-2 py-3 font-medium text-primary hover:underline">
                <LinkIcon size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-all">{link}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
      {attachments.length > 0 && (
        <ul aria-label="Файли до завдання семінару" className="min-w-0 space-y-2">
          {attachments.map((attachment, index) => {
            const key = attachmentKey(attachment)
            const loading = Boolean(loadingFiles[key])
            const error = fileErrors[key]
            const errorId = `${listId}-file-error-${index}`
            return (
              <li key={key} className="min-w-0">
                <button type="button" disabled={loading} onClick={() => void downloadFile(attachment)}
                  aria-label={`${loading ? 'Готуємо файл' : error ? 'Повторити завантаження файлу' : 'Завантажити файл'} ${attachment.file_name}`}
                  aria-busy={loading} aria-describedby={error ? errorId : undefined}
                  className="inline-flex min-h-11 w-full min-w-0 items-start gap-2.5 rounded-xl border border-primary/15 bg-background px-3 py-2.5 text-left text-primary hover:bg-primary/5 disabled:opacity-50">
                  {loading ? <Loader2 size={17} aria-hidden="true" className="mt-1 shrink-0 animate-spin" /> : <Download size={17} aria-hidden="true" className="mt-1 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="block break-all text-sm font-medium">{attachment.file_name}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {formatSeminarFileSize(attachment.file_size)} · {loading ? 'Готуємо файл…' : error ? 'Повторити завантаження' : 'Завантажити'}
                    </span>
                  </span>
                </button>
                {error && <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">{error}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
