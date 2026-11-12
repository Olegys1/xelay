import { CATEGORY_META } from './categoryMeta.ts'
import { CATEGORIES, LEGACY_CATEGORIES, categoryToSlug, slugToCategory } from '../types/index.ts'
import { getLegalPage, type LegalPageKind } from './legal.ts'
import { HOME_SEO_TITLE, HOME_SEO_DESCRIPTION, PUBLIC_AUDIENCE_PAGES } from './publicSeoContent.ts'

export const SEO_ORIGIN = 'https://www.xelay.ink'
export const SEO_IMAGE = `${SEO_ORIGIN}/og-xelay-knu-20261002.png`
export type PageSeo = { title: string; description: string; canonical?: string; index: boolean; notFound?: boolean }
export const LEGAL_SEO_PATHS = ['terms', 'community-rules', 'refund-policy', 'contacts', 'privacy-policy', 'personal-data-consent'] as const
export const PRIVATE_SPA_PATHS = ['/profile', '/messages', '/search', '/news', '/admin', '/groups', '/organizer', '/teaching', '/auth/callback', '/reset-password', '/offline', '/halloween', '/referrals'] as const
export const PUBLIC_STATIC_PATHS = ['/', '/students', '/headmen', '/teachers', '/community', '/categories', '/subscription', '/support', '/opportunities', '/tools'] as const
const privateTitles: Record<string, string> = { '/referrals': 'Запроси групу', '/profile': 'Мій профіль', '/messages': 'Чати', '/search': 'Пошук у Xelay', '/news': 'Новини моєї спільноти', '/admin': 'Адміністрування', '/groups': 'Мої навчальні групи', '/organizer': 'Особисті справи', '/teaching': 'Кабінет викладача', '/auth/callback': 'Підтвердження входу', '/reset-password': 'Відновлення доступу', '/offline': 'Збережені розклад і ДЗ', '/halloween': 'Гелловінська подія' }
const publicDescriptions: Record<string, [string, string]> = {
  '/tools': ['Корисні інструменти та партнери | Xelay', 'Каталог інструментів і сервісів партнерів Xelay для навчання, продуктивності та кар’єри. Назви, короткі описи й прямі посилання в одному місці.'],
  '/community': ['Спільнота студентів КНУ | Xelay', 'Запитання, досвід і взаємодопомога університетської спільноти Xelay. Обговорюйте навчання, стажування, події та студентські проєкти.'],
  '/categories': ['Теми університетської спільноти | Xelay', 'Оберіть тему у спільноті Xelay: навчання, стажування, кар’єра, міжнародні можливості, студентські проєкти та події університету.'],
  '/subscription': ['Підписка «Учасник» | Xelay', 'Що входить у особисту підписку «Учасник» Xelay, як працюють оплата й термін доступу та які можливості екосистеми доступні без підписки.'],
  '/support': ['Підтримати розвиток Xelay', 'Як підтримати розвиток навчальної екосистеми Xelay для студентів, старост і викладачів. Добровільна підтримка та відповіді на запитання.'],
  '/opportunities': ['Студентські можливості | Xelay', 'Майбутній розділ Xelay про стажування, першу роботу, освітні програми й університетські події.'],
}
export const plainSeoText = (value: string, maximum: number) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
export const categorySeoPaths = () => [...CATEGORIES, ...LEGACY_CATEGORIES].map(category => `/category/${categoryToSlug(category)}`)
export const notFoundSeo = (): PageSeo => ({ title: 'Сторінку не знайдено — 404 | Xelay', description: 'Цей адрес не веде до сторінки Xelay. Поверніться на головну або відкрийте посібники навчальної екосистеми.', index: false, notFound: true })

export function metadataForPath(input: string): PageSeo {
  // Never construct canonical links from a visitor's host or query string.
  const path = input.split(/[?#]/, 1)[0].replace(/\/$/, '') || '/'
  if (path === '/') return { title: HOME_SEO_TITLE, description: HOME_SEO_DESCRIPTION, canonical: `${SEO_ORIGIN}/`, index: true }
  const audience = PUBLIC_AUDIENCE_PAGES[path as keyof typeof PUBLIC_AUDIENCE_PAGES]
  if (audience) return { title: audience.title, description: audience.description, canonical: SEO_ORIGIN + path, index: true }
  if (path === '/guides') return { title: 'Посібники Xelay для викладачів і старост', description: 'Покрокові інструкції Xelay: розклад, домашні завдання, матеріали, семінари, тести та журнал викладача.', canonical: `${SEO_ORIGIN}/guides/`, index: true }
  const legal = path.slice(1) as LegalPageKind
  if ((LEGAL_SEO_PATHS as readonly string[]).includes(legal)) { const page = getLegalPage(legal); return { title: `${page.title} · Xelay`, description: page.description, canonical: SEO_ORIGIN + path, index: true } }
  if (publicDescriptions[path]) { const [title, description] = publicDescriptions[path]; return { title, description, canonical: SEO_ORIGIN + path, index: path !== '/opportunities' } }
  const categoryMatch = /^\/category\/([a-z0-9-]+)$/.exec(path)
  if (categoryMatch) {
    const category = slugToCategory(categoryMatch[1])
    if (!category) return notFoundSeo()
    const meta = CATEGORY_META[category]
    return { title: `${meta?.title || category} — спільнота | Xelay`, description: meta?.description || `Запитання та обговорення теми «${category}» у спільноті Xelay.`, canonical: `${SEO_ORIGIN}/category/${categoryToSlug(category)}`, index: (CATEGORIES as readonly string[]).includes(category) }
  }
  if (/^\/question\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(path)) return { title: 'Запитання університетської спільноти | Xelay', description: 'Обговорення та відповіді університетської спільноти Xelay.', canonical: SEO_ORIGIN + path, index: true }
  if ((PRIVATE_SPA_PATHS as readonly string[]).includes(path)) return { title: `${privateTitles[path]} | Xelay`, description: 'Особистий розділ навчальної екосистеми Xelay. Доступ визначається вашим акаунтом.', index: false }
  if (/^\/(groups|user|news)\/[^/]+$/.test(path)) return { title: `${path.startsWith('/groups/') ? 'Навчальна група' : path.startsWith('/user/') ? 'Профіль учасника' : 'Новина спільноти'} | Xelay`, description: 'Розділ навчальної екосистеми Xelay.', index: false }
  return notFoundSeo()
}
export function questionSeo(id: string, content: string): PageSeo {
  return { title: `${plainSeoText(content, 70) || 'Запитання спільноти'} | Xelay`, description: plainSeoText(content, 160) || 'Запитання та відповіді університетської спільноти Xelay.', canonical: `${SEO_ORIGIN}/question/${encodeURIComponent(id)}`, index: true }
}
export function isMissingPublicQuestion(error: { code?: string; status?: number } | null): boolean {
  return error === null || error.code === 'PGRST116' || error.code === '42501' || error.status === 403 || error.status === 404
}
