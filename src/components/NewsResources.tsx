import { useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, FileText, Loader2 } from 'lucide-react'
import { getNewsAttachments, getNewsLinks, type NewsAttachment } from '../lib/news'
import { createNewsFileDownloadUrl, formatNewsFileSize, newsFileName } from '../lib/newsMedia'

type NewsResourcesProps = {
  attachments?: unknown
  links?: unknown
  linkUrl?: string | null
  className?: string
}

function NewsFileDownload({ attachment }: { attachment: NewsAttachment }) {
  const fileName = newsFileName(attachment.file_name)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const downloadLock = useRef(false)
  const active = useRef(true)

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  const download = async () => {
    if (downloadLock.current) return
    downloadLock.current = true
    setLoading(true)
    setError('')
    try {
      const url = await createNewsFileDownloadUrl(attachment)
      if (!active.current) return
      // The signed endpoint supplies Content-Disposition. A same-tab download
      // anchor also works after an async request without opening a blocked popup.
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.rel = 'noopener noreferrer'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    } catch (downloadError) {
      if (!active.current) return
      console.error('Could not download news attachment:', downloadError)
      setError('Не вдалося завантажити файл. Спробуйте ще раз.')
    } finally {
      downloadLock.current = false
      if (active.current) setLoading(false)
    }
  }

  return (
    <li className="min-w-0">
      <button type="button" onClick={() => void download()} disabled={loading}
        aria-busy={loading} aria-label={`${loading ? 'Завантажуємо' : 'Завантажити'} файл ${fileName}`}
        className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-border bg-background px-3 py-3 text-left transition-colors hover:bg-muted/70 disabled:cursor-wait disabled:opacity-70">
        <FileText size={20} aria-hidden="true" className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium [overflow-wrap:anywhere]">{fileName}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{formatNewsFileSize(attachment.file_size)}</span>
        </span>
        {loading ? <Loader2 size={17} aria-hidden="true" className="shrink-0 animate-spin text-muted-foreground" /> : <Download size={17} aria-hidden="true" className="shrink-0 text-muted-foreground" />}
      </button>
      {error && <p role="alert" className="mt-1.5 text-xs text-destructive">{error}</p>}
    </li>
  )
}

export function NewsResources({ attachments, links, linkUrl, className = '' }: NewsResourcesProps) {
  const files = getNewsAttachments(attachments)
  const resourceLinks = getNewsLinks({ links, link_url: linkUrl })
  if (!files.length && !resourceLinks.length) return null

  return (
    <div className={`min-w-0 space-y-5 ${className}`}>
      {files.length > 0 && <section aria-label="Файли до новини">
        <h3 className="mb-2 text-sm font-semibold">Файли <span className="ml-1 text-xs font-normal text-muted-foreground">{files.length}</span></h3>
        <ul className="space-y-2">
          {files.map((attachment) => <NewsFileDownload key={attachment.path} attachment={attachment} />)}
        </ul>
      </section>}
      {resourceLinks.length > 0 && <section aria-label="Посилання до новини">
        <h3 className="mb-2 text-sm font-semibold">Посилання</h3>
        <ul className="space-y-2">
          {resourceLinks.map((link, index) => <li key={`${link.url}-${index}`}>
            <a href={link.url} title={link.url} target="_blank" rel="noopener noreferrer"
              className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10">
              <ExternalLink size={17} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{link.label || new URL(link.url).hostname}</span>
            </a>
          </li>)}
        </ul>
      </section>}
    </div>
  )
}
