import { useEffect, useId, useRef, useState } from 'react'
import { Download, Link as LinkIcon, Loader2 } from 'lucide-react'
import {
  formatLongTermFileSize, getLongTermTaskFileUrl, type LongTermTaskAttachment,
} from '../lib/longTermTaskResources'
import { getResourceLinkLabels, type ResourceLinkLabels } from '../lib/resourceLinkLabels'

type Props = {
  scopeKey: string
  links: string[]
  linkLabels?: ResourceLinkLabels
  attachments: LongTermTaskAttachment[]
}

const attachmentKey = (attachment: LongTermTaskAttachment) => JSON.stringify([
  attachment.storage_path, attachment.file_name, attachment.file_size, attachment.mime_type,
])

function safeLink(value: string) {
  if (!/^https?:\/\//i.test(value.trim())) return null
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function LongTermTaskResourceList({ scopeKey, links, linkLabels, attachments }: Props) {
  const listId = useId()
  const [loadingFiles, setLoadingFiles] = useState<Record<string, boolean>>({})
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  const active = useRef(true)
  const generation = useRef(0)
  const currentScope = useRef(scopeKey)
  const downloadLocks = useRef(new Set<string>())
  const currentAttachments = useRef(new Set<string>())
  currentScope.current = scopeKey
  currentAttachments.current = new Set(attachments.map(attachmentKey))
  const safeLinks = links.map(safeLink).filter((link): link is string => Boolean(link))
  const labels = getResourceLinkLabels(linkLabels, safeLinks)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      generation.current += 1
      downloadLocks.current.clear()
    }
  }, [])

  useEffect(() => {
    generation.current += 1
    downloadLocks.current.clear()
    setLoadingFiles({})
    setFileErrors({})
  }, [scopeKey])

  const downloadFile = async (attachment: LongTermTaskAttachment) => {
    const key = attachmentKey(attachment)
    if (downloadLocks.current.has(key)) return
    const requestedScope = scopeKey
    const requestedGeneration = generation.current
    const sameScope = () => active.current && requestedScope === currentScope.current
      && requestedGeneration === generation.current
    const isCurrent = () => sameScope() && currentAttachments.current.has(key)
    downloadLocks.current.add(key)
    setLoadingFiles((current) => ({ ...current, [key]: true }))
    setFileErrors((current) => ({ ...current, [key]: '' }))
    try {
      const url = await getLongTermTaskFileUrl(attachment.storage_path, attachment.file_name)
      if (!isCurrent()) return
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = attachment.file_name
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      try { anchor.click() } finally { anchor.remove() }
    } catch {
      if (isCurrent()) setFileErrors((current) => ({ ...current, [key]: 'Не вдалося завантажити файл. Перевірте доступ до групи та повторіть спробу.' }))
    } finally {
      if (requestedScope === currentScope.current && requestedGeneration === generation.current) downloadLocks.current.delete(key)
      if (sameScope()) setLoadingFiles((current) => ({ ...current, [key]: false }))
    }
  }

  if (!safeLinks.length && !attachments.length) return null

  return (
    <section className="mt-3 min-w-0 space-y-2.5" aria-label="Матеріали до довгострокового завдання">
      <h5 className="text-xs font-semibold text-muted-foreground">Матеріали до завдання</h5>
      {safeLinks.length > 0 && <ol className="min-w-0 space-y-1" aria-label="Посилання до завдання">
        {safeLinks.map((link, index) => <li key={`${index}:${link}`} className="min-w-0">
          <a href={link} target="_blank" rel="noopener noreferrer" title={link} className="inline-flex min-h-11 w-full min-w-0 items-start gap-2 rounded-lg py-2.5 text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/40" aria-label={labels[link] ? `Відкрити: ${labels[link]}` : `Відкрити посилання ${index + 1}: ${link}`}>
            <LinkIcon size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">{labels[link] || link}</span>
          </a>
        </li>)}
      </ol>}
      {attachments.length > 0 && <ul className="min-w-0 space-y-2" aria-label="Файли до завдання">
        {attachments.map((attachment, index) => {
          const key = attachmentKey(attachment)
          const loading = Boolean(loadingFiles[key])
          const error = fileErrors[key]
          const errorId = `${listId}-file-${index}-error`
          return <li key={key} className="min-w-0">
            <button type="button" disabled={loading} onClick={() => void downloadFile(attachment)} aria-busy={loading} aria-describedby={error ? errorId : undefined} aria-label={`${loading ? 'Готуємо файл' : error ? 'Повторити завантаження' : 'Завантажити файл'}: ${attachment.file_name}`} className="inline-flex min-h-11 w-full min-w-0 items-start gap-2.5 rounded-xl border border-primary/15 bg-primary/5 px-3 py-2.5 text-left text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none">
              {loading ? <Loader2 size={17} className="mt-1 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Download size={17} className="mt-1 shrink-0" aria-hidden="true" />}
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-medium [overflow-wrap:anywhere]">{attachment.file_name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{formatLongTermFileSize(attachment.file_size)} · {loading ? 'Готуємо файл…' : error ? 'Спробувати ще раз' : 'Завантажити'}</span>
              </span>
            </button>
            {error && <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">{error}</p>}
          </li>
        })}
      </ul>}
    </section>
  )
}
