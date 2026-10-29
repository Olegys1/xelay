import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const [legacySource, guideSource, contextSource] = await Promise.all([
  'src/lib/onboarding.ts', 'src/lib/homeGuide.ts', 'src/context/OnboardingContext.tsx',
].map(read))
const plain = value => JSON.parse(JSON.stringify(value))

function compile(source, imports, globals) {
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, ...globals, require(name) { assert.ok(name in imports, 'Unexpected import: ' + name); return imports[name] } })
  return module.exports
}

function runner() {
  const cells = [], effects = []
  let index = 0, dirty = false, component, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    createContext: value => ({ value, Provider: 'OnboardingProvider' }),
    useContext: context => context.value,
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i] },
    useCallback(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: callback }; return cells[i].value },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const old = cells[i]; cells[i] = { deps }; effects.push(() => { old?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  const render = () => {
    for (let iteration = 0; iteration < 25; iteration++) {
      index = 0; dirty = false; tree = component()
      effects.splice(0).forEach(effect => effect())
      if (!dirty) return tree
    }
    throw Error('Unexpected render loop')
  }
  return { react, render, start(next) { component = next; return render() }, unmount() { cells.forEach(cell => cell?.cleanup?.()) } }
}

function fixture(t, { seen = false, path = '/', userId = 'actor-1', storageUnavailable = false, stored = [], legacyPaused = false, legacySeen = false } = {}) {
  const storage = new Map(stored), listeners = new Map(), writes = [], navigation = []
  const browser = {
    localStorage: {
      getItem(key) { if (storageUnavailable) throw Error('storage refused'); return storage.get(key) ?? null },
      setItem(key, value) { if (storageUnavailable) throw Error('storage refused'); writes.push({ key, value }); storage.set(key, value) },
      removeItem(key) { if (storageUnavailable) throw Error('storage refused'); storage.delete(key) },
    },
    addEventListener(name, callback) { const entries = listeners.get(name) || new Set(); entries.add(callback); listeners.set(name, entries) },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback) },
    dispatchEvent(event) { for (const callback of [...(listeners.get(event.type) || [])]) callback(event) },
  }
  const globals = { window: browser, Event: class { constructor(type) { this.type = type } } }
  const legacy = compile(legacySource, {}, globals)
  if (legacyPaused) legacy.saveOnboardingProgress(legacy.guideKey(userId, 'platform'), { step: 3, paused: true })
  if (legacySeen) legacy.rememberGuide(legacy.guideKey(userId, 'platform'))
  const guide = compile(guideSource, { './onboarding': legacy }, globals)
  const auth = { authUser: userId ? { id: userId } : null, xelayUser: userId ? { id: userId, has_seen_onboarding: seen } : null, isLoading: false, isPasswordRecovery: false }
  let pathname = path, activeRun
  const navigate = destination => { navigation.push(destination); pathname = destination.to; return Promise.resolve() }
  const contextFor = run => compile(contextSource, {
    react: run.react,
    'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }) },
    '@tanstack/react-router': { useNavigate: () => navigate, useRouterState: options => options.select({ location: { pathname } }) },
    './AuthContext': { useAuth: () => auth },
    '../lib/onboarding': legacy, '../lib/homeGuide': guide,
  }, globals)
  const mount = () => {
    activeRun = runner()
    const api = contextFor(activeRun)
    activeRun.start(() => { const node = api.ApplicationOnboarding({ children: 'page-content' }); return node.type(node.props) })
  }
  mount()
  t.after(() => activeRun.unmount())
  return {
    guide, legacy, auth, storage, writes, navigation, browser,
    get current() { return activeRun.render().props.value.homeGuide },
    get suspended() { return activeRun.render().props.value.suspended },
    get tree() { return activeRun.render() },
    get pathname() { return pathname },
    route(path) { pathname = path; activeRun.render() },
    replay() { legacy.openPlatformGuide(); activeRun.render() },
    remount() { activeRun.unmount(); mount() },
  }
}

test('new account gets home hints through a provider, with no global dialog or backend module', t => {
  const fx = fixture(t)
  assert.equal(fx.current.available, true)
  assert.equal(fx.current.open, true)
  assert.equal(fx.current.step, 0)
  assert.equal(fx.current.showOffer, false)
  assert.equal(fx.suspended, true)
  assert.equal(fx.tree.type, 'OnboardingProvider')
  assert.equal(fx.tree.props.children, 'page-content')
  assert.equal(fx.writes.length, 0)
})

test('completed existing accounts get a quiet offer rather than an automatic replay', t => {
  for (const options of [{ seen: true }, { legacySeen: true }]) {
    const fx = fixture(t, options)
    assert.equal(fx.current.open, false)
    assert.equal(fx.current.showOffer, true)
    assert.equal(fx.suspended, false)
  }
})

test('guests, password recovery, profile loading and a mismatched profile never show home hints', t => {
  const guest = fixture(t, { userId: null })
  assert.equal(guest.current.available, false)
  guest.replay(); assert.equal(guest.navigation.length, 0); assert.equal(guest.writes.length, 0)
  for (const mutate of [auth => { auth.isLoading = true }, auth => { auth.isPasswordRecovery = true }, auth => { auth.xelayUser = null }, auth => { auth.xelayUser.id = 'other-account' }]) {
    const fx = fixture(t); mutate(fx.auth)
    assert.equal(fx.current.open, false)
    assert.equal(fx.current.available, false)
    assert.equal(fx.suspended, true)
  }
})

test('pause survives navigation, reload and legacy paused progress without an automatic resume', t => {
  const fx = fixture(t)
  fx.current.setStep(2); fx.current.pause()
  assert.equal(fx.current.open, false)
  assert.equal(fx.current.showOffer, false)
  fx.route('/groups'); fx.route('/'); fx.remount()
  assert.equal(fx.current.open, false)
  assert.equal(fx.current.step, 2)
  assert.equal(fx.current.showOffer, false)
  const old = fixture(t, { legacyPaused: true })
  assert.equal(old.current.open, false)
  assert.equal(old.current.showOffer, false)
  old.route('/teaching'); old.route('/')
  assert.equal(old.current.open, false)
})

test('ordinary navigation pauses an active tour while manual menu replay opens home at the first step', t => {
  const fx = fixture(t)
  fx.current.setStep(3); fx.route('/groups')
  assert.equal(fx.current.available, false)
  assert.equal(fx.suspended, false)
  fx.route('/'); assert.equal(fx.current.open, false)
  fx.route('/teaching'); fx.replay()
  assert.deepEqual(plain(fx.navigation), [{ to: '/' }])
  assert.equal(fx.current.open, true)
  assert.equal(fx.current.step, 0)
})

test('finish is local and per account; replay is explicit and previous guide preferences remain intact', t => {
  const fx = fixture(t, { seen: true })
  fx.current.start(); fx.current.setStep(4); fx.current.finish(); fx.remount()
  assert.equal(fx.current.open, false)
  assert.equal(fx.current.showOffer, false)
  const key = fx.guide.homeGuideKey('actor-1')
  assert.deepEqual(JSON.parse(fx.storage.get(key)), { status: 'complete', step: 4 })
  assert.equal(fx.storage.has(fx.legacy.guideKey('actor-1', 'platform')), false)
  assert.equal(fx.auth.xelayUser.has_seen_onboarding, true)
  assert.equal(fx.guide.readHomeGuideProgress(fx.guide.homeGuideKey('actor-2')), null)
  assert.ok(fx.writes.every(write => Object.keys(JSON.parse(write.value)).sort().join(',') === 'status,step'))
  fx.replay(); assert.equal(fx.current.open, true); assert.equal(fx.current.step, 0)
})

test('storage refusal still remembers pause and finish for the session', t => {
  const fx = fixture(t, { storageUnavailable: true })
  fx.current.pause(); fx.remount()
  assert.equal(fx.current.open, false)
  fx.current.start(); fx.current.finish(); fx.remount()
  assert.equal(fx.current.open, false)
  assert.equal(fx.current.showOffer, false)
  assert.equal(fx.writes.length, 0)
})

test('malformed saved progress and invalid steps cannot open an arbitrary step or store extra fields', t => {
  const key = 'xelay:guide:v2:actor-1:home-dashboard-20261029'
  const fx = fixture(t, { seen: true, stored: [[key, JSON.stringify({ status: ['active'], step: 2 })]] })
  assert.equal(fx.current.open, false)
  assert.equal(fx.current.showOffer, true)
  fx.current.start()
  for (const invalid of [-1, 51, Infinity, 1.1, '1', Number.MAX_SAFE_INTEGER]) fx.current.setStep(invalid)
  assert.equal(fx.current.step, 0)
  assert.equal(fx.guide.saveHomeGuideProgress(key, { status: 'active', step: 2, name: 'should-not-persist' }), true)
  assert.deepEqual(JSON.parse(fx.storage.get(key)), { status: 'active', step: 2 })
  assert.equal(fx.guide.saveHomeGuideProgress(key, { status: ['active'], step: 2 }), false)
})
