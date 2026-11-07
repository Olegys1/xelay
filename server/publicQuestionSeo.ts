export const PUBLIC_SEO_ORIGIN = 'https://www.xelay.ink'
const PUBLIC_IMAGE = `${PUBLIC_SEO_ORIGIN}/og-xelay-knu-20261002.png`
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PublicSeoQuestion = { id: string; content: string; category?: string | null; created_at?: string | null }
type QuestionLookup = { data: PublicSeoQuestion | null; error?: unknown }
type SeoDependencies = {
  loadQuestion: (id: string) => Promise<QuestionLookup>
  loadTemplate: () => Promise<string>
}

export const escapePublicSeoHtml = (value: string) => value.replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

export function publicQuestionId(value: unknown): string | null {
  if (typeof value !== 'string' || !QUESTION_ID.test(value)) return null
  return UUID.test(value) ? value.toLowerCase() : value
}

export function publicQuestionText(content: string): { title: string; description: string } {
  const normalized = content.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  return { title: `${normalized.slice(0, 70) || 'Запитання спільноти'} | Xelay`,
    description: normalized.slice(0, 160) || 'Запитання та відповіді університетської спільноти Xelay.' }
}

export function publicSupabaseConfiguration(environment: Record<string, string | undefined>): { url: string; key: string } | null {
  const rawUrl = environment.SUPABASE_URL || environment.VITE_SUPABASE_URL
  const key = environment.SUPABASE_ANON_KEY || environment.VITE_SUPABASE_ANON_KEY
  if (!rawUrl || !key) return null
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) return null
    // The public route must not gain service-role privileges through a mislabeled environment value.
    const anonymousJwt = !key.startsWith('sb_secret_') && key.split('.').length === 3
      && JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role === 'anon'
    if (!key.startsWith('sb_publishable_') && !anonymousJwt) return null
    return { url: url.origin, key }
  } catch { return null }
}

function insertQuestionContent(template: string, content: string): string {
  const marker = /<!--xelay-public-root-start-->[\s\S]*?<!--xelay-public-root-end-->/
  if (marker.test(template)) return template.replace(marker, () => `<!--xelay-public-root-start-->${content}<!--xelay-public-root-end-->`)
  if (/<div\s+id=["']root["']\s*>\s*<\/div>/i.test(template)) {
    return template.replace(/(<div\s+id=["']root["']\s*>)\s*(<\/div>)/i, (_match, start, end) => `${start}${content}${end}`)
  }
  throw new Error('PUBLIC_SEO_TEMPLATE_UNAVAILABLE')
}

export function renderPublicQuestionHtml(template: string, question: PublicSeoQuestion): string {
  if (typeof template !== 'string' || !/<\/head>/i.test(template) || !/<body\b/i.test(template)
    || !publicQuestionId(question.id) || typeof question.content !== 'string' || question.content.length > 20000) {
    throw new Error('PUBLIC_SEO_TEMPLATE_UNAVAILABLE')
  }
  const { title, description } = publicQuestionText(question.content)
  const canonical = `${PUBLIC_SEO_ORIGIN}/question/${encodeURIComponent(publicQuestionId(question.id)!)}`
  const safeTitle = escapePublicSeoHtml(title), safeDescription = escapePublicSeoHtml(description)
  // One authoritative set of route metadata. Question text never becomes HTML or executable JSON.
  const head = template.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<meta\b[^>]*(?:name=["'](?:description|robots|twitter:[^"']*)["']|property=["']og:[^"']*["'])[^>]*>/gi, '')
    .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi, '')
    .replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/head>/i, () => `<title>${safeTitle}</title>
<meta name="description" content="${safeDescription}" />
<meta name="robots" content="index,follow" />
<link rel="canonical" href="${canonical}" />
<meta property="og:type" content="article" /><meta property="og:site_name" content="Xelay" />
<meta property="og:locale" content="uk_UA" /><meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="${safeDescription}" /><meta property="og:url" content="${canonical}" />
<meta property="og:image" content="${PUBLIC_IMAGE}" /><meta property="og:image:alt" content="Логотип Xelay KNU на білому тлі" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${safeTitle}" />
<meta name="twitter:description" content="${safeDescription}" /><meta name="twitter:image" content="${PUBLIC_IMAGE}" />
</head>`)
  const content = `<main class="xelay-public-question" style="max-width:880px;margin:0 auto;padding:64px 24px;font-family:system-ui,sans-serif;color:#25171d;line-height:1.6">
<nav aria-label="Навігація"><a href="/">Xelay</a> · <a href="/community">Спільнота</a></nav>
<p>Запитання університетської спільноти</p>
<h1 style="font-size:clamp(1.8rem,4vw,3rem);line-height:1.2;white-space:pre-wrap;overflow-wrap:anywhere">${escapePublicSeoHtml(question.content || 'Запитання спільноти')}</h1>
<p>Переглядайте відповіді та діліться досвідом у спільноті Xelay.</p>
<p><a href="/community">Усі запитання</a> · <a href="/students">Xelay для студентів</a> · <a href="/guides/">Посібники</a></p>
</main>`
  return insertQuestionContent(head, content)
}

export function renderPublicSeoError(status: 404 | 503): string {
  const title = status === 404 ? 'Сторінку не знайдено' : 'Сторінка тимчасово недоступна'
  const text = status === 404 ? 'Можливо, запитання видалили або посилання містить помилку.'
    : 'Не вдалося завантажити публічну сторінку. Спробуйте ще раз трохи пізніше.'
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,follow"><title>${title} · Xelay</title></head>
<body style="margin:0;background:#fffaf9;color:#28151c;font-family:system-ui,sans-serif"><main style="max-width:720px;margin:12vh auto;padding:32px"><a href="/" style="color:#800020;font-size:24px;font-weight:700">Xelay</a><p>${status}</p><h1>${title}</h1><p>${text}</p><p><a href="/">На головну</a> · <a href="/community">До спільноти</a> · <a href="/guides/">Посібники</a></p></main></body></html>`
}

export function createPublicQuestionSeoHandler(dependencies: SeoDependencies) {
  return async function handler(req: any, res: any) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    const method = req.method || 'GET'
    const sendError = (status: 404 | 503) => {
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Robots-Tag', 'noindex, follow')
      if (status === 503) res.setHeader('Retry-After', '60')
      return res.status(status).send(method === 'HEAD' ? '' : renderPublicSeoError(status))
    }
    if (!['GET', 'HEAD'].includes(method)) {
      res.setHeader('Allow', 'GET, HEAD')
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Robots-Tag', 'noindex, follow')
      return res.status(405).end()
    }
    const id = publicQuestionId(req.query?.question)
    if (!id) return sendError(404)
    try {
      const { data, error } = await dependencies.loadQuestion(id)
      if (error) return sendError(503)
      if (!data) return sendError(404)
      if (publicQuestionId(data.id) !== id) return sendError(503)
      const html = renderPublicQuestionHtml(await dependencies.loadTemplate(), data)
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
      res.setHeader('CDN-Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
      res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
      return res.status(200).send(method === 'HEAD' ? '' : html)
    } catch { return sendError(503) }
  }
}

export const PUBLIC_SITEMAP_STATIC_PATHS = Object.freeze([
  '/', '/students', '/headmen', '/teachers', '/community', '/categories', '/guides/',
  '/community-rules', '/terms', '/refund-policy', '/contacts', '/privacy-policy', '/personal-data-consent',
])

export function buildPublicSitemap(questions: Array<{ id: unknown; created_at?: unknown }>, categoryNames: readonly string[] = []): string {
  const entries = PUBLIC_SITEMAP_STATIC_PATHS.map(path => `<url><loc>${PUBLIC_SEO_ORIGIN}${path}</loc></url>`)
  const slugs = new Set(categoryNames.map(name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).filter(Boolean))
  for (const slug of slugs) entries.push(`<url><loc>${PUBLIC_SEO_ORIGIN}/category/${slug}</loc></url>`)
  const seen = new Set<string>()
  for (const question of questions.slice(0, 1000)) {
    const id = publicQuestionId(question.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const date = typeof question.created_at === 'string' ? new Date(question.created_at) : new Date(NaN)
    const stamp = Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1970 && date.getUTCFullYear() <= 9999
      ? `<lastmod>${date.toISOString()}</lastmod>` : ''
    entries.push(`<url><loc>${escapePublicSeoHtml(`${PUBLIC_SEO_ORIGIN}/question/${encodeURIComponent(id)}`)}</loc>${stamp}</url>`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>`
}
