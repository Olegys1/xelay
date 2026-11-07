import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSeoPreviewHandler, SEO_PREVIEW_QUESTION, matchPreviewSource } from '../preview-public-seo.mjs'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'xelay-seo-preview-'))
  await mkdir(join(directory, 'seo'))
  const html = '<!doctype html><html lang="uk"><head><title>Xelay</title></head><body><div id="root"><!--xelay-public-root-start--><main>Головна</main><!--xelay-public-root-end--></div></body></html>'
  await writeFile(join(directory, 'index.html'), html)
  await writeFile(join(directory, 'seo/students.html'), '<title>Студентам · Xelay</title><h1>Студентам</h1>')
  await writeFile(join(directory, '404.html'), '<title>404 · Xelay</title><h1>Сторінку не знайдено</h1>')
  const config = {
    headers: [{ source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }] }],
    redirects: [
      { source: '/', destination: '/category/general-questions', permanent: true, has: [{ type: 'query', key: 'category', value: 'General Questions' }] },
      { source: '/community', destination: '/category/career', permanent: true, has: [{ type: 'query', key: 'category', value: 'Career' }] },
      { source: '/students/', destination: '/students', permanent: true },
    ],
    rewrites: [
      { source: '/students', destination: '/seo/students.html' },
      { source: '/profile', destination: '/index.html' },
      { source: '/community', destination: '/index.html' },
      { source: '/api/supabase/:path*', destination: 'https://forbidden.invalid/:path*' },
    ],
  }
  return { handler: createSeoPreviewHandler({ directory, config }), dispose: () => rm(directory, { recursive: true, force: true }) }
}

async function request(handler, url, options = {}) {
  const headers = new Map()
  let body = Buffer.alloc(0)
  const response = {
    statusCode: 200,
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); return this },
    end(value) { if (value !== undefined) body = Buffer.isBuffer(value) ? value : Buffer.from(value); return this },
  }
  await handler({ url, method: options.method || 'GET', headers: { host: options.host || '127.0.0.1:3092', ...(options.accept ? { accept: options.accept } : {}) } }, response)
  return { status: response.statusCode, headers, body: body.toString('utf8') }
}

test('local preview serves actual static rewrites, HEAD and real missing paths without an SPA fallback', async () => {
  const f = await fixture()
  try {
    const page = await request(f.handler, '/students')
    assert.equal(page.status, 200); assert.match(page.body, /Студентам/)
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow')
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
    const head = await request(f.handler, '/students', { method: 'HEAD' })
    assert.equal(head.status, 200); assert.equal(head.body, '')
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(page.body)))
    for (const path of ['/missing-route', '/assets/missing.js']) {
      const missing = await request(f.handler, path)
      assert.equal(missing.status, 404); assert.match(missing.body, /Сторінку не знайдено/)
    }
    const redirected = await request(f.handler, '/students/')
    assert.equal(redirected.status, 308); assert.equal(redirected.headers.get('location'), '/students')
  } finally { await f.dispose() }
})

test('legacy category redirects require their matching query condition and leave plain routes alone', async () => {
  const f = await fixture()
  try {
    for (const url of ['/', '/?category=Career', '/?category=General%20Questions%20Extra', '/?other=General%20Questions', '/community', '/community?category=General%20Questions']) {
      const page = await request(f.handler, url)
      assert.equal(page.status, 200, url)
      assert.equal(page.headers.get('location'), undefined)
    }
    const category = await request(f.handler, '/?category=General%20Questions')
    assert.equal(category.status, 308)
    assert.equal(category.headers.get('location'), '/category/general-questions?category=General%20Questions')
    const community = await request(f.handler, '/community?category=Career')
    assert.equal(community.status, 308)
    assert.equal(community.headers.get('location'), '/category/career?category=Career')
  } finally { await f.dispose() }
})

test('real question SEO helper uses only a synthetic read fixture and preserves local noindex headers', async () => {
  const f = await fixture()
  try {
    const page = await request(f.handler, '/question/' + SEO_PREVIEW_QUESTION.id)
    assert.equal(page.status, 200); assert.match(page.body, /Як зібрати розклад/)
    assert.match(page.body, /rel="canonical" href="https:\/\/www\.xelay\.ink\/question\/11111111-/)
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow')
    assert.equal((await request(f.handler, '/question/does-not-exist')).status, 404)
    assert.equal((await request(f.handler, '/api/seo?question=a&question=b')).status, 404)
    const sitemap = await request(f.handler, '/sitemap.xml')
    assert.equal(sitemap.status, 200); assert.match(sitemap.body, /\/students<\/loc>/)
    assert.match(sitemap.body, /\/category\/general-questions<\/loc>/)
    assert.match(sitemap.body, new RegExp(SEO_PREVIEW_QUESTION.id))
    assert.doesNotMatch(sitemap.body, /\/profile|\/messages|\/news/)
  } finally { await f.dispose() }
})

test('fake data supports question reads and counts while authentication and all writes stay disconnected', async () => {
  const f = await fixture()
  try {
    const single = await request(f.handler, '/fake-supabase/rest/v1/questions?id=eq.' + SEO_PREVIEW_QUESTION.id, { accept: 'application/vnd.pgrst.object+json' })
    assert.equal(single.status, 200); assert.equal(JSON.parse(single.body).id, SEO_PREVIEW_QUESTION.id)
    const count = await request(f.handler, '/fake-supabase/rest/v1/questions', { method: 'HEAD' })
    assert.equal(count.headers.get('content-range'), '0-0/1'); assert.equal(count.body, '')
    assert.deepEqual(JSON.parse((await request(f.handler, '/fake-supabase/rest/v1/answers')).body), [])
    assert.equal((await request(f.handler, '/fake-supabase/auth/v1/token', { method: 'POST' })).status, 401)
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      assert.equal((await request(f.handler, '/fake-supabase/rest/v1/questions', { method })).status, 405)
    }
    assert.equal((await request(f.handler, '/fake-supabase/rest/v1/rpc/dangerous-write', { method: 'POST' })).status, 405)
    assert.equal((await request(f.handler, '/api/supabase/rest/v1/questions')).status, 404)
  } finally { await f.dispose() }
})

test('preview rejects path escape and remote hosts; rewrite matching retains named captures', async () => {
  const f = await fixture()
  try {
    for (const path of ['/../index.html', '/%2e%2e/index.html', '/assets%2f..%2findex.html', '/%00index.html', '//outside.invalid/path']) {
      assert.equal((await request(f.handler, path)).status, 400)
    }
    assert.equal((await request(f.handler, '/', { host: 'outside.invalid:3092' })).status, 403)
    assert.equal(matchPreviewSource('/api/:path*', '/api/rest/v1/questions').groups.path, 'rest/v1/questions')
    assert.equal(matchPreviewSource('/question/:id', '/question/a').groups.id, 'a')
    assert.equal(matchPreviewSource('/question/:id', '/question/a/b'), null)
  } finally { await f.dispose() }
})
