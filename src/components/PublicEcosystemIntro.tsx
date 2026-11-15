import { ArrowUpRight } from 'lucide-react'
import { HOME_ECOSYSTEM_CONTENT, PUBLIC_AUDIENCE_LINKS } from '../lib/publicSeoContent'
import '../pages/public-audience.css'

export function PublicEcosystemIntro() {
  return <section className="xp-home-intro" aria-labelledby="xp-ecosystem-title">
    <div className="xp-home-heading"><p className="xp-eyebrow">Більше про Xelay</p><h2 id="xp-ecosystem-title">{HOME_ECOSYSTEM_CONTENT.heading}</h2><p>{HOME_ECOSYSTEM_CONTENT.intro}</p></div>
    <div className="xp-home-features">{HOME_ECOSYSTEM_CONTENT.features.map(item => <article key={item.title}><h3>{item.title}</h3><p>{item.text}</p></article>)}</div>
    <nav className="xp-home-roles" aria-label="Можливості Xelay для різних ролей">{PUBLIC_AUDIENCE_LINKS.map(link => <a href={link.path} key={link.path}><span>{link.label}</span><ArrowUpRight size={18} /></a>)}</nav>
    <div className="xp-home-faq"><h3>Коротко про початок роботи</h3>{HOME_ECOSYSTEM_CONTENT.faq.map(item => <details key={item.question}><summary>{item.question}<span aria-hidden="true">+</span></summary><p>{item.answer}</p></details>)}</div>
  </section>
}
