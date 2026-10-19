import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Send } from 'lucide-react'
import { telegramContactLinks } from '../lib/telegram'

export function TelegramContact({ value }: { value: string }) {
  const links = telegramContactLinks(value)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setCopied(false); setCopyError(false) }, [value])

  if (!links) return <div className="mt-2 text-sm">
    <p className="break-all text-muted-foreground">Telegram: {value.slice(0, 128)}</p>
    <p className="mt-1 text-xs text-destructive">Некоректний нік або посилання. Уточніть контакт у заявника через профіль Xelay.</p>
  </div>

  async function copyUsername() {
    if (!links) return
    try {
      await navigator.clipboard.writeText(`@${links.username}`)
      if (alive.current) { setCopied(true); setCopyError(false) }
    } catch {
      if (alive.current) { setCopied(false); setCopyError(true) }
    }
  }

  const actionClass = 'inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
  return <div className="mt-2 min-w-0">
    <p className="select-text break-all text-sm font-medium">Telegram: @{links.username}</p>
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <a href={links.app} rel="noreferrer" className={`${actionClass} border-primary/25 text-primary`} aria-label={`Відкрити @${links.username} у застосунку Telegram`}><Send size={14} aria-hidden="true" />У Telegram</a>
      <a href={links.web} target="_blank" rel="noopener noreferrer" className={actionClass} aria-label={`Відкрити @${links.username} у Telegram Web`}><ExternalLink size={14} aria-hidden="true" />У браузері</a>
      <button type="button" onClick={() => void copyUsername()} className={actionClass} aria-label={`Скопіювати нік @${links.username}`}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? 'Нік скопійовано' : 'Копіювати нік'}</button>
    </div>
    <p className="mt-1.5 text-xs text-muted-foreground">Не відкривається? Скопіюйте нік і знайдіть людину в Telegram. Якщо її немає — уточніть контакт у заявника.</p>
    <span role="status" aria-live="polite" className={copyError ? 'mt-1 block text-xs text-destructive' : 'sr-only'}>{copyError ? 'Не вдалося скопіювати. Виділіть нік вище та скопіюйте вручну.' : copied ? 'Нік скопійовано.' : ''}</span>
  </div>
}
