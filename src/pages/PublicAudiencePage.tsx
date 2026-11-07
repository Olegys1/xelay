import { ArrowRight, ArrowUpRight, BookOpen, CalendarDays, Check, ClipboardCheck, FileText, GraduationCap, Layers3, UsersRound } from 'lucide-react'
import { PUBLIC_AUDIENCE_LINKS, PUBLIC_AUDIENCE_PAGES, type PublicAudience } from '../lib/publicSeoContent'
import './public-audience.css'

const featureIcons = [CalendarDays, FileText, ClipboardCheck, BookOpen, UsersRound, Layers3]

export function PublicAudiencePage({ audience }: { audience: PublicAudience }) {
  const page = PUBLIC_AUDIENCE_PAGES[`/${audience}`]
  const others = PUBLIC_AUDIENCE_LINKS.filter(link => link.path !== page.path)

  return <main className="xp-public" id="public-audience-main">
    <div className="xp-container">
      <nav className="xp-breadcrumb" aria-label="Навігаційний ланцюжок"><ol><li><a href="/">Xelay</a></li><li aria-current="page">{page.roleName}</li></ol></nav>
      <section className="xp-hero" aria-labelledby="xp-page-title">
        <div className="xp-hero-copy">
          <p className="xp-eyebrow"><span />{page.eyebrow}</p>
          <h1 id="xp-page-title">{page.heading}</h1>
          <p className="xp-lead">{page.intro}</p>
          <div className="xp-actions"><a className="xp-button xp-button-primary" href={page.primaryCta.href}>{page.primaryCta.label}<ArrowRight size={18} /></a><a className="xp-button xp-button-secondary" href={page.secondaryCta.href}>{page.secondaryCta.label}<ArrowUpRight size={17} /></a></div>
          <p className="xp-hero-note">Ваші навчальні розділи відкриваються після входу й підтвердження доступу.</p>
        </div>
        <aside className="xp-connection" aria-label="Як пов’язані навчальні дії в Xelay">
          <div className="xp-connection-brand"><span className="xp-wordmark">Xelay<span>Екосистема навчання</span></span><GraduationCap size={30} strokeWidth={1.4} /></div>
          <div className="xp-connection-flow">{page.chain.map((step, index) => <div key={step} className="xp-flow-step"><span className="xp-flow-number">0{index + 1}</span><strong>{step}</strong><Check size={17} /></div>)}</div>
          <p>Потрібне зібрано навколо вашої навчальної групи.</p>
        </aside>
      </section>

      <section className="xp-section" aria-labelledby="xp-features-title">
        <div className="xp-section-heading"><div><p className="xp-eyebrow">Що вже працює</p><h2 id="xp-features-title">Зручно у щоденному навчанні.</h2></div><span className="xp-section-caption">Від першої пари до перевіреної роботи</span></div>
        <div className="xp-features">{page.features.map((feature, index) => { const Icon = featureIcons[index % featureIcons.length]; return <article key={feature.title} className="xp-feature"><span className="xp-feature-icon"><Icon size={23} strokeWidth={1.6} /></span><h3>{feature.title}</h3><p>{feature.text}</p></article> })}</div>
      </section>

      <section className="xp-start xp-section" aria-labelledby="xp-start-title">
        <div className="xp-section-heading"><div><p className="xp-eyebrow">Перші кроки</p><h2 id="xp-start-title">Почніть зі свого простору.</h2></div><a className="xp-inline-link" href="/guides/">Покрокові посібники<ArrowUpRight size={17} /></a></div>
        <ol className="xp-steps">{page.steps.map((step, index) => <li key={step.title}><span className="xp-step-number">0{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>)}</ol>
      </section>

      <section className="xp-faq-section xp-section" aria-labelledby="xp-faq-title"><div><p className="xp-eyebrow">Корисно знати</p><h2 id="xp-faq-title">Кілька відповідей<br />перед початком.</h2><p className="xp-faq-intro">Доступ, публікація та щоденні дії у Xelay.</p></div><div className="xp-faq">{page.faq.map(item => <details key={item.question}><summary>{item.question}<span aria-hidden="true">+</span></summary><p>{item.answer}</p></details>)}</div></section>

      <section className="xp-final" aria-labelledby="xp-final-title"><div><p className="xp-eyebrow">Різні ролі. Спільне навчання.</p><h2 id="xp-final-title">Побачте Xelay<br />з іншого боку.</h2></div><div className="xp-role-links">{others.map(link => <a href={link.path} key={link.path}><span><strong>{link.label}</strong><span>{link.summary}</span></span><ArrowUpRight size={24} /></a>)}</div></section>
    </div>
  </main>
}
