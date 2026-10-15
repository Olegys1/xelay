import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

const source = await readFile(new URL('../../src/lib/supabaseTransport.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const module = { exports: {} }
vm.runInNewContext(code, { exports: module.exports, module, URL, Request, Headers, AbortController, setTimeout, clearTimeout, fetch })
const { createSupabaseTransport, SUPABASE_RELAY_UPSTREAM: upstream } = module.exports
const app = 'https://www.xelay.ink'
const blockedDirect = handler => async (input, init) => {
  if (input === `${upstream}/auth/v1/health`) throw new TypeError('Synthetic direct host is unreachable')
  return handler(input, init)
}

test('auth and REST use the same-origin relay with method, JWT, key, body, query and abort intact', async () => {
  const calls = []
  const transport = createSupabaseTransport(upstream, app, blockedDirect(async (input, init) => {
    const request = new Request(input, init)
    calls.push(request)
    return new Response('{}', { status: 200 })
  }))
  const controller = new AbortController()
  await transport(`${upstream}/auth/v1/token?grant_type=password`, {
    method: 'POST', body: JSON.stringify({ email: 'synthetic@example.test', password: 'synthetic-only' }),
    headers: { apikey: 'synthetic-anon', authorization: 'Bearer synthetic-jwt', 'content-type': 'application/json' },
    signal: controller.signal,
  })
  assert.equal(calls[0].url, `${app}/api/supabase/auth/v1/token?grant_type=password`)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.get('apikey'), 'synthetic-anon')
  assert.equal(calls[0].headers.get('authorization'), 'Bearer synthetic-jwt')
  assert.deepEqual(await calls[0].json(), { email: 'synthetic@example.test', password: 'synthetic-only' })
  assert.equal(calls[0].credentials, 'omit')
  assert.equal(calls[0].cache, 'no-store')
  assert.equal(calls[0].redirect, 'error')
  assert.equal(calls[0].referrerPolicy, 'no-referrer')
  controller.abort()
  assert.equal(calls[0].signal.aborted, true)
  await transport(new Request(`${upstream}/rest/v1/profiles?select=id&id=eq.synthetic`, { headers: { authorization: 'Bearer another-jwt' } }))
  assert.equal(calls[1].url, `${app}/api/supabase/rest/v1/profiles?select=id&id=eq.synthetic`)
  assert.equal(calls[1].headers.get('authorization'), 'Bearer another-jwt')
})

test('the actual SDK keeps its session key and Realtime host while its auth/REST calls are relayed', async () => {
  const calls = []
  const transport = createSupabaseTransport(upstream, app, blockedDirect(async (input, init) => {
    const request = new Request(input, init)
    calls.push(request)
    return new Response(JSON.stringify(request.url.includes('/auth/')
      ? { error: 'invalid_credentials', error_description: 'Invalid login credentials' } : []), {
      status: request.url.includes('/auth/') ? 400 : 200, headers: { 'content-type': 'application/json' },
    })
  }))
  const client = createClient(upstream, 'synthetic-anon', {
    global: { fetch: transport }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  await client.auth.signInWithPassword({ email: 'synthetic@example.test', password: 'synthetic-only' })
  await client.from('profiles').select('id')
  assert.ok(client.auth.storageKey.startsWith('sb-baohfpadxvhqhhjjqtil-'))
  assert.equal(new URL(client.realtime.endPoint).hostname, 'baohfpadxvhqhhjjqtil.supabase.co')
  assert.equal(calls.length, 2)
  assert.ok(calls.every(request => request.url.startsWith(`${app}/api/supabase/`)))
  assert.ok(calls.every(request => request.headers.get('apikey') === 'synthetic-anon'))
})

test('network failures, failed writes and rotating refresh tokens are never replayed', async () => {
  for (const path of ['/rest/v1/rpc/any_write', '/auth/v1/token?grant_type=refresh_token']) {
    let count = 0
    const failure = new TypeError('Synthetic lost response')
    const transport = createSupabaseTransport(upstream, app, blockedDirect(async () => { count++; throw failure }))
    await assert.rejects(transport(`${upstream}${path}`, { method: 'POST', body: '{}' }), error => error === failure)
    assert.equal(count, 1)
  }
})

test('HTTP failures are preserved for the SDK, without falling back to direct calls', async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    let count = 0
    const response = new Response('{"error":"synthetic"}', { status })
    const transport = createSupabaseTransport(upstream, app, blockedDirect(async () => { count++; return response }))
    assert.equal(await transport(`${upstream}/rest/v1/profiles`), response)
    assert.equal(count, 1)
  }
})

test('healthy connections keep their direct route and share one credential-free health probe', async () => {
  const calls = []
  const transport = createSupabaseTransport(upstream, app, async (input, init) => {
    calls.push([input, init])
    return new Response('{}', { status: 200 })
  })
  await Promise.all([
    transport(`${upstream}/auth/v1/token`, { method: 'POST', headers: { apikey: 'public-key', authorization: 'Bearer private-jwt' }, body: 'private-password-body' }),
    transport(`${upstream}/rest/v1/profiles`, { headers: { apikey: 'public-key' } }),
  ])
  assert.equal(calls.length, 3)
  assert.equal(calls[0][0], `${upstream}/auth/v1/health`)
  assert.deepEqual(Object.keys(calls[0][1].headers), ['apikey'])
  assert.equal(calls[0][1].headers.apikey, 'public-key')
  assert.equal(calls[0][1].body, undefined)
  assert.ok(calls.slice(1).every(([input]) => typeof input === 'string' && input.startsWith(upstream)))
  assert.equal(calls[1][1].body, 'private-password-body')
})

test('real HTTP denials never switch routes; a lost direct response changes only the next attempt', async () => {
  for (const status of [401, 403, 429, 503]) {
    const calls = []
    const transport = createSupabaseTransport(upstream, app, async (input, init) => {
      calls.push([input, init])
      return new Response('{}', { status })
    })
    assert.equal((await transport(`${upstream}/auth/v1/token`, { method: 'POST', body: '{}' })).status, status)
    assert.equal((await transport(`${upstream}/auth/v1/token`, { method: 'POST', body: '{}' })).status, status)
    assert.equal(calls.length, 3)
    assert.ok(calls.every(([input]) => typeof input === 'string' && input.startsWith(upstream)))
  }
  const calls = []
  const transport = createSupabaseTransport(upstream, app, async (input, init) => {
    calls.push([input, init])
    if (input === `${upstream}/auth/v1/health`) return new Response('{}')
    if (typeof input === 'string') throw new TypeError('Synthetic lost direct response')
    return new Response('{}')
  })
  await assert.rejects(transport(`${upstream}/auth/v1/token`, { method: 'POST', body: '{}' }))
  assert.equal(calls.length, 2)
  await transport(`${upstream}/auth/v1/token`, { method: 'POST', body: '{}' })
  assert.equal(calls.length, 3)
  assert.equal(calls[2][0].url, `${app}/api/supabase/auth/v1/token`)
})

test('other origins, project refs, storage, Realtime, functions and unrelated paths are not redirected', async () => {
  const unchanged = [
    'https://other.supabase.co/rest/v1/profiles', 'https://example.test/auth/v1/token',
    `${upstream}/storage/v1/object/private/file`, `${upstream}/realtime/v1/api`, `${upstream}/functions/v1/example`,
    `${upstream}/rest/v10/profiles`, '/api/unrelated',
  ]
  const calls = []
  const transport = createSupabaseTransport(upstream, app, async (input, init) => { calls.push([input, init]); return new Response('{}') })
  for (const input of unchanged) await transport(input)
  assert.deepEqual(calls.map(([input]) => input), unchanged)
  for (const config of [
    ['https://staging.supabase.co', app], [upstream, 'http://localhost:3000'],
    [upstream, null], ['invalid', app], [`${upstream}/other`, app],
  ]) {
    let input
    await createSupabaseTransport(...config, async value => { input = value; return new Response('{}') })(`${upstream}/auth/v1/user`)
    assert.equal(input, `${upstream}/auth/v1/user`)
  }
})

test('ambiguous path escaping is rejected before any request is transmitted', async () => {
  let count = 0
  const transport = createSupabaseTransport(upstream, app, async () => { count++; return new Response('{}') })
  for (const path of [
    '/auth/v1/../../../storage/v1/object/file', '/auth/v1/%2e%2e/%2e%2e/storage/v1/object/file',
    '/rest/v1//profiles', '/rest/v1/%2fprofiles', '/rest/v1/%5cprofiles', '/rest/v1/%252e%252e/admin',
    '/rest/v1/./profiles', '/rest/v1/\\profiles',
  ]) await assert.rejects(transport(upstream + path), error => error.name === 'TypeError')
  assert.equal(count, 0)
})

test('relay rewrites are fixed, precede the API catchall and cannot enable shared caching', async () => {
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'))
  const catchall = config.rewrites.findIndex(rule => rule.source === '/api/(.*)')
  const routes = config.rewrites.filter(rule => rule.source.startsWith('/api/supabase/'))
  assert.equal(routes.length, 2)
  for (const route of routes) {
    assert.ok(config.rewrites.indexOf(route) < catchall)
    assert.ok(route.destination.startsWith(`${upstream}/`))
    assert.ok(/^\/api\/supabase\/(auth|rest)\/v1\/:path\*$/.test(route.source))
  }
  const headers = config.headers.find(rule => rule.source === '/api/supabase/(.*)').headers
  for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.ok(headers.find(header => header.key === name)?.value.includes('no-store'))
  }
  assert.ok(!config.headers.some(rule => rule.headers.some(header => header.key === 'x-vercel-enable-rewrite-caching')))
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE|service_role|console\./)
})
