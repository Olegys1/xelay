import { useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { getStudyGroupLessonLinks, type StudyGroupLessonLinkSource } from '../lib/studyGroupLinks'

type StudyGroupLessonLinksProps = {
  lesson: StudyGroupLessonLinkSource & { subject: string }
  variant?: 'default' | 'compact'
  className?: string
}

export function StudyGroupLessonLinks({ lesson, variant = 'default', className = '' }: StudyGroupLessonLinksProps) {
  const links = getStudyGroupLessonLinks(lesson)
  const [copyStatus, setCopyStatus] = useState('')
  const credentials = [{ key: 'id', label: 'ID конференції', value: lesson.conference_id?.trim() }, { key: 'code', label: 'Код доступу', value: lesson.conference_access_code?.trim() }].filter(item => item.value)
  if (!links.length && !credentials.length) return null
  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopyStatus(`${label} скопійовано`) }
    catch { setCopyStatus('Не вдалося скопіювати. Виділіть дані та скопіюйте вручну.') }
  }
  return <div className={`space-y-2 ${className}`}>
    {!!links.length && <div className="flex flex-wrap gap-x-4 gap-y-1">
    {links.map((link) => <a key={link.slot} href={link.url} target="_blank" rel="noopener noreferrer"
      aria-label={`${link.label} на заняття «${lesson.subject}» (відкриється в новій вкладці)`}
      className={`inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md font-medium text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${variant === 'compact' ? 'text-xs' : 'text-sm'}`}>
      {variant === 'compact' && <ExternalLink size={12} className="shrink-0" aria-hidden="true" />}
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{link.label}</span>
    </a>)}
    </div>}
    {!!credentials.length && <div className="rounded-xl border border-border bg-muted/30 px-3 py-2">
      <p className={`${variant === 'compact' ? 'text-xs' : 'text-sm'} font-medium`}>Вхід за ID та кодом</p>
      <div className="mt-1 space-y-1">{credentials.map(item => <div key={item.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="min-w-0 break-words">{item.label}: <span className="select-text break-all font-mono text-foreground">{item.value}</span></span>
        <button type="button" onClick={() => void copy(item.label, item.value!)} aria-label={`Скопіювати ${item.label.toLowerCase()} для «${lesson.subject}»`} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 font-medium text-primary hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{copyStatus === `${item.label} скопійовано` ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}Копіювати</button>
      </div>)}</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">У застосунку конференції оберіть «Приєднатися» та введіть ці дані.</p>
      <span role="status" aria-live="polite" className="mt-1 block text-xs text-muted-foreground">{copyStatus}</span>
    </div>}
  </div>
}
