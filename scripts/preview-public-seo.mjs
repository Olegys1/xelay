import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPublicSitemap, createPublicQuestionSeoHandler } from '../server/publicQuestionSeo.ts'

const repository = fileURLToPath(new URL('../', import.meta.url))
export const SEO_PREVIEW_PORT = 3092
export const SEO_PREVIEW_QUESTION = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  content: 'Як зібрати розклад, домашні завдання та матеріали в одному місці?',
  category: 'General Questions',
  author_name: 'Локальний приклад',
  author_avatar: '',
  user_id: null,
  created_at: '2026-11-07T10:00:00.000Z',
  answers_count: 0,
  views: 0,
})
const categoryNames = ['General Questions', 'International Opportunities', 'Internships', 'Career', 'Business', 'Learning', 'Entrepreneurship', 'IT', 'Design', 'Marketing']
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json; charset=utf-8',
}

// Local routing only. An external destination must never become a preview proxy.
export function matchPreviewSource(source, pathname) {
  try {
    const named = source.replace(/:([A-Za-z][A-Za-z0-9_]*)(\*)?/g, (_all, name, star) => `(?<${name}>${star ? '.*' : '[^/]+'})`)
    const result = new RegExp(`^${named}$`).exec(pathname)
    if (!result) return null
    return result
  } catch { return null }
}

function destinationFor(destination, match) {
  if (!destination.startsWith('/') || destination.startsWith('//')) return null
  return destination.replace(/\$(\d+)/g, (_all, number) => match[Number(number)] || '')
    .replace(/:([A-Za-z][A-Za-z0-9_]*)(\*)?/g, (_all, name) => match.groups?.[name] || '')
}

function previewConditionsMatch(rule, url) {
  const matches = condition => {
    if (!condition || condition.type !== 'query' || typeof condition.key !== 'string') return null
    if (condition.value === undefined) return url.searchParams.has(condition.key)
    if (typeof condition.value !== 'string') return null
    try {
      const value = new RegExp(`^(?:${condition.value})$`)
      return url.searchParams.getAll(condition.key).some(entry => value.test(entry))
    } catch { return null }
  }
  if (rule.has !== undefined && !Array.isArray(rule.has) || rule.missing !== undefined && !Array.isArray(rule.missing)) return false
  return (rule.has || []).every(condition => matches(condition) === true)
    && (rule.missing || []).every(condition => matches(condition) === false)
}

function safeAssetPath(directory, pathname) {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return null }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.split('/').some(part => part === '..' || part === '.')) return null
  const path = resolve(directory, '.' + decoded)
  const within = relative(resolve(directory), path)
  if (within.startsWith('..' + sep) || within === '..' || isAbsolute(within)) return null
  return path
}

export function createSeoPreviewHandler({ directory = join(repository, 'dist'), config }) {
  const question = createPublicQuestionSeoHandler({
    loadTemplate: () => readFile(join(directory, 'index.html'), 'utf8'),
    loadQuestion: async id => ({ data: id === SEO_PREVIEW_QUESTION.id ? SEO_PREVIEW_QUESTION : null }),
  })

  return async function handler(req, res) {
    // Do not accidentally expose this fixture to other LAN hosts or DNS-rebinding origins.
    if (!['127.0.0.1:3092', 'localhost:3092'].includes(req.headers.host || '')) {
      res.statusCode = 403; res.end('Local preview only'); return
    }
    const originalSetHeader = res.setHeader.bind(res)
    res.setHeader = (name, value) => originalSetHeader(name, name.toLowerCase() === 'x-robots-tag' ? 'noindex, nofollow' : value)
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    res.setHeader('Cache-Control', 'private, no-store')
    const method = req.method || 'GET'
    let url
    try {
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')
        || /[\\\u0000-\u001f\u007f]|%00|%2f|%5c|(?:^|\/)\.{1,2}(?:\/|$)/i.test(req.url.split('?')[0])) throw new Error('path')
      const rawPath = decodeURIComponent(req.url.split('?')[0])
      if (rawPath.split('/').some(part => part === '..' || part === '.')) throw new Error('path')
      url = new URL(req.url, `http://127.0.0.1:${SEO_PREVIEW_PORT}`)
    } catch { res.statusCode = 400; res.end('Invalid preview path'); return }
    const send = (status, type, body) => {
      res.statusCode = status; res.setHeader('Content-Type', type)
      res.setHeader('Content-Length', Buffer.byteLength(body)); res.end(method === 'HEAD' ? undefined : body)
    }
    const json = (status, body) => send(status, 'application/json; charset=utf-8', JSON.stringify(body))

    for (const rule of config.headers || []) {
      if (!matchPreviewSource(rule.source, url.pathname)) continue
      for (const header of rule.headers || []) {
        if (!['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control'].includes(header.key.toLowerCase())) res.setHeader(header.key, header.value)
      }
    }

    // The fake Supabase URL is baked into this local bundle. It never contacts a real account.
    if (url.pathname.startsWith('/fake-supabase/')) {
      if (url.pathname.startsWith('/fake-supabase/auth/')) return json(401, { code: 'preview_auth_disabled', message: 'У локальному прикладі вхід не підключено.' })
      if (method === 'POST' && url.pathname.startsWith('/fake-supabase/rest/v1/rpc/')) {
        const name = url.pathname.split('/').at(-1)
        if (['xelay_public_halloween_total', 'xelay_public_halloween_community_total', 'xelay_halloween_community_total', 'xelay_member_count', 'xelay_public_site_stats'].includes(name)) {
          return json(200, name === 'xelay_public_site_stats' ? { questions: 1, users: 0 } : 0)
        }
      }
      if (!['GET', 'HEAD'].includes(method)) return json(405, { code: 'preview_writes_disabled', message: 'Локальний приклад не зберігає зміни.' })
      if (!url.pathname.startsWith('/fake-supabase/rest/v1/')) return json(404, { code: 'preview_not_found' })
      const table = url.pathname.slice('/fake-supabase/rest/v1/'.length)
      let rows = table === 'questions' ? [{ ...SEO_PREVIEW_QUESTION }] : []
      if (url.searchParams.has('id')) rows = rows.filter(row => url.searchParams.get('id') === `eq.${row.id}`)
      if (url.searchParams.has('category')) rows = rows.filter(row => url.searchParams.get('category') === `eq.${row.category}`)
      res.setHeader('Content-Range', rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0')
      if (String(req.headers.accept || '').includes('application/vnd.pgrst.object+json')) {
        if (!rows.length) return json(406, { code: 'PGRST116', details: 'The result contains 0 rows', message: 'No fixture row' })
        return json(200, rows[0])
      }
      return json(200, rows)
    }

    if (!['GET', 'HEAD'].includes(method)) { res.setHeader('Allow', 'GET, HEAD'); return json(405, { error: 'preview_writes_disabled' }) }

    for (const rule of config.redirects || []) {
      const match = matchPreviewSource(rule.source, url.pathname)
      if (!match || !previewConditionsMatch(rule, url)) continue
      const target = destinationFor(rule.destination, match)
      if (!target) continue
      res.statusCode = rule.statusCode || (rule.permanent ? 308 : 307)
      res.setHeader('Location', target + (target.includes('?') ? '' : url.search)); res.end(); return
    }

    let destination = url.pathname
    for (const rule of config.rewrites || []) {
      const match = matchPreviewSource(rule.source, url.pathname)
      if (!match || !previewConditionsMatch(rule, url)) continue
      const target = destinationFor(rule.destination, match)
      if (!target) continue
      destination = target; break
    }
    const destinationUrl = new URL(destination, 'http://127.0.0.1:3092')
    if (['/sitemap.xml', '/api/sitemap'].includes(url.pathname) || destinationUrl.pathname === '/api/sitemap') {
      return send(200, 'application/xml; charset=utf-8', buildPublicSitemap([SEO_PREVIEW_QUESTION], categoryNames))
    }
    const questionPath = /^\/question\/([^/]+)\/?$/.exec(url.pathname)
    if (questionPath || destinationUrl.pathname === '/api/seo') {
      const ids = destinationUrl.pathname === '/api/seo' ? destinationUrl.searchParams.getAll('question') : []
      req.query = { question: ids.length > 1 ? ids : ids[0] || (questionPath ? decodeURIComponent(questionPath[1]) : undefined) }
      const adapter = {
        setHeader: res.setHeader.bind(res),
        status(code) { res.statusCode = code; return this },
        send(body) { res.setHeader('Content-Length', Buffer.byteLength(body)); res.end(method === 'HEAD' ? undefined : body); return this },
        end() { res.end(); return this },
      }
      return question(req, adapter)
    }
    if (url.pathname.startsWith('/api/') || destinationUrl.pathname.startsWith('/api/')) return json(404, { error: 'preview_api_not_connected' })

    let file = safeAssetPath(directory, destinationUrl.pathname)
    try {
      if (!file) throw new Error('invalid')
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
      const bytes = await readFile(file)
      return send(200, MIME[extname(file).toLowerCase()] || 'application/octet-stream', bytes)
    } catch {
      // Missing JS/CSS/images are real 404s as well; they never receive the SPA shell.
      try { return send(404, 'text/html; charset=utf-8', await readFile(join(directory, '404.html'))) }
      catch { return send(404, 'text/plain; charset=utf-8', 'Сторінку не знайдено · Xelay') }
    }
  }
}

export async function startSeoPreview() {
  const config = JSON.parse(await readFile(join(repository, 'vercel.json'), 'utf8'))
  await stat(join(repository, 'dist/index.html'))
  const handle = createSeoPreviewHandler({ config })
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) { res.statusCode = 500; res.setHeader('X-Robots-Tag', 'noindex, nofollow') }
      res.end('Local preview unavailable')
    })
  })
  server.listen(SEO_PREVIEW_PORT, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  console.log(`Xelay SEO local preview: http://127.0.0.1:${SEO_PREVIEW_PORT}/`)
  console.log('Synthetic data only. Sign-in, payments and writes are disabled. No upstream services are contacted.')
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startSeoPreview()
