import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link } from '@tanstack/react-router'
import { getChatMentionQuery, type ChatMentionProfile } from '../lib/chatMessageText'

export type { ChatMentionProfile } from '../lib/chatMessageText'

const mentionIndexes = new WeakMap<ChatMentionProfile[], Map<string, ChatMentionProfile>>()
function memberIndex(profiles: ChatMentionProfile[]) {
  let index = mentionIndexes.get(profiles)
  if (!index) {
    index = new Map(profiles.filter((profile) => profile.username).map((profile) => [profile.username!.toLocaleLowerCase(), profile]))
    mentionIndexes.set(profiles, index)
  }
  return index
}

export function ChatMessageText({ text, profiles }: { text: string; profiles: ChatMentionProfile[] }) {
  if (!text.includes('@')) return <>{text}</>
  const members = memberIndex(profiles)
  const parts: ReactNode[] = []
  const pattern = /(^|[^\p{L}\p{N}_.@-])@([\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index! + match[1].length
    let nickname = match[2]
    let profile = members.get(nickname.toLocaleLowerCase())
    // A sentence-ending period is not part of a nickname unless it matches a member.
    while (!profile && /[.-]$/.test(nickname)) {
      nickname = nickname.slice(0, -1)
      profile = members.get(nickname.toLocaleLowerCase())
    }
    if (!profile) continue
    parts.push(text.slice(offset, start))
    parts.push(<Link key={`${start}-${profile.id}`} to="/user/$id" params={{ id: profile.id }} className="font-medium text-primary hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" title={profile.full_name || `@${nickname}`}>@{nickname}</Link>)
    offset = start + nickname.length + 1
  }
  parts.push(text.slice(offset))
  return <>{parts}</>
}

type SuggestionProps = {
  value: string
  caret: number
  profiles: ChatMentionProfile[]
  onSelect: (text: string, caret: number) => void
  inputRef?: RefObject<HTMLTextAreaElement | null>
}

export function ChatMentionSuggestions({ value, caret, profiles, onSelect, inputRef }: SuggestionProps) {
  const query = getChatMentionQuery(value, caret)
  const queryKey = query ? `${query.start}:${query.query}` : ''
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const id = useId()
  const list = useRef<HTMLDivElement>(null)
  const suggestions = useMemo(() => {
    if (!query) return []
    const seen = new Set<string>()
    return profiles.filter((profile) => {
      if (!profile.username || seen.has(profile.id)) return false
      seen.add(profile.id)
      return profile.username.toLocaleLowerCase().startsWith(query.query)
        || (profile.full_name || '').toLocaleLowerCase().includes(query.query)
    }).sort((a, b) => a.username!.localeCompare(b.username!)).slice(0, 8)
  }, [profiles, queryKey])
  const visible = Boolean(query && suggestions.length && dismissed !== queryKey)
  const active = Math.min(selected, Math.max(0, suggestions.length - 1))

  useEffect(() => { setSelected(0); setDismissed(null) }, [queryKey])
  useEffect(() => {
    const button = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!button || !list.current) return
    const row = button.getBoundingClientRect()
    const bounds = list.current.getBoundingClientRect()
    if (row.top < bounds.top) list.current.scrollTop -= bounds.top - row.top
    else if (row.bottom > bounds.bottom) list.current.scrollTop += row.bottom - bounds.bottom
  }, [active, visible])

  const choose = (profile: ChatMentionProfile) => {
    if (!query || !profile.username) return
    const suffix = value.slice(query.end)
    const inserted = `@${profile.username}${/^\s/.test(suffix) ? '' : ' '}`
    onSelect(value.slice(0, query.start) + inserted + suffix, query.start + inserted.length)
    setDismissed(queryKey)
  }

  useEffect(() => {
    if (!visible || !inputRef?.current) return
    const keyboard = (event: KeyboardEvent) => {
      if (event.target !== inputRef.current || event.isComposing || event.keyCode === 229) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setSelected((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDismissed(queryKey)
      } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        choose(suggestions[active])
      }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => document.removeEventListener('keydown', keyboard, true)
  }, [visible, inputRef, value, caret, suggestions, active, queryKey, onSelect])

  if (!visible) return null
  return <div ref={list} id={id} role="listbox" aria-label="Згадати учасника" className="mb-2 max-h-56 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 shadow-sm">
    {suggestions.map((profile, index) => <button key={profile.id} type="button" role="option" aria-selected={index === active} tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()} onClick={() => choose(profile)}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted ${index === active ? 'bg-muted' : ''}`}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-xs font-semibold text-primary">{profile.avatar_url ? <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" /> : (profile.full_name || profile.username)?.charAt(0).toLocaleUpperCase()}</span>
      <span className="min-w-0"><span className="block truncate text-xs font-semibold text-foreground">{profile.full_name || `@${profile.username}`}</span><span className="block truncate text-[11px] text-muted-foreground">@{profile.username}</span></span>
    </button>)}
  </div>
}
