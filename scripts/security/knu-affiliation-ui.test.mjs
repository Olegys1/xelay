// Execute real component hooks/handlers with synthetic state and no browser/network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const requireDependency = createRequire(process.env.XELAY_TEST_DEPENDENCY_ROOT ? resolve(process.env.XELAY_TEST_DEPENDENCY_ROOT, 'package.json') : import.meta.url)
const ts = requireDependency('typescript')
const root = new URL('../../', import.meta.url), read = path => readFileSync(new URL(path, root), 'utf8')
const actor = '10000000-0000-4000-8000-000000000001', other = '10000000-0000-4000-8000-000000000002'
const challengeId = '20000000-0000-4000-8000-000000000001', start = Date.parse('2026-11-03T12:00:00Z')
const empty = { verifiedEmail: null, verifiedAt: null, authEmailVerified: false }
const pending = { ...empty, challenge: { id: challengeId, email: 'synthetic@knu.ua', expiresAt: new Date(start + 600_000).toISOString(), resendAt: new Date(start + 60_000).toISOString() } }
const confirmed = { verifiedEmail: 'synthetic@knu.ua', verifiedAt: new Date(start + 60_000).toISOString(), authEmailVerified: false }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const plain = value => JSON.parse(JSON.stringify(value))
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
function load(path, imports, globals = {}) {
  const module = { exports: {} }, code = ts.transpileModule(read(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, AbortController, ...globals,
    require(name) { assert.ok(Object.hasOwn(imports, name), 'Unexpected dependency: ' + name); return imports[name] },
  })
  return module.exports
}
const policy = load('src/lib/knuEmailPolicy.ts', {})
const clientApi = load('src/lib/knuAffiliation.ts', { './knuEmailPolicy': policy, './supabase': { supabase: {} } })

function fixture(t, options = {}) {
  let cells = [], effects = [], cursor = 0, dirty = false, tree, key, clock = start, nextTimer = 0, mounted = true
  const intervals = new Map(), calls = [], verified = [], printed = []
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) {
      const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; const cell = cells[i]
      cell.set ??= update => { const value = typeof update === 'function' ? update(cell.value) : update; if (!Object.is(value, cell.value)) { cell.value = value; dirty = true } }
      return [cell.value, cell.set]
    },
    useRef(initial) { return cells[cursor++] ??= { current: initial } },
    useId() { return 'knu-fixture-' + cursor++ },
    useEffect(callback, deps) {
      const i = cursor++, previous = cells[i]
      if (!previous || !same(previous.deps, deps)) { cells[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = callback() }) }
    },
  }
  const record = method => (...args) => {
    calls.push({ method, args })
    if (options[method]) return options[method](...args)
    return Promise.resolve(method === 'request' ? plain(pending) : method === 'verify' ? plain(confirmed) : plain(empty))
  }
  const client = { status: record('status'), request: record('request'), verify: record('verify') }
  let props = { userId: actor, currentLoginEmail: 'legacy@gmail.com', client, onVerified: status => verified.push(plain(status)), ...options.props }
  class FixedDate extends Date { static now() { return clock } }
  const jsx = (type, props, key) => ({ type, props, key })
  const api = load('src/components/profile/KnuEmailVerification.tsx', {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, name) => 'Icon' + String(name) }),
    '../../lib/knuEmailPolicy': policy, '../../lib/knuAffiliation': clientApi,
  }, {
    Date: FixedDate, requestAnimationFrame(callback) { callback() },
    window: { setInterval(callback, ms) { const id = ++nextTimer; intervals.set(id, { callback, ms }); return id }, clearInterval(id) { intervals.delete(id) } },
    localStorage: new Proxy({}, { get() { assert.fail('OTP must not be stored') } }), sessionStorage: new Proxy({}, { get() { assert.fail('OTP must not be stored') } }),
    fetch() { assert.fail('No network in component fixture') }, console: { log: (...x) => printed.push(x), warn: (...x) => printed.push(x), error: (...x) => printed.push(x) },
  })
  const cleanup = () => { for (const cell of cells) cell?.cleanup?.() }
  function render() {
    if (!mounted) return tree
    for (let turn = 0; turn < 30; turn++) {
      const element = api.KnuEmailVerification(props)
      if (key !== element.key) { cleanup(); cells = []; effects = []; key = element.key }
      cursor = 0; dirty = false; tree = element.type(element.props)
      effects.splice(0).forEach(effect => effect())
      if (!dirty) return tree
    }
    throw new Error('Component did not settle')
  }
  const find = (type, predicate = () => true) => nodes(render()).find(node => node.type === type && predicate(node.props))
  const button = label => { const result = find('button', props => text(props.children).trim() === label); assert.ok(result, 'Missing button: ' + label); return result.props }
  async function flush() { for (let turn = 0; turn < 24; turn++) { await Promise.resolve(); render() } }
  function fill(name, value) { const input = find('input', props => props.name === name); assert.ok(input, 'Missing field: ' + name); input.props.onChange({ target: { value } }); render() }
  function submit() { const form = find('form'); assert.ok(form); form.props.onSubmit({ preventDefault() {} }); render() }
  render(); t.after(() => { if (mounted) cleanup(); mounted = false })
  return { calls, verified, printed, client, find, button, fill, submit, flush, render, get text() { return text(render()) },
    update(next) { props = { ...props, ...next }; render() },
    advance(ms) { clock += ms; for (const row of [...intervals.values()]) row.callback(); render() },
    leave() { cleanup(); mounted = false },
  }
}

test('mount reads status without sending a letter, with clear private address and unchanged-login copy', async t => {
  const f = fixture(t); await f.flush()
  assert.deepEqual(f.calls.map(call => call.method), ['status'])
  assert.match(f.text, /Підтвердьте належність до КНУ/); assert.match(f.text, /legacy@gmail.com/); assert.match(f.text, /Ваші групи, матеріали та бали збережуться/)
  f.button('Додати пошту КНУ').onClick(); f.render()
  assert.match(f.text, /Ця адреса залишиться приватною/); assert.match(f.text, /не надає статус викладача або старости/)
  assert.doesNotMatch(f.text, /univ\.knu\.ua/); assert.equal(f.calls.filter(call => call.method === 'request').length, 0)
})

test('initial confirmed status is compact and makes no automatic request or role change', t => {
  const f = fixture(t, { props: { initialStatus: confirmed } })
  assert.equal(f.calls.length, 0); assert.equal(f.find('form'), undefined); assert.equal(f.find('input'), undefined)
  assert.match(f.text, /Пошту КНУ підтверджено/); assert.match(f.text, /synthetic@knu.ua/); assert.match(f.text, /не відображається у відкритому профілі/)
  assert.equal(f.verified.length, 0)
})

test('invalid domains never request a letter; explicit submit normalizes KNU email and blocks double submit', async t => {
  const request = deferred(), f = fixture(t, { request: () => request.promise }); await f.flush()
  f.button('Додати пошту КНУ').onClick(); f.render(); f.fill('knu-affiliation-email', 'synthetic@gmail.com'); f.submit()
  assert.equal(f.calls.filter(call => call.method === 'request').length, 0); assert.match(f.text, /адресою @knu.ua/)
  f.fill('knu-affiliation-email', ' Synthetic@KNU.UA '); f.submit(); f.submit()
  assert.equal(f.calls.filter(call => call.method === 'request').length, 1)
  assert.equal(f.calls.at(-1).args[0], actor); assert.equal(f.calls.at(-1).args[1], 'synthetic@knu.ua')
  request.resolve(plain(pending)); await f.flush()
  assert.ok(f.find('input', props => props.name === 'knu-email-code')); assert.match(f.text, /Код надіслано/)
})

test('OTP is six ASCII digits with leading zeros and is cleared after successful explicit verification', async t => {
  const f = fixture(t, { props: { initialStatus: pending } })
  const codeInput = f.find('input', props => props.name === 'knu-email-code')
  assert.equal(codeInput.props.inputMode, 'numeric'); assert.equal(codeInput.props.autoComplete, 'one-time-code'); assert.equal(codeInput.props.maxLength, 6)
  assert.equal(f.calls.length, 0)
  f.fill('knu-email-code', '00a1234x'); assert.equal(f.find('input', props => props.name === 'knu-email-code').props.value, '001234')
  f.submit(); await f.flush()
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'verify')
  assert.deepEqual(f.calls[0].args.slice(0, 3), [actor, challengeId, '001234'])
  assert.equal(f.find('input', props => props.name === 'knu-email-code'), undefined); assert.match(f.text, /Пошту КНУ підтверджено/)
  assert.deepEqual(f.verified, [confirmed]); assert.equal(f.printed.length, 0)
})

test('resend waits for the server deadline and never auto-sends when the timer expires', async t => {
  const f = fixture(t, { props: { initialStatus: pending } })
  assert.equal(f.button('Новий лист через 60 с').disabled, true)
  f.button('Новий лист через 60 с').onClick(); f.render(); assert.equal(f.calls.length, 0)
  f.advance(60_000); assert.equal(f.button('Надіслати код ще раз').disabled, false); assert.equal(f.calls.length, 0)
  f.button('Надіслати код ще раз').onClick(); await f.flush()
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'request'); assert.equal(f.calls[0].args[1], pending.challenge.email)
})

test('expired challenges cannot verify and a server invalid-code reply clears only the code', async t => {
  const expired = fixture(t, { props: { initialStatus: pending } }); expired.advance(601_000)
  assert.match(expired.text, /Термін дії цього коду завершився/)
  assert.equal(expired.find('input', props => props.name === 'knu-email-code').props.disabled, true)
  expired.submit(); assert.equal(expired.calls.length, 0)
  const invalid = fixture(t, { props: { initialStatus: pending }, verify: async () => { throw new clientApi.KnuAffiliationError('KNU_EMAIL_CODE_INVALID', 400) } })
  invalid.fill('knu-email-code', '123456'); invalid.submit(); await invalid.flush()
  assert.match(invalid.text, /Код неправильний/); assert.equal(invalid.find('input', props => props.name === 'knu-email-code').props.value, '')
  assert.match(invalid.text, /synthetic@knu.ua/); assert.equal(invalid.verified.length, 0)
})

test('rate-limit retry delay survives a failed request without inventing a sent challenge', async t => {
  const f = fixture(t, { props: { initialStatus: empty }, request: async () => { throw new clientApi.KnuAffiliationError('KNU_EMAIL_RATE_LIMIT', 429, 90) } })
  f.button('Додати пошту КНУ').onClick(); f.render(); f.fill('knu-affiliation-email', 'synthetic@knu.ua'); f.submit(); await f.flush()
  assert.match(f.text, /надто часто/); assert.equal(f.find('input', props => props.name === 'knu-email-code'), undefined)
  assert.equal(f.button('Повторити через 90 с').disabled, true); f.submit(); assert.equal(f.calls.length, 1)
})

test('switching accounts aborts pending verification and ignores a late success before any callback', async t => {
  const result = deferred(), f = fixture(t, { props: { initialStatus: pending }, verify: () => result.promise })
  f.fill('knu-email-code', '001234'); f.submit(); const signal = f.calls[0].args[3]
  f.update({ userId: other, currentLoginEmail: 'other@gmail.com', initialStatus: empty })
  assert.equal(signal.aborted, true); assert.doesNotMatch(f.text, /synthetic@knu.ua|legacy@gmail.com|Код надіслано/)
  result.resolve(plain(confirmed)); await f.flush()
  assert.doesNotMatch(f.text, /Пошту КНУ підтверджено|synthetic@knu.ua/); assert.equal(f.verified.length, 0)
})

test('unmount aborts an in-flight request and a late response cannot trigger success', async t => {
  const result = deferred(), f = fixture(t, { props: { initialStatus: empty }, request: () => result.promise })
  f.button('Додати пошту КНУ').onClick(); f.render(); f.fill('knu-affiliation-email', 'synthetic@knu.ua'); f.submit()
  const signal = f.calls[0].args[2]; f.leave(); assert.equal(signal.aborted, true)
  result.resolve(plain(pending)); await f.flush(); assert.equal(f.verified.length, 0); assert.equal(f.printed.length, 0)
})
