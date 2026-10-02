export type ChatMentionProfile = {
  id: string
  full_name?: string | null
  username?: string | null
  avatar_url?: string | null
}

export type ChatMentionQuery = { start: number; end: number; query: string }

export function getChatMentionQuery(value: string, caret: number): ChatMentionQuery | null {
  const cursor = Math.max(0, Math.min(caret, value.length))
  const match = /(^|[^\p{L}\p{N}_.@-])@([\p{L}\p{N}_.-]{0,30})$/u.exec(value.slice(0, cursor))
  if (!match) return null
  const start = cursor - match[2].length - 1
  const remaining = /^[\p{L}\p{N}_.-]*/u.exec(value.slice(cursor))?.[0] || ''
  return { start, end: cursor + remaining.length, query: match[2].toLocaleLowerCase() }
}

export async function copyChatText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* Older browsers and denied clipboard permission use the local fallback. */ }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none'
  const container = active?.closest('[role="dialog"]') || document.body
  container.appendChild(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
    active?.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}
