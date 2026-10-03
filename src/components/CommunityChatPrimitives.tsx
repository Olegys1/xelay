import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Loader2, X, Users, Megaphone } from 'lucide-react'
import { chatAvatarUrl, type ChatProfile, type ChatSpace } from '../lib/chatSpaces'

export const chatInput = 'w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-base text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 sm:text-sm disabled:opacity-50'
export const chatButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'
export const chatPrimary = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50'
export const chatIcon = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-40'

let openDialogs = 0
let originalBodyOverflow = ''

export function ChatDialog({ title, children, busy = false, onClose, wide = false }: { title: string; children: ReactNode; busy?: boolean; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    if (openDialogs === 0) originalBodyOverflow = document.body.style.overflow
    openDialogs += 1
    document.body.style.overflow = 'hidden'
    ref.current?.focus()
    return () => {
      openDialogs = Math.max(0, openDialogs - 1)
      if (openDialogs === 0) document.body.style.overflow = originalBodyOverflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return <div className="xelay-dialog-backdrop fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-3 backdrop-blur-sm" onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()} onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) close.current() }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy} tabIndex={-1} className={`xelay-dialog-panel flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl outline-none ${wide ? 'max-w-4xl' : 'max-w-xl'}`} onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) close.current() }
      if (event.key !== 'Tab') return
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || []).filter((item) => item.tabIndex >= 0 && item.offsetParent !== null)
      const first = items[0]; const last = items[items.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus() }
    }}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4"><h2 className="min-w-0 flex-1 break-words text-lg font-semibold">{title}</h2><button type="button" className={chatIcon} disabled={busy} onClick={onClose} aria-label="Закрити"><X size={19} /></button></header>
      <div className="min-h-0 overflow-y-auto p-5">{children}</div>
    </div>
  </div>
}
export function ChatField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 space-y-1.5"><span className="block text-sm font-medium">{label}</span>{children}</label>
}
export function ChatAvatar({ space, size = 'h-11 w-11' }: { space: ChatSpace; size?: string }) {
  const url = chatAvatarUrl(space)
  return url ? <img src={url} alt="" className={`${size} shrink-0 rounded-2xl object-cover`} /> : <span className={`${size} flex shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary`} aria-hidden="true">{space.kind === 'channel' ? <Megaphone size={21} /> : <Users size={21} />}</span>
}
export function ChatPerson({ id, profile, small = false }: { id: string; profile?: ChatProfile; small?: boolean }) {
  const name = profile?.full_name || profile?.username || 'Учасник Xelay'
  return <Link to="/user/$id" params={{ id }} className="flex min-w-0 items-center gap-2 rounded-lg hover:text-primary" aria-label={`Профіль: ${name}`}>
    {profile?.avatar_url ? <img src={profile.avatar_url} alt="" className={`${small ? 'h-7 w-7' : 'h-9 w-9'} shrink-0 rounded-full object-cover`} loading="lazy" /> : <span className={`${small ? 'h-7 w-7' : 'h-9 w-9'} flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold`}>{name.slice(0, 2).toUpperCase()}</span>}
    <span className="min-w-0"><span className={`block truncate ${small ? 'text-xs' : 'text-sm'} font-medium`}>{name}</span>{!small && profile?.username && <span className="block truncate text-xs text-muted-foreground">@{profile.username.replace(/^@/, '')}</span>}</span>
  </Link>
}
export function ChatSpinner() { return <div className="flex justify-center p-8" role="status" aria-label="Завантаження"><Loader2 className="animate-spin text-primary" size={24} /></div> }
