import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  buildPublicSitemap, createPublicQuestionSeoHandler, publicQuestionId, publicQuestionText,
  publicSupabaseConfiguration, renderPublicQuestionHtml,
} from '../../server/publicQuestionSeo.ts'

const id = '899ef173-3d54-432d-a881-483940e2b95f'
const template = `<!doctype html><html lang="uk"><head><title>Old homepage</title>
<meta name="description" content="old"><meta name="robots" content="noindex">
<meta property="og:title" content="old"><meta property="og:url" content="https://www.xelay.ink/">
<meta name="twitter:title" content="old"><link rel="canonical" href="https://www.xelay.ink/">
<script type="application/ld+json">{"@type":"WebSite"}</script>
<script type="module" src="/assets/entry-valid.js"></script></head>
<body><div id="root"><!--xelay-public-root-start--><main><div>nested</div></main><!--xelay-public-root-end--></div></body></html>`
const question = { id, content: 'Як підготуватися до семінару?', created_at: '2026-11-01T10:00:00Z' }

function response() {
  return { code: null, body: null, headers: {}, setHeader(name, value) { this.headers[name] = value },
    status(value) { this.code = value; return this }, send(value) { this.body = value; return this }, end() { this.body = ''; return this } }
}

test('public question IDs accept UUID and safe legacy text, never arbitrary paths, queries or duplicate parameters', () => {
  assert.equal(publicQuestionId(id.toUpperCase()), id)
  assert.equal(publicQuestionId('legacy-question_12'), 'legacy-question_12')
  for (const value of [null, undefined, '', [], [id], {}, '..', '/admin', 'x?role=admin', 'a%2fb', 'a b', 'a\nb', '<script>', 'x'.repeat(129), 'https://example.org']) {
    assert.equal(publicQuestionId(value), null)
  }
})

test('public metadata normalizes whitespace and aligns exact title/description limits', () => {
  assert.deepEqual(publicQuestionText('  Перше\n\t друге  '), { title: 'Перше друге | Xelay', description: 'Перше друге' })
  const long = publicQuestionText('a'.repeat(200))
  assert.equal(long.title, 'a'.repeat(70) + ' | Xelay')
  assert.equal(long.description.length, 160)
})

test('rendered question HTML contains one matching route canonical, OG and text without replacing compiled app assets', () => {
  const html = renderPublicQuestionHtml(template, question)
  assert.equal([...html.matchAll(/rel="canonical"/g)].length, 1)
  assert.match(html, new RegExp(`rel="canonical" href="https://www\\.xelay\\.ink/question/${id}"`))
  assert.match(html, new RegExp(`property="og:url" content="https://www\\.xelay\\.ink/question/${id}"`))
  assert.match(html, /<title>Як підготуватися до семінару\? \| Xelay<\/title>/)
  assert.match(html, /name="robots" content="index,follow"/)
  assert.match(html, /<h1[^>]*>Як підготуватися до семінару\?<\/h1>/)
  assert.match(html, /src="\/assets\/entry-valid.js"/)
  assert.doesNotMatch(html, /Old homepage|content="old"|nested|application\/ld\+json/)
  assert.match(html, /<!--xelay-public-root-start-->/)
  assert.match(html, /<!--xelay-public-root-end-->/)
})

test('stored hostile question content remains escaped in initial HTML and metadata', () => {
  const content = '"/><script>alert(1)</script><img src=x onerror=alert(2)> & $& $`'
  const html = renderPublicQuestionHtml(template, { id, content })
  assert.doesNotMatch(html, /<script>alert|<img src=x|content=""\/>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/)
  assert.match(html, /&amp; \$&amp;/)
  assert.equal([...html.matchAll(/type="module"/g)].length, 1)
})

test('unrecognized or oversized templates and records fail instead of sending partial route HTML', () => {
  assert.throws(() => renderPublicQuestionHtml('<html></html>', question))
  assert.throws(() => renderPublicQuestionHtml(template.replace(/<!--xelay-public-root-(?:start|end)-->/g, ''), question))
  assert.throws(() => renderPublicQuestionHtml(template, { id, content: 'a'.repeat(20001) }))
  const emptyRoot = template.replace(/<!--xelay-public-root-start-->[\s\S]*?<!--xelay-public-root-end-->/, '')
  assert.match(renderPublicQuestionHtml(emptyRoot, question), /<h1[^>]*>Як підготуватися/)
})

test('public lookup forwards only a validated ID and public responses contain no caller identity', async () => {
  const calls = []
  const handler = createPublicQuestionSeoHandler({ loadQuestion: async (...args) => { calls.push(args); return { data: question } }, loadTemplate: async () => template })
  const res = response()
  await handler({ method: 'GET', query: { question: id }, headers: { cookie: 'secret-session', authorization: 'Bearer private' } }, res)
  assert.deepEqual(calls, [[id]])
  assert.equal(res.code, 200)
  assert.match(res.headers['CDN-Cache-Control'], /s-maxage=300/)
  assert.doesNotMatch(res.body, /secret-session|Bearer private/)
})

test('invalid/missing questions are HTTP404 and remain uncached and noindex', async () => {
  let lookups = 0
  const handler = createPublicQuestionSeoHandler({ loadQuestion: async () => { lookups++; return { data: null } }, loadTemplate: async () => template })
  for (const candidate of [undefined, [id], '/admin', 'x'.repeat(129)]) {
    const res = response(); await handler({ method: 'GET', query: { question: candidate } }, res)
    assert.equal(res.code, 404); assert.match(res.headers['X-Robots-Tag'], /noindex/); assert.match(res.headers['Cache-Control'], /no-store/)
  }
  assert.equal(lookups, 0)
  const res = response(); await handler({ method: 'GET', query: { question: id } }, res)
  assert.equal(lookups, 1); assert.equal(res.code, 404); assert.match(res.body, /Сторінку не знайдено/)
})

test('upstream, wrong-row and template failures return503 with no details or stale success', async () => {
  const failures = [
    { loadQuestion: async () => { throw new Error('private-provider-detail') }, loadTemplate: async () => template },
    { loadQuestion: async () => ({ data: null, error: 'private-provider-detail' }), loadTemplate: async () => template },
    { loadQuestion: async () => ({ data: { ...question, id: 'wrong-row' } }), loadTemplate: async () => template },
    { loadQuestion: async () => ({ data: question }), loadTemplate: async () => { throw new Error('private-provider-detail') } },
  ]
  for (const dependencies of failures) {
    const res = response(); await createPublicQuestionSeoHandler(dependencies)({ query: { question: id } }, res)
    assert.equal(res.code, 503); assert.equal(res.headers['Retry-After'], '60')
    assert.match(res.headers['Cache-Control'], /no-store/); assert.match(res.headers['X-Robots-Tag'], /noindex/)
    assert.doesNotMatch(res.body, /private-provider-detail|wrong-row/)
    assert.equal(res.headers['CDN-Cache-Control'], undefined)
  }
})

test('HEAD preserves404/503/200 and unsupported methods do not perform a database read', async () => {
  for (const [data, error, status] of [[question, null, 200], [null, null, 404], [null, 'unavailable', 503]]) {
    const handler = createPublicQuestionSeoHandler({ loadQuestion: async () => ({ data, error }), loadTemplate: async () => template })
    const res = response(); await handler({ method: 'HEAD', query: { question: id } }, res)
    assert.equal(res.code, status); assert.equal(res.body, '')
  }
  const handler = createPublicQuestionSeoHandler({ loadQuestion: async () => { assert.fail('Lookup must not run') }, loadTemplate: async () => template })
  const res = response(); await handler({ method: 'POST', query: { question: id } }, res)
  assert.equal(res.code, 405); assert.equal(res.headers.Allow, 'GET, HEAD'); assert.equal(res.body, '')
})

test('public Supabase configuration refuses privileged keys and URL injection', () => {
  const jwt = role => `synthetic.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.synthetic`
  const environment = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_ANON_KEY: jwt('anon') }
  assert.deepEqual(publicSupabaseConfiguration(environment), { url: environment.SUPABASE_URL, key: environment.SUPABASE_ANON_KEY })
  assert.ok(publicSupabaseConfiguration({ ...environment, SUPABASE_ANON_KEY: 'sb_publishable_synthetic' }))
  for (const key of [jwt('service_role'), jwt('authenticated'), 'sb_secret_synthetic', 'invalid']) assert.equal(publicSupabaseConfiguration({ ...environment, SUPABASE_ANON_KEY: key }), null)
  for (const url of ['http://synthetic.supabase.co', 'https://evil.example', 'https://u:p@synthetic.supabase.co', 'https://synthetic.supabase.co/path', 'https://synthetic.supabase.co?target=evil', 'https://synthetic.supabase.co:8443']) {
    assert.equal(publicSupabaseConfiguration({ ...environment, SUPABASE_URL: url }), null)
  }
  assert.equal(publicSupabaseConfiguration({ SUPABASE_URL: environment.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: jwt('service_role') }), null)
})

test('sitemap adds the public ecosystem and category pages while omitting accounts, groups and restricted news', () => {
  const xml = buildPublicSitemap([{ id, created_at: '2026-11-01T10:00:00Z' }, { id: id.toUpperCase() }, { id: 'malicious<id' }, { id: 'legacy-2', created_at: 'invalid' }], ['General Questions', 'IT', 'IT'])
  for (const path of ['/students', '/headmen', '/teachers', '/community', '/guides/', '/category/general-questions', '/category/it']) assert.ok(xml.includes(`<loc>https://www.xelay.ink${path}</loc>`), path)
  assert.equal([...xml.matchAll(new RegExp('/question/' + id, 'g'))].length, 1)
  assert.equal([...xml.matchAll(/<lastmod>/g)].length, 1)
  assert.match(xml, /<lastmod>2026-11-01T10:00:00.000Z<\/lastmod>/)
  assert.doesNotMatch(xml, /malicious|NaN|\/profile|\/messages|\/groups|\/teaching|\/news|xelay\.ink\/api\//)
  assert.equal([...buildPublicSitemap(Array.from({ length: 1005 }, (_, i) => ({ id: `legacy-${i}` }))).matchAll(/\/question\//g)].length, 1000)
})

test('deployed adapters use anonymous bounded reads and robots points directly at the canonical sitemap', async () => {
  const api = await readFile(new URL('../../api/seo.ts', import.meta.url), 'utf8')
  const sitemap = await readFile(new URL('../../api/sitemap.ts', import.meta.url), 'utf8')
  assert.match(api, /select\('id, content, category, created_at'\)\.eq\('id', id\)\.maybeSingle\(\)/)
  assert.match(api, /AbortSignal\.timeout\(5000\)/)
  assert.doesNotMatch(api, /SERVICE_ROLE|req\.headers|req\.cookies/)
  assert.match(sitemap, /limit\(1000\)/)
  assert.match(sitemap, /publicSupabaseConfiguration\(process\.env\)/)
  assert.match(await readFile(new URL('../../public/robots.txt', import.meta.url), 'utf8'), /Sitemap: https:\/\/www\.xelay\.ink\/sitemap\.xml/)
})
