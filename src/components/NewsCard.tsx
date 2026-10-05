import { CalendarDays, ExternalLink, Paperclip, Pin } from 'lucide-react'
import { formatNewsDate, getNewsAttachments, getNewsLinks, NEWS_TYPE_LABELS, NewsPost } from '../lib/news'
import { NewsImage } from './NewsImage'

type NewsCardProps = {
  post: NewsPost & { authorName: string }
  onOpen: () => void
}

export function NewsCard({ post, onOpen }: NewsCardProps) {
  const attachments = getNewsAttachments(post.attachments)
  const links = getNewsLinks(post)
  return (
    <button type="button" onClick={onOpen}
      className="xelay-card xelay-news-card group min-w-0 overflow-hidden text-left transition-all hover:-translate-y-0.5 hover:shadow-md">
      <NewsImage imagePath={post.image_path} imageUrl={post.image_url} className="block aspect-video w-full object-cover object-center" />
      <div className="p-5 sm:p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground">{NEWS_TYPE_LABELS[post.post_type]}</span>
          {post.is_pinned && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-700"><Pin size={12} /> Закріплено</span>}
        </div>
        <h2 className="break-words text-lg font-semibold leading-snug group-hover:underline">{post.title}</h2>
        <p className="mt-2 line-clamp-3 break-words text-sm leading-relaxed text-muted-foreground">{post.excerpt}</p>
        {(attachments.length > 0 || links.length > 0) && <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {attachments.length > 0 && <span className="inline-flex items-center gap-1"><Paperclip size={13} aria-hidden="true" /> Файли: {attachments.length}</span>}
          {links.length > 0 && <span className="inline-flex items-center gap-1"><ExternalLink size={13} aria-hidden="true" /> Посилання: {links.length}</span>}
        </div>}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
          <span className="truncate font-medium text-foreground">{post.authorName}</span>
          <span className="inline-flex shrink-0 items-center gap-1.5"><CalendarDays size={13} />{formatNewsDate(post.event_starts_at || post.published_at)}</span>
        </div>
        <span className="mt-4 inline-flex min-h-10 items-center rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground">Детальніше</span>
      </div>
    </button>
  )
}
