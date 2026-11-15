import { useEffect, useId, useState } from 'react'
import { ArrowRight, Wrench } from 'lucide-react'
import { loadPartnerTools, type PartnerTool } from '../../lib/partnerTools'
import { PartnerToolCard, type PartnerToolOpenHandler } from './PartnerToolCard'
import './partnerTools.css'

export function HomeUsefulTools({ tools, onOpen }: { tools?: PartnerTool[]; onOpen?: PartnerToolOpenHandler }) {
  const headingId = useId()
  const [loaded, setLoaded] = useState<PartnerTool[]>([])
  const [loading, setLoading] = useState(tools === undefined)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (tools !== undefined) { setLoading(false); setFailed(false); return }
    let active = true
    setLoading(true)
    void loadPartnerTools().then(rows => { if (active) { setLoaded(rows); setFailed(false) } }).catch(() => { if (active) setFailed(true) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [tools])
  const published = (tools ?? loaded).filter(tool => tool.status === 'published')
  const selected = published.filter(tool => tool.featured).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'uk')).slice(0, 3)

  return <section className="pt-home-tools" aria-labelledby={headingId}>
    <div className="pt-home-heading"><div><p className="pt-eyebrow">Під рукою</p><h2 id={headingId}>Корисні інструменти</h2><p className="pt-home-description">Сервіси для навчання й щоденних справ від партнерів Xelay.</p></div><a href="/tools" className="pt-inline-link">Усі інструменти <ArrowRight size={17} aria-hidden="true" /></a></div>
    {loading ? <p className="pt-home-note" role="status">Завантажуємо інструменти…</p>
      : selected.length ? <div className="pt-home-grid">{selected.map(tool => <PartnerToolCard key={tool.id} tool={tool} source="home" compact onOpen={onOpen} />)}</div>
      : <div className="pt-home-empty"><span><Wrench size={21} strokeWidth={1.6} /></span><p>{failed ? 'Інструменти тимчасово недоступні. Спробуйте відкрити розділ ще раз.' : published.length ? 'Усі доступні інструменти — у каталозі.' : 'Збираємо перші корисні сервіси. Незабаром вони з’являться тут.'}</p><a href="/tools" aria-label="Перейти до корисних інструментів"><ArrowRight size={19} /></a></div>}
  </section>
}
