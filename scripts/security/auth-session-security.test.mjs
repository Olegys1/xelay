// Executes the real helpers/components with isolated Auth mocks. No network or browser accounts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = (path) => readFile(resolve(root, path), 'utf8')
const memoryStorage = () => {
  const values = new Map()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values }
}
function execute(sourceText, dependencies = {}, globals = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`)
    return dependencies[name]
  }, URL, URLSearchParams, console, setTimeout, clearTimeout, atob, ...globals })
  return module.exports
}
const parser = execute(await source('src/lib/authEmailLinks.ts')).parseEmailLink
const authEmailSource = await source('src/lib/authEmail.ts')
const makeUser = (id) => ({ id, email: `${id}@example.test`, email_confirmed_at: '2026-10-03T00:00:00Z' })
const accessUser = makeUser('link-account')
const existingUser = makeUser('existing-account')
const linkUrl = (type = 'signup', path = '/auth/callback') => `https://example.test${path}#access_token=link-access&refresh_token=link-refresh&type=${type}`
function emailFixture(url = linkUrl(), { identity = accessUser, refreshUser = accessUser, identityError = null, refreshError = null } = {}) {
  const calls = []
  let current = existingUser
  const storage = memoryStorage()
  const window = { location: new URL(url), sessionStorage: storage, history: { state: null, replaceState: (_state, _title, path) => calls.push(['scrub', path]) } }
  const supabase = { auth: {
    getUser: async (token) => { calls.push(['identity', token]); return { data: { user: identity }, error: identityError } },
    setSession: async (tokens) => { calls.push(['main-session', tokens]); current = refreshUser; return { data: { user: refreshUser, session: { ...tokens, user: refreshUser } }, error: null } },
  } }
  const emailLinkVerifier = () => ({ auth: { refreshSession: async (tokens) => {
    calls.push(['isolated-refresh', tokens])
    return { data: { user: refreshUser, session: refreshError ? null : { access_token: 'verified-access', refresh_token: 'verified-refresh', user: refreshUser } }, error: refreshError }
  } } })
  const exports = execute(authEmailSource, { './supabase': { supabase, emailLinkVerifier }, './authEmailLinks': { parseEmailLink: parser } }, { window })
  return { exports, calls, storage, currentUser: () => current }
}
const native = (value) => JSON.parse(JSON.stringify(value))

test('legacy implicit signup/email/recovery links are route bound and cross-device compatible', () => {
  for (const [type, path, kind] of [['signup', '/auth/callback', 'confirmation'], ['email', '/auth/callback', 'confirmation'], ['recovery', '/reset-password', 'recovery']]) {
    const parsed = parser(new URL(linkUrl(type, path)))
    assert.equal(parsed.kind, kind)
    assert.deepEqual(native(parsed.tokens), { access_token: 'link-access', refresh_token: 'link-refresh' })
  }
  for (const url of [linkUrl('recovery'), linkUrl('signup', '/reset-password'), linkUrl('signup', '/profile'), 'https://example.test/auth/callback?type=signup&code=old-pkce-code', 'https://example.test/reset-password#type=recovery&access_token=only-access', `${linkUrl()}&error_description=expired`]) {
    assert.equal(parser(new URL(url)).tokens, null, url)
  }
})

test('loading a link only scrubs credentials; identity inspection never switches the account', async () => {
  const fixture = emailFixture(`${linkUrl()}&expires_in=3600`)
  assert.deepEqual(fixture.calls, [['scrub', '/auth/callback']])
  assert.equal(fixture.currentUser().id, existingUser.id)
  assert.equal(fixture.storage.values.size, 0)
  assert.equal((await fixture.exports.emailLinkIdentity()).id, accessUser.id)
  assert.equal((await fixture.exports.emailLinkIdentity()).id, accessUser.id)
  assert.equal(fixture.calls.filter(([name]) => name === 'identity').length, 1)
  assert.equal(fixture.calls.filter(([name]) => name.includes('refresh') || name === 'main-session').length, 0)
  assert.equal(fixture.currentUser().id, existingUser.id)
})

test('a different refresh-token identity is rejected before touching the persisted session', async () => {
  const fixture = emailFixture(linkUrl(), { refreshUser: existingUser })
  await assert.rejects(fixture.exports.acceptEmailLink, /Invalid email session/)
  assert.equal(fixture.currentUser().id, existingUser.id)
  assert.equal(fixture.calls.filter(([name]) => name === 'main-session').length, 0)
  assert.deepEqual(fixture.calls.map(([name]) => name), ['scrub', 'identity', 'isolated-refresh'])
})

test('explicit consent verifies refresh first, applies only verified credentials, and consumes the link', async () => {
  const fixture = emailFixture(linkUrl('recovery', '/reset-password'))
  const session = await fixture.exports.acceptEmailLink()
  assert.equal(session.user.id, accessUser.id)
  assert.deepEqual(fixture.calls.map(([name]) => name), ['scrub', 'identity', 'isolated-refresh', 'main-session'])
  assert.deepEqual(native(fixture.calls.at(-1)[1]), { access_token: 'verified-access', refresh_token: 'verified-refresh' })
  await assert.rejects(fixture.exports.acceptEmailLink, /Invalid email link|already used/)
  assert.equal(fixture.calls.filter(([name]) => name === 'main-session').length, 1)
})

test('invalid, unconfirmed, errored and expired links fail without session writes', async () => {
  const cases = [
    emailFixture(linkUrl('invite')),
    emailFixture(`${linkUrl()}&error=access_denied`),
    emailFixture('https://example.test/auth/callback?type=signup&token_hash=legacy'),
    emailFixture(linkUrl(), { identity: { ...accessUser, email_confirmed_at: null } }),
    emailFixture(linkUrl(), { identityError: new Error('invalid JWT') }),
    emailFixture(linkUrl(), { refreshError: new Error('expired refresh') }),
  ]
  for (const fixture of cases) {
    await assert.rejects(fixture.exports.acceptEmailLink)
    assert.equal(fixture.calls.filter(([name]) => name === 'main-session').length, 0)
    assert.equal(fixture.currentUser().id, existingUser.id)
  }
})

test('both Auth clients disable URL session detection; verifier cannot persist or refresh in background', async () => {
  const options = []
  const code = (await source('src/lib/supabase.ts')).replace('import.meta.env.VITE_SUPABASE_URL', "'https://synthetic.supabase.test'").replace('import.meta.env.VITE_SUPABASE_ANON_KEY', "'synthetic-public-key'")
  const { emailLinkVerifier } = execute(code, { '@supabase/supabase-js': { createClient: (_url, _key, config) => { options.push(native(config)); return {} } } })
  emailLinkVerifier()
  assert.deepEqual(options.map((config) => config.auth), [
    { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  ])
})

// Minimal hook runner exercises real component callbacks, cleanup and delayed requests.
// It intentionally does not claim browser rendering or React integration coverage.
function hookRunner() {
  const slots = []
  let cursor = 0
  let alive = true
  let writesAfterUnmount = 0
  const pending = []
  const changed = (a, b) => !a || a.length !== b.length || a.some((v, i) => v !== b[i])
  const react = {
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, (value) => { if (!alive) writesAfterUnmount++; slots[index].value = typeof value === 'function' ? value(slots[index].value) : value }]
    },
    useRef(value) { const index = cursor++; slots[index] ??= { current: value }; return slots[index] },
    useCallback(fn, deps) { const index = cursor++; if (changed(slots[index]?.deps, deps)) slots[index] = { value: fn, deps }; return slots[index].value },
    useEffect(fn, deps) { const index = cursor++; if (changed(slots[index]?.deps, deps)) { const previous = slots[index]; slots[index] = { deps, cleanup: previous?.cleanup }; pending.push(() => { previous?.cleanup?.(); slots[index].cleanup = fn() }) } },
  }
  const jsx = (type, props) => ({ type, props })
  return { react, runtime: { jsx, jsxs: jsx, Fragment: 'fragment' }, render: (fn, props) => { cursor = 0; const tree = fn(props); pending.splice(0).forEach((effect) => effect()); return tree }, unmount: () => { slots.forEach((slot) => slot?.cleanup?.()); alive = false }, writesAfterUnmount: () => writesAfterUnmount }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise((accept) => { resolve = accept }); return { promise, resolve } }
function nodes(tree) {
  if (tree == null || typeof tree === 'boolean') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (typeof tree !== 'object') return [tree]
  return [tree, ...nodes(tree.props?.children)]
}

test('confirmation component inspects identity on mount and accepts only after clicking, with duplicate-click lock', async () => {
  const runner = hookRunner()
  const result = deferred()
  let accepted = 0
  let applied = 0
  const component = execute(await source('src/components/EmailLinkConfirmation.tsx'), {
    react: runner.react, 'react/jsx-runtime': runner.runtime,
    '../lib/authEmail': { emailLinkIdentity: async () => accessUser, acceptEmailLink: async () => { accepted++; return result.promise } },
  }).EmailLinkConfirmation
  const props = { onAccepted: async () => { applied++ } }
  runner.render(component, props)
  await flush()
  const button = nodes(runner.render(component, props)).find((node) => node.type === 'button')
  assert.equal(accepted, 0)
  button.props.onClick()
  button.props.onClick()
  await flush()
  assert.equal(accepted, 1)
  assert.equal(applied, 0)
  result.resolve({ user: accessUser })
  await flush()
  assert.equal(applied, 1)
  runner.unmount()
})

test('recovery marker requires matching user/session, expires in 20 minutes and rejects future markers', async () => {
  const storage = memoryStorage()
  const code = await source('src/context/AuthContext.tsx')
  const end = code.indexOf('const AuthContext =')
  const helpers = execute(code.slice(code.indexOf('const RECOVERY_KEY'), end) + '\nexport { sessionIdentity, recoveryDeadlineFor }', {}, { sessionStorage: storage })
  const token = `header.${Buffer.from(JSON.stringify({ session_id: 'session-a' })).toString('base64url')}.signature`
  assert.equal(helpers.sessionIdentity(token), 'session-a')
  assert.equal(helpers.sessionIdentity('broken'), null)
  const startedAt = Date.now() - 1000
  const marker = (change = {}) => storage.setItem('xelay_password_recovery', JSON.stringify({ userId: 'account-a', sessionId: 'session-a', startedAt, ...change }))
  marker()
  assert.equal(helpers.recoveryDeadlineFor('account-a', 'session-a'), startedAt + 20 * 60 * 1000)
  assert.equal(helpers.recoveryDeadlineFor('account-b', 'session-a'), 0)
  assert.equal(helpers.recoveryDeadlineFor('account-a', 'session-b'), 0)
  assert.equal(helpers.recoveryDeadlineFor('account-a', null), 0)
  marker({ startedAt: Date.now() - 20 * 60 * 1000 - 1 })
  assert.equal(helpers.recoveryDeadlineFor('account-a', 'session-a'), 0)
  marker({ startedAt: Date.now() + 60_000 })
  assert.equal(helpers.recoveryDeadlineFor('account-a', 'session-a'), 0)
  storage.setItem('xelay_password_recovery', 'malformed')
  assert.equal(helpers.recoveryDeadlineFor('account-a', 'session-a'), 0)
})

test('MFA gate unmounts on account change and ignores delayed check/enrollment from the previous account', async () => {
  assert.match(await source('src/App.tsx'), /<AdminSecurityGate\s+key=\{authUser\?\.id\s*\|\|\s*'guest'\}/)
  const gateSource = await source('src/components/AdminSecurityGate.tsx')
  for (const action of ['check', 'enroll']) {
    const runner = hookRunner()
    const waiting = deferred()
    let factorReads = 0
    const auth = { authUser: { id: 'admin-a' }, xelayUser: { isPlatformAdmin: true }, isLoading: false, signOut: async () => {}, refreshUser: async () => {} }
    const component = execute(gateSource, {
      react: runner.react, 'react/jsx-runtime': runner.runtime, 'lucide-react': { ShieldCheck: 'shield' }, '../context/AuthContext': { useAuth: () => auth },
      '../lib/supabase': { supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), mfa: {
        getAuthenticatorAssuranceLevel: () => action === 'check' ? waiting.promise : Promise.resolve({ data: { currentLevel: 'aal1' } }),
        listFactors: async () => { factorReads++; return { data: { all: [], totp: [] } } },
        enroll: () => waiting.promise,
      } } } },
    }).AdminSecurityGate
    const props = { children: 'PROTECTED-ADMIN-CONTENT' }
    runner.render(component, props)
    await flush()
    if (action === 'enroll') {
      const button = nodes(runner.render(component, props)).find((node) => node.type === 'button' && node.props.children === 'Налаштувати захист')
      button.props.onClick()
      await flush()
      assert.equal(factorReads, 2)
    }
    runner.unmount()
    waiting.resolve(action === 'check' ? { data: { currentLevel: 'aal2' } } : { data: { id: 'factor-old', totp: { qr_code: 'old-qr', secret: 'SYNTHETIC-OLD-SECRET' } } })
    await flush()
    assert.equal(runner.writesAfterUnmount(), 0, action)
  }
})

test('MFA gate reveals protected content only at AAL2 with a verified factor and leaves ordinary users unaffected', async () => {
  const gateSource = await source('src/components/AdminSecurityGate.tsx')
  for (const [isAdmin, level, status, allowed] of [[true,'aal1','verified',false],[true,'aal2','unverified',false],[true,'aal2','verified',true],[false,'aal1','unverified',true]]) {
    const runner = hookRunner()
    const component = execute(gateSource, {
      react: runner.react, 'react/jsx-runtime': runner.runtime, 'lucide-react': { ShieldCheck: 'shield' },
      '../context/AuthContext': { useAuth: () => ({ authUser: { id: 'synthetic-user' }, xelayUser: { isPlatformAdmin: isAdmin }, isLoading: false }) },
      '../lib/supabase': { supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: level } }),
        listFactors: async () => ({ data: { totp: [{ id: 'synthetic-factor', status }], all: [] } }),
      } } } },
    }).AdminSecurityGate
    const props = { children: 'PROTECTED-ADMIN-CONTENT' }
    runner.render(component, props)
    await flush()
    assert.equal(nodes(runner.render(component, props)).includes('PROTECTED-ADMIN-CONTENT'), allowed, `${isAdmin}/${level}/${status}`)
    runner.unmount()
  }
})

test('Auth provider rejects stale session refresh after account switch or unmount and defers profile requests outside Auth callbacks', async () => {
  const contextSource = await source('src/context/AuthContext.tsx')
  for (const scenario of ['switch', 'unmount']) {
    const runner = hookRunner()
    const refresh = deferred()
    const timers = new Map()
    let timerId = 0
    let authEvent
    let profileCalls = 0
    const react = { ...runner.react, createContext: () => ({ Provider: 'AuthProvider' }), useContext: () => { throw new Error('No consumer required') } }
    const component = execute(contextSource, {
      react, 'react/jsx-runtime': runner.runtime,
      '../lib/supabase': { supabase: {
        auth: { getSession: () => refresh.promise, onAuthStateChange: (callback) => { authEvent = callback; return { data: { subscription: { unsubscribe() {} } } } } },
        from: () => { profileCalls++; throw new Error('Profile must be deferred') },
      } },
    }, { sessionStorage: memoryStorage(), setTimeout: (callback) => { timers.set(++timerId, callback); return timerId }, clearTimeout: (id) => timers.delete(id) }).AuthProvider
    const props = { children: 'ordinary-content' }
    runner.render(component, props)
    authEvent('SIGNED_IN', { user: accessUser, access_token: 'synthetic' })
    let tree = runner.render(component, props)
    assert.equal(tree.props.value.authUser.id, accessUser.id)
    assert.equal(profileCalls, 0)
    const pendingRefresh = tree.props.value.refreshUser()
    if (scenario === 'switch') {
      authEvent('SIGNED_IN', { user: existingUser, access_token: 'synthetic' })
      tree = runner.render(component, props)
      assert.equal(tree.props.value.authUser.id, existingUser.id)
    } else runner.unmount()
    refresh.resolve({ data: { session: { user: accessUser } }, error: null })
    await pendingRefresh
    await flush()
    if (scenario === 'switch') {
      assert.equal(runner.render(component, props).props.value.authUser.id, existingUser.id)
      runner.unmount()
    }
    assert.equal(runner.writesAfterUnmount(), 0)
    assert.equal(profileCalls, 0)
    assert.equal(timers.size, 0)
  }
})
