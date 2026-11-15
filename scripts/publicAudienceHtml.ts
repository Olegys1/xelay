import { HOME_ECOSYSTEM_CONTENT, PUBLIC_AUDIENCE_LINKS, PUBLIC_AUDIENCE_PAGES, type PublicAudience } from '../src/lib/publicSeoContent.ts'

const escape = (value: string | number) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const arrow = '<span aria-hidden="true">↗</span>'

function roleLinks(exclude?: string) {
  return PUBLIC_AUDIENCE_LINKS.filter(link => link.path !== exclude).map(link => `<a href="${escape(link.path)}"><span><strong>${escape(link.label)}</strong><span>${escape(link.summary)}</span></span>${arrow}</a>`).join('')
}

function faq(items: readonly { question: string; answer: string }[]) {
  return items.map(item => `<details><summary>${escape(item.question)}<span aria-hidden="true">+</span></summary><p>${escape(item.answer)}</p></details>`).join('')
}

export function renderAudienceBody(audience: PublicAudience): string {
  const page = PUBLIC_AUDIENCE_PAGES[`/${audience}`]
  return `<main class="xp-public" id="public-audience-main"><div class="xp-container">
<nav class="xp-static-nav" aria-label="Навігація Xelay"><a href="/" class="xp-static-brand">Xelay</a><div>${PUBLIC_AUDIENCE_LINKS.map(link => `<a href="${escape(link.path)}"${link.path === page.path ? ' aria-current="page"' : ''}>${escape(link.label)}</a>`).join('')}<a href="/guides/">Посібники</a></div></nav>
<nav class="xp-breadcrumb" aria-label="Навігаційний ланцюжок"><ol><li><a href="/">Xelay</a></li><li aria-current="page">${escape(page.roleName)}</li></ol></nav>
<section class="xp-hero" aria-labelledby="xp-page-title"><div class="xp-hero-copy"><p class="xp-eyebrow"><span></span>${escape(page.eyebrow)}</p><h1 id="xp-page-title">${escape(page.heading)}</h1><p class="xp-lead">${escape(page.intro)}</p><div class="xp-actions"><a class="xp-button xp-button-primary" href="${escape(page.primaryCta.href)}">${escape(page.primaryCta.label)}<span aria-hidden="true">→</span></a><a class="xp-button xp-button-secondary" href="${escape(page.secondaryCta.href)}">${escape(page.secondaryCta.label)}${arrow}</a></div><p class="xp-hero-note">Ваші навчальні розділи відкриваються після входу й підтвердження доступу.</p></div><aside class="xp-connection" aria-label="Як пов’язані навчальні дії в Xelay"><div class="xp-connection-brand"><span class="xp-wordmark">Xelay<span>Екосистема навчання</span></span></div><div class="xp-connection-flow">${page.chain.map((step, index) => `<div class="xp-flow-step"><span class="xp-flow-number">0${index + 1}</span><strong>${escape(step)}</strong></div>`).join('')}</div><p>Потрібне зібрано навколо вашої навчальної групи.</p></aside></section>
<section class="xp-section" aria-labelledby="xp-features-title"><div class="xp-section-heading"><div><p class="xp-eyebrow">Що вже працює</p><h2 id="xp-features-title">Зручно у щоденному навчанні.</h2></div><span class="xp-section-caption">Від першої пари до перевіреної роботи</span></div><div class="xp-features">${page.features.map((feature, index) => `<article class="xp-feature"><span class="xp-feature-icon" aria-hidden="true">0${index + 1}</span><h3>${escape(feature.title)}</h3><p>${escape(feature.text)}</p></article>`).join('')}</div></section>
<section class="xp-start xp-section" aria-labelledby="xp-start-title"><div class="xp-section-heading"><div><p class="xp-eyebrow">Перші кроки</p><h2 id="xp-start-title">Почніть зі свого простору.</h2></div><a class="xp-inline-link" href="/guides/">Покрокові посібники${arrow}</a></div><ol class="xp-steps">${page.steps.map((step, index) => `<li><span class="xp-step-number">0${index + 1}</span><div><h3>${escape(step.title)}</h3><p>${escape(step.text)}</p></div></li>`).join('')}</ol></section>
<section class="xp-faq-section xp-section" aria-labelledby="xp-faq-title"><div><p class="xp-eyebrow">Корисно знати</p><h2 id="xp-faq-title">Кілька відповідей<br>перед початком.</h2><p class="xp-faq-intro">Доступ, публікація та щоденні дії у Xelay.</p></div><div class="xp-faq">${faq(page.faq)}</div></section>
<section class="xp-final" aria-labelledby="xp-final-title"><div><p class="xp-eyebrow">Різні ролі. Спільне навчання.</p><h2 id="xp-final-title">Побачте Xelay<br>з іншого боку.</h2></div><div class="xp-role-links">${roleLinks(page.path)}</div></section>
<footer class="xp-static-footer"><a href="/">Xelay</a><a href="/community">Спільнота</a><a href="/guides/">Посібники</a><a href="/privacy-policy">Конфіденційність</a><a href="/contacts">Контакти</a></footer>
</div></main>`
}

export function renderHomeEcosystemBody(): string {
  return `<section class="xp-home-intro" aria-labelledby="xp-ecosystem-title"><div class="xp-home-heading"><p class="xp-eyebrow">Більше про Xelay</p><h2 id="xp-ecosystem-title">${escape(HOME_ECOSYSTEM_CONTENT.heading)}</h2><p>${escape(HOME_ECOSYSTEM_CONTENT.intro)}</p></div><div class="xp-home-features">${HOME_ECOSYSTEM_CONTENT.features.map(item => `<article><h3>${escape(item.title)}</h3><p>${escape(item.text)}</p></article>`).join('')}</div><nav class="xp-home-roles" aria-label="Можливості Xelay для різних ролей">${PUBLIC_AUDIENCE_LINKS.map(link => `<a href="${escape(link.path)}"><span>${escape(link.label)}</span>${arrow}</a>`).join('')}</nav><div class="xp-home-faq"><h3>Коротко про початок роботи</h3>${faq(HOME_ECOSYSTEM_CONTENT.faq)}</div></section>`
}
