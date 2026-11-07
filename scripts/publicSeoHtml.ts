import { CATEGORY_META } from '../src/lib/categoryMeta.ts'
import { CATEGORIES, categoryToSlug, slugToCategory } from '../src/types/index.ts'
import { metadataForPath, notFoundSeo, PRIVATE_SPA_PATHS, PUBLIC_STATIC_PATHS, categorySeoPaths, type PageSeo } from '../src/lib/seo.ts'
import { PUBLIC_AUDIENCE_PAGES, type PublicAudience } from '../src/lib/publicSeoContent.ts'
import { renderAudienceBody, renderHomeEcosystemBody } from './publicAudienceHtml.ts'

export const escapeSeoHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export const PUBLIC_ROOT_START = '<!--xelay-public-root-start-->'
export const PUBLIC_ROOT_END = '<!--xelay-public-root-end-->'
export const seoOutputPath = (path: string) => `seo/${path === '/' ? 'home' : path.slice(1).replaceAll('/', '-')}.html`
const roleLinks = '<a href="/students">Студентам</a> · <a href="/headmen">Старостам</a> · <a href="/teachers">Викладачам</a>'
const categoryLinks = () => CATEGORIES.map(name => `<li><a href="/category/${categoryToSlug(name)}">${escapeSeoHtml(CATEGORY_META[name].title)}</a></li>`).join('')

export function publicPageBody(path: string): string {
  if (path === '/') return `<main class="public-audience"><nav class="pa-role-nav" aria-label="Можливості Xelay">${roleLinks}</nav><header class="pa-hero"><p class="pa-eyebrow">Xelay · навчальна екосистема КНУ</p><h1>Ваш навчальний день.<br>Усе потрібне поруч.</h1><p class="pa-intro">Розклад, домашні завдання, матеріали, семінари, тести та спільнота для студентів, старост і викладачів.</p><a class="pa-button pa-button-primary" href="/groups">Мої групи</a></header>${renderHomeEcosystemBody()}</main>`
  if (PUBLIC_AUDIENCE_PAGES[path as keyof typeof PUBLIC_AUDIENCE_PAGES]) return renderAudienceBody(path.slice(1) as PublicAudience)
  const meta = metadataForPath(path)
  if (path.startsWith('/category/')) {
    const category = slugToCategory(path.slice('/category/'.length))!, title = CATEGORY_META[category]?.title || category
    return `<main class="public-audience"><nav class="pa-breadcrumb"><a href="/">Xelay</a> · <a href="/categories">Теми спільноти</a></nav><header class="pa-hero"><p class="pa-eyebrow">Спільнота Xelay</p><h1>${escapeSeoHtml(title)}</h1><p class="pa-intro">${escapeSeoHtml(meta.description)}</p></header><p>Публічні запитання й відповіді учасників університетської спільноти.</p><a href="/community">Усі запитання спільноти</a></main>`
  }
  if (path === '/categories' || path === '/community') return `<main class="public-audience"><nav class="pa-breadcrumb"><a href="/">Xelay</a> · Спільнота</nav><header class="pa-hero"><p class="pa-eyebrow">Університетська спільнота</p><h1>${path === '/categories' ? 'Оберіть свою тему.' : 'Є запитання? Є свої люди.'}</h1><p class="pa-intro">${escapeSeoHtml(meta.description)}</p></header><nav aria-label="Теми спільноти"><ul>${categoryLinks()}</ul></nav><p>${roleLinks}</p></main>`
  return `<main class="public-audience"><nav class="pa-breadcrumb"><a href="/">Xelay</a></nav><h1>${escapeSeoHtml(meta.title.replace(/ \| Xelay$/, ''))}</h1><p>${escapeSeoHtml(meta.description)}</p>${meta.index ? `<p>${roleLinks}</p>` : '<p>Відкриваємо ваш розділ…</p>'}</main>`
}

export function renderSeoHtml(template: string, meta: PageSeo, body: string): string {
  const title = escapeSeoHtml(meta.title), description = escapeSeoHtml(meta.description)
  const head = template.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<meta\b[^>]*(?:name=["'](?:description|robots|twitter:title|twitter:description)["']|property=["'](?:og:title|og:description|og:url|og:type)["'])[^>]*>/gi, '')
    .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi, '')
    .replace(/<\/head>/i, `<title>${title}</title><meta name="description" content="${description}" /><meta name="robots" content="${meta.index ? 'index,follow' : 'noindex,follow'}" /><meta property="og:type" content="website" /><meta property="og:title" content="${title}" /><meta property="og:description" content="${description}" /><meta name="twitter:title" content="${title}" /><meta name="twitter:description" content="${description}" />${meta.canonical ? `<link rel="canonical" href="${escapeSeoHtml(meta.canonical)}" /><meta property="og:url" content="${escapeSeoHtml(meta.canonical)}" />` : ''}</head>`)
  const replacement = `${PUBLIC_ROOT_START}${body}${PUBLIC_ROOT_END}`
  if (head.includes(PUBLIC_ROOT_START) && head.includes(PUBLIC_ROOT_END)) return head.replace(/<!--xelay-public-root-start-->[\s\S]*?<!--xelay-public-root-end-->/, () => replacement)
  if (!/<div\s+id=["']root["']\s*>\s*<\/div>/.test(head)) throw new Error('SEO root placeholder missing')
  return head.replace(/(<div\s+id=["']root["']\s*>)\s*(<\/div>)/, (_match, before, after) => `${before}${replacement}${after}`)
}

export function seoStaticDocuments(template: string): Map<string, string> {
  const documents = new Map<string, string>()
  for (const path of [...PUBLIC_STATIC_PATHS.filter(path => path !== '/'), ...PRIVATE_SPA_PATHS, ...categorySeoPaths()]) documents.set(seoOutputPath(path), renderSeoHtml(template, metadataForPath(path), publicPageBody(path)))
  for (const [family,title] of [['group','Навчальна група'],['user','Профіль учасника'],['news','Новина спільноти']]) documents.set(`seo/private-${family}.html`,renderSeoHtml(template,{title:`${title} | Xelay`,description:'Особистий розділ Xelay.',index:false},'<main class="public-audience"><h1>Відкриваємо Xelay…</h1></main>'))
  const notFoundBody = `<main class="public-audience"><nav class="pa-breadcrumb"><a href="/">Xelay</a></nav><header class="pa-hero"><p class="pa-eyebrow">404</p><h1>Сторінку не знайдено</h1><p class="pa-intro">Можливо, у посиланні помилка або сторінка більше недоступна.</p><a class="pa-button pa-button-primary" href="/">На головну</a><a class="pa-button" href="/guides/">Посібники</a></header><p>${roleLinks}</p></main>`
  documents.set('404.html',renderSeoHtml(template,notFoundSeo(),notFoundBody).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*rel=["']modulepreload["'][^>]*>/gi,''))
  return documents
}
