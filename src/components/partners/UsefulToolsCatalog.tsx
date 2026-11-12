import { useId, useMemo, useState } from 'react'
import { ArrowUpRight, Search, SlidersHorizontal, Wrench } from 'lucide-react'
import type { PartnerTool } from '../../lib/partnerTools'
import { PARTNER_TOOL_CATEGORIES, PartnerToolCard, type PartnerToolOpenHandler } from './PartnerToolCard'
import './partnerTools.css'

export interface UsefulToolsCatalogProps {
  tools: PartnerTool[]
  loading?: boolean
  error?: string
  onRetry?: () => void
  onOpen?: PartnerToolOpenHandler
}

export function UsefulToolsCatalog({ tools, loading = false, error = '', onRetry, onOpen }: UsefulToolsCatalogProps) {
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const searchId = useId()
  const published = useMemo(() => tools.filter(tool => tool.status === 'published').sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'uk')), [tools])
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('uk-UA')
    return published.filter(tool => (category === 'all' || tool.category === category) && (!needle || `${tool.name} ${tool.description}`.toLocaleLowerCase('uk-UA').includes(needle)))
  }, [published, category, query])
  const resultLabel = new Intl.PluralRules('uk-UA').select(visible.length)
  const clearFilters = () => { setCategory('all'); setQuery('') }

  return <main className="pt-catalog" aria-labelledby="pt-catalog-title">
    <header className="pt-catalog-header">
      <div className="pt-catalog-intro"><p className="pt-eyebrow"><span />Партнери Xelay</p><h1 id="pt-catalog-title">Корисні<br /><em>інструменти.</em></h1><p className="pt-catalog-description">Для навчання, роботи й власних проєктів. Продукти та сервіси, до яких зручно повернутися.</p></div>
      <div className="pt-catalog-aside" aria-hidden="true"><span className="pt-catalog-mark"><Wrench size={34} strokeWidth={1.4} /></span><p>Потрібний сервіс.<br /><strong>Під рукою.</strong></p><ArrowUpRight size={25} strokeWidth={1.4} /></div>
    </header>

    <div className="pt-catalog-toolbar">
      <div className="pt-filter-list" role="group" aria-label="Категорії інструментів">{PARTNER_TOOL_CATEGORIES.map(item => <button key={item.value} type="button" aria-pressed={category === item.value} onClick={() => setCategory(item.value)}>{item.label}</button>)}</div>
      <div className="pt-search"><Search size={18} aria-hidden="true" /><label className="pt-sr-only" htmlFor={searchId}>Пошук інструментів</label><input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Знайти інструмент" maxLength={120} /></div>
    </div>

    {loading ? <div className="pt-tool-grid" role="status" aria-label="Завантажуємо інструменти">{[0, 1, 2].map(index => <div className="pt-tool-skeleton" key={index}><span /><span /><span /></div>)}</div>
      : error ? <div className="pt-catalog-empty" role="alert"><span className="pt-empty-icon"><Wrench size={26} /></span><h2>Не вдалося завантажити інструменти</h2><p>{error}</p>{onRetry && <button type="button" className="pt-button" onClick={onRetry}>Спробувати ще раз</button>}</div>
      : !published.length ? <div className="pt-catalog-empty"><span className="pt-empty-icon"><Wrench size={28} strokeWidth={1.5} /></span><p className="pt-eyebrow">Місце для корисного</p><h2>Перші інструменти вже готуємо</h2><p>Тут з’являться продукти партнерів Xelay з коротким описом і посиланням. Щойно додамо перший — він буде доступний усім.</p><a className="pt-inline-link" href="/">На головну <ArrowUpRight size={16} /></a></div>
      : !visible.length ? <div className="pt-catalog-empty" role="status"><span className="pt-empty-icon"><SlidersHorizontal size={26} /></span><h2>Нічого не знайшлося</h2><p>Спробуйте іншу назву або перегляньте всі категорії.</p><button type="button" className="pt-button" onClick={clearFilters}>Показати всі інструменти</button></div>
      : <><h2 className="pt-sr-only">Каталог інструментів</h2><div className="pt-catalog-result" role="status">{visible.length} {resultLabel === 'one' ? 'інструмент' : resultLabel === 'few' ? 'інструменти' : 'інструментів'}</div><div className="pt-tool-grid">{visible.map(tool => <PartnerToolCard key={tool.id} tool={tool} onOpen={onOpen} />)}</div></>}

    <div className="pt-catalog-footnote"><span>Відкриваємо посилання в новій вкладці. Умови та ціни визначає сам сервіс.</span><span>Переходи враховуються в узагальненій статистиці Xelay за допомогою анонімного ідентифікатора браузера.</span></div>
  </main>
}
