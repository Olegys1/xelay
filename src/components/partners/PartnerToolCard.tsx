import { useState, type MouseEvent } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { recordPartnerToolClick, safePartnerToolUrl, type PartnerTool } from '../../lib/partnerTools'
import './partnerTools.css'

export const PARTNER_TOOL_CATEGORIES = [
  { value: 'all', label: 'Усі інструменти' },
  { value: 'study', label: 'Навчання' },
  { value: 'productivity', label: 'Продуктивність' },
  { value: 'career', label: 'Кар’єра' },
  { value: 'other', label: 'Інше' },
] as const

export type PartnerToolSource = 'catalog' | 'home'
export type PartnerToolOpenHandler = (tool: PartnerTool, source: PartnerToolSource) => boolean | void

function logoUrl(value: string): string | undefined {
  const safeUrl = safePartnerToolUrl(value)
  if (safeUrl) return safeUrl
  if (!import.meta.env.DEV || typeof window === 'undefined') return undefined
  if (value.length <= 2_800_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value
  try {
    const url = new URL(value)
    return url.protocol === 'blob:' && url.origin === window.location.origin ? url.href : undefined
  } catch { return undefined }
}

export function PartnerToolLogo({ tool, compact = false }: { tool: PartnerTool; compact?: boolean }) {
  const [failed, setFailed] = useState(false)
  const [wide, setWide] = useState(false)
  const source = logoUrl(tool.logoUrl)
  const initials = tool.name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] || '').join('').toLocaleUpperCase('uk-UA')
  return <span className={`pt-tool-logo${compact ? ' pt-tool-logo--compact' : ''}${wide && source && !failed ? ' pt-tool-logo--wide' : ''}`} aria-hidden="true">
    {source && !failed ? <img src={source} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={event => { const image = event.currentTarget; setWide(image.naturalHeight > 0 && image.naturalWidth / image.naturalHeight >= 1.8) }} onError={() => setFailed(true)} /> : <span>{initials || 'X'}</span>}
  </span>
}

export function PartnerToolCard({ tool, source = 'catalog', compact = false, onOpen }: {
  tool: PartnerTool
  source?: PartnerToolSource
  compact?: boolean
  onOpen?: PartnerToolOpenHandler
}) {
  const href = safePartnerToolUrl(tool.destinationUrl)
  const category = PARTNER_TOOL_CATEGORIES.find(item => item.value === tool.category)?.label || 'Інше'
  const handleOpen = (event: MouseEvent<HTMLAnchorElement>, button: 0 | 1) => {
    if (!event.nativeEvent.isTrusted || event.button !== button) return
    if (onOpen) { if (onOpen(tool, source) === false) event.preventDefault() }
    else void recordPartnerToolClick(tool.id, source).catch(() => {})
  }

  return <article className={`pt-tool-card${compact ? ' pt-tool-card--compact' : ''}`}>
    <div className="pt-tool-card-top"><PartnerToolLogo key={`${tool.id}:${tool.logoUrl}`} tool={tool} compact={compact} />{!compact && <span className="pt-tool-category">{category}</span>}</div>
    <div className="pt-tool-card-copy"><h3>{tool.name}</h3><p>{tool.description}</p></div>
    {href ? <a className="pt-tool-open" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={event => handleOpen(event, 0)} onAuxClick={event => handleOpen(event, 1)} aria-label={`Відкрити ${tool.name} у новій вкладці`}>
      <span>{compact ? 'Відкрити' : 'До інструмента'}</span><ArrowUpRight size={compact ? 17 : 19} aria-hidden="true" />
    </a> : <span className="pt-tool-unavailable">Посилання тимчасово недоступне</span>}
  </article>
}
