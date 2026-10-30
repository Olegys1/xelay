import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const read = name => readFile(new URL('../../' + name, import.meta.url), 'utf8')
const providerSource = await read('src/context/HalloweenHuntContext.tsx')
const pumpkinSource = await read('src/components/halloween/HalloweenPumpkin.tsx')
const experienceSource = await read('src/components/halloween/HalloweenExperience.tsx')
const startsAt = '2026-10-18T09:00:00.000Z'
const endsAt = '2026-11-01T22:00:00.000Z'
const ids = ['home', 'questions', 'news', 'groups', 'people', 'messages', 'support', 'opportunities', 'subscription', 'profile']
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const phaseState = (collected = [], overrides = {}) => ({ campaignId: 'halloween-2026', startsAt, endsAt, serverNow: '2026-10-18T10:00:00Z', phase: 'active', eligible: true, ineligibleReason: null, collected, completed: collected.length === 10, completedAt: collected.length === 10 ? '2026-10-18T10:00:00Z' : null, badgeEarned: collected.length === 10, showBadge: true, subscriptionWon: false, subscriptionStartsAt: null, subscriptionEndsAt: null, winnersRemaining: 5, ...overrides })
function load(source, imports, globals = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, ...globals, require(name) { assert.ok(name in imports, 'Known import: ' + name); return imports[name] } })
  return module.exports
}

// Execute the actual provider with deterministic hooks/effects and deferred RPCs.
// No real account, browser storage, billing request, clock change or database write.
function providerFixture({ user = 'alice', now = Date.parse(startsAt) + 60_000 } = {}) {
  let currentUser = user, currentNow = now, index = 0, dirty = false, last
  const cells = [], effects = [], loads = [], pickups = [], notifications = [], billing = [], timers = new Map()
  let timerSequence = 0
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const hooks = {
    createContext: () => ({ Provider: 'provider' }), useContext: () => { throw Error('Unused consumer in provider fixture') },
    useState(initial) { const i = index++; if (!cells[i]) cells[i] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, update => { const value = typeof update === 'function' ? update(cells[i].value) : update; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; if (!cells[i]) cells[i] = { current: initial }; return cells[i] },
    useMemo(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: callback(), deps }; return cells[i].value },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps) },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const previous = cells[i]; cells[i] = { deps, callback, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  class Clock extends Date { static now() { return currentNow } }
  const window = { addEventListener() {}, removeEventListener() {}, setInterval() { return 1 }, clearInterval() {} }
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  const api = load(providerSource, {
    react: hooks, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    './AuthContext': { useAuth: () => ({ authUser: currentUser ? { id: currentUser } : null, isLoading: false, isPasswordRecovery: false }) },
    './BillingContext': { useBilling: () => ({ refreshBilling: async () => { billing.push(currentUser) } }) },
    './ToastContext': { useToast: () => ({ notify: input => notifications.push(input) }) },
    '../lib/halloweenHunt': { HALLOWEEN_STARTS_AT: startsAt, HALLOWEEN_ENDS_AT: endsAt,
      loadMyHalloweenHunt: signal => { const request = { user: currentUser, signal, ...deferred() }; loads.push(request); return request.promise },
      collectHalloweenPumpkin: (id, signal) => { const request = { user: currentUser, id, signal, ...deferred() }; pickups.push(request); return request.promise },
    },
  }, { window, document, Date: Clock, AbortController,
    setTimeout(callback, delay) { const id = ++timerSequence; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  function render() {
    for (let turn = 0; turn < 30; turn++) {
      dirty = false; index = 0; last = api.HalloweenHuntProvider({ children: null })
      effects.splice(0).forEach(effect => effect())
      if (!dirty) return last.props.value
    }
    throw Error('Provider rendered too often')
  }
  const flush = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); return render() }
  render()
  return { loads, pickups, notifications, billing, render, flush,
    get value() { return last.props.value },
    switchUser(next) { currentUser = next; return render() },
    setClock(next) { currentNow = next },
    fireDeadlines() { for (const [id, timer] of timers) if (timer.delay === 12000) { timers.delete(id); timer.callback() } },
    strictReplay() { cells.forEach(cell => cell?.cleanup?.()); cells.forEach(cell => { if (cell?.callback) cell.cleanup = cell.callback() }); return render() },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

test('late progress from a previous account cannot become the current account snapshot', async () => {
  const fx = providerFixture(); assert.equal(fx.loads.length, 1)
  fx.switchUser('bob'); fx.loads[0].resolve(phaseState(['home']))
  await fx.flush(); assert.equal(fx.value.userId, 'bob'); assert.equal(fx.value.state, null)
  fx.unmount()
})

test('StrictMode cleanup and effect re-setup starts a fresh initial request without a polling delay', async () => {
  const fx = providerFixture(); assert.equal(fx.loads.length, 1)
  fx.strictReplay(); assert.equal(fx.loads[0].signal.aborted, true)
  assert.equal(fx.loads.length, 2, 'Effect replay must not inherit the aborted initial loading lock')
  fx.loads[1].resolve(phaseState(['home'])); await fx.flush()
  fx.loads[0].reject(new Error('Initial request aborted')); await fx.flush()
  assert.deepEqual([...fx.value.state.collected], ['home']); assert.equal(fx.value.loading, false); assert.equal(fx.value.error, '')
  fx.unmount()
})

test('switching accounts during a request refreshes the new owner without waiting for the next polling minute', async () => {
  const fx = providerFixture(); fx.switchUser('bob'); fx.loads[0].resolve(phaseState(['home']))
  await fx.flush()
  const own = fx.loads.find(request => request.user === 'bob')
  assert.ok(own, 'New owner receives an immediate or queued refresh after the prior request settles')
  own.resolve(phaseState(['news'])); await fx.flush()
  assert.deepEqual([...fx.value.state.collected], ['news']); assert.equal(fx.value.loading, false)
  fx.unmount()
})

test('double click is serialized; only server-confirmed new completion celebrates or refreshes billing', async () => {
  const fx = providerFixture(); fx.loads[0].resolve(phaseState(ids.slice(0, 9))); await fx.flush()
  assert.equal(fx.value.available, true, 'Campaign active on synthetic server-aligned clock')
  assert.equal(fx.value.state?.collected.length, 9, 'Actual provider publishes confirmed snapshot')
  const first = fx.value.collect('profile'), second = fx.value.collect('profile')
  assert.equal(fx.pickups.length, 1); assert.equal(fx.notifications.length, 0); assert.equal(fx.value.celebration, null)
  fx.pickups[0].resolve({ ...phaseState(ids, { subscriptionWon: true }), newlyCollected: true, newlyCompleted: true })
  await Promise.all([first, second]); await fx.flush()
  assert.equal(fx.notifications.length, 1); assert.equal(fx.billing.length, 1); assert.equal(fx.value.celebration.completed, true)
  await fx.value.collect('profile'); assert.equal(fx.pickups.length, 1); assert.equal(fx.notifications.length, 1)
  fx.unmount()
})

test('replayed pickup and late owner completion cannot emit a second prize or another account greeting', async () => {
  const fx = providerFixture(); fx.loads[0].resolve(phaseState(ids.slice(0, 9))); await fx.flush()
  const request = fx.value.collect('profile')
  fx.switchUser('bob')
  fx.pickups[0].resolve({ ...phaseState(ids, { subscriptionWon: true }), newlyCollected: true, newlyCompleted: true })
  await request; await fx.flush()
  assert.equal(fx.notifications.length, 0); assert.equal(fx.billing.length, 0); assert.equal(fx.value.celebration, null)
  fx.unmount()
  const replay = providerFixture(); replay.loads[0].resolve(phaseState(ids.slice(0, 9))); await replay.flush()
  const duplicate = replay.value.collect('profile')
  replay.pickups[0].resolve({ ...phaseState(ids, { subscriptionWon: true }), newlyCollected: false, newlyCompleted: false })
  await duplicate; await replay.flush()
  assert.equal(replay.notifications.length, 0); assert.equal(replay.billing.length, 0); assert.equal(replay.value.celebration, null)
  replay.unmount()
})

test('failed collection keeps the old progress and never grants or celebrates locally', async () => {
  const fx = providerFixture(); fx.loads[0].resolve(phaseState(['home'])); await fx.flush()
  const request = fx.value.collect('news'); fx.pickups[0].reject(new Error('offline')); await request; await fx.flush()
  assert.deepEqual([...fx.value.state.collected], ['home']); assert.equal(fx.value.celebration, null); assert.equal(fx.billing.length, 0)
  assert.equal(fx.notifications.length, 1); assert.equal(fx.notifications[0].tone, 'warning'); fx.unmount()
})

test('an obsolete same-account request cannot clear a newer pickup spinner after switching away and back', async () => {
  const fx = providerFixture(); fx.loads[0].resolve(phaseState(ids.slice(0, 9))); await fx.flush()
  const old = fx.value.collect('profile')
  fx.switchUser('bob'); fx.loads.filter(request => request.user === 'bob').at(-1).resolve(phaseState()); await fx.flush()
  const middle = fx.value.collect('home')
  fx.switchUser('alice')
  fx.loads.filter(request => request.user === 'alice').at(-1).resolve(phaseState(ids.slice(0, 9))); await fx.flush()
  const current = fx.value.collect('profile'); fx.render(); assert.equal(fx.pickups.length, 3)
  fx.pickups[0].resolve({ ...phaseState(ids), newlyCollected: true, newlyCompleted: true }); await old; await fx.flush()
  assert.equal(fx.value.collecting, 'profile', 'The newer claim retains its loading feedback')
  fx.pickups[2].resolve({ ...phaseState(ids), newlyCollected: false, newlyCompleted: false }); await current; await fx.flush()
  fx.pickups[1].reject(new Error('Request aborted')); await middle
  assert.equal(fx.value.collecting, null); fx.unmount()
})

test('unmounted provider ignores late writes and prize side effects', async () => {
  const fx = providerFixture(); fx.loads[0].resolve(phaseState(ids.slice(0, 9))); await fx.flush()
  const request = fx.value.collect('profile'); fx.unmount()
  fx.pickups[0].resolve({ ...phaseState(ids, { subscriptionWon: true }), newlyCollected: true, newlyCompleted: true })
  await request; assert.equal(fx.notifications.length, 0); assert.equal(fx.billing.length, 0)
})

test('requests receive abort signals, end on owner changes or unmount, and have a finite deadline', async () => {
  const fx = providerFixture(); assert.equal(fx.loads[0].signal.aborted, false)
  fx.switchUser('bob'); assert.equal(fx.loads[0].signal.aborted, true)
  const own = fx.loads.find(request => request.user === 'bob'); assert.equal(own.signal.aborted, false)
  fx.fireDeadlines(); assert.equal(own.signal.aborted, true)
  own.reject(new Error('Request aborted')); await fx.flush(); assert.equal(fx.value.loading, false); assert.ok(fx.value.error)
  fx.unmount()
  const second = providerFixture(); second.loads[0].resolve(phaseState()); await second.flush()
  const claim = second.value.collect('home'); second.unmount(); assert.equal(second.pickups[0].signal.aborted, true)
  second.pickups[0].reject(new Error('Request aborted')); await claim; assert.equal(second.notifications.length, 0)
})

test('ended campaign can still read permanent earned results but cannot collect', async () => {
  const fx = providerFixture({ now: Date.parse(endsAt) + 60_000 })
  const request = fx.value.refresh(); const own = fx.loads.find(request => request.user === 'alice')
  assert.ok(own, 'Own result remains readable after the event finishes')
  own.resolve(phaseState(ids, { phase: 'ended', serverNow: new Date(Date.parse(endsAt) + 60_000).toISOString() })); await request; await fx.flush()
  assert.equal(fx.value.state.completed, true); assert.equal(fx.value.available, false)
  await fx.value.collect('home'); assert.equal(fx.pickups.length, 0); fx.unmount()
})

test('a guest or early browser clock cannot collect or celebrate before launch', async () => {
  const guest = providerFixture({ user: null })
  assert.equal(guest.loads.length, 0); await guest.value.collect('home'); assert.equal(guest.pickups.length, 0); guest.unmount()
  const early = providerFixture({ now: Date.parse(startsAt) - 1 })
  assert.equal(early.value.available, false); assert.equal(early.loads.length, 0)
  const request = early.value.refresh(); early.loads[0].resolve(phaseState()); await request; await early.flush()
  await early.value.collect('home'); assert.equal(early.pickups.length, 0); assert.equal(early.notifications.length, 0); early.unmount()
})

let currentHunt, suspended = false, uiTheme = 'light'
const welcomeStorage = new Map()
const icon = () => React.createElement('svg', { 'aria-hidden': true })
const commonImports = { react: React, 'react/jsx-runtime': jsx, 'lucide-react': new Proxy({}, { get: () => icon }),
  '../../context/HalloweenHuntContext': { useHalloweenHunt: () => currentHunt },
  '../../context/OnboardingContext': { useOnboarding: () => ({ suspended }) },
}
const pumpkin = load(pumpkinSource, { ...commonImports, '../../assets/halloween/pumpkin-witch-20261017.webp': { default: '/pumpkin.webp' }, './halloween.css': {} })
const experience = load(experienceSource, { ...commonImports,
  '@tanstack/react-router': { Link: ({ to, children, ...props }) => React.createElement('a', { href: to, ...props }, children) },
  '../../context/ThemeContext': { useTheme: () => ({ theme: uiTheme, setTheme() {} }) },
  '../../lib/halloweenHunt': { PUMPKIN_IDS: ids }, './HalloweenPumpkin': pumpkin,
  '../ThemeToggle': { ThemeToggle: ({ textLabel }) => React.createElement('button', { type: 'button', 'aria-haspopup': 'menu' }, textLabel) },
}, { localStorage: { getItem: key => welcomeStorage.get(key) ?? null, setItem: (key, value) => welcomeStorage.set(key, value) } })
const view = (Component, props = {}) => renderToStaticMarkup(React.createElement(Component, props))
const resetHunt = overrides => { suspended = false; currentHunt = { userId: 'alice', available: true, state: phaseState(), loading: false, error: '', collecting: null, celebration: null, refresh: async () => {}, collect: async () => {}, clearCelebration() {}, ...overrides } }

test('actual pickup is a labelled native button and hidden before launch, after collection, or during onboarding', () => {
  resetHunt(); const html = view(pumpkin.HalloweenPumpkin, { pumpkinId: 'home' })
  assert.match(html, /type="button"/); assert.match(html, /aria-label="Знайшли гарбузик! Зібрати"/); assert.match(html, /data-pumpkin-id="home"/)
  for (const overrides of [{ available: false }, { userId: undefined }, { state: null }, { state: phaseState([], { phase: 'upcoming' }) }, { state: phaseState(['home']) }, { state: phaseState([], { eligible: false, ineligibleReason: 'email_unconfirmed' }) }]) { resetHunt(overrides); assert.equal(view(pumpkin.HalloweenPumpkin, { pumpkinId: 'home' }), '') }
  resetHunt(); suspended = true; assert.equal(view(pumpkin.HalloweenPumpkin, { pumpkinId: 'home' }), '')
})

test('actual intro, tracker and congratulations never render a full-screen modal', () => {
  resetHunt({ celebration: { key: 1, count: 10, completed: true, subscriptionWon: false } })
  const html = view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} })
  assert.match(html, /<aside/); assert.match(html, /Додали ще 5 подарункових місяців/); assert.match(html, /role="status"/); assert.match(html, /aria-live="polite"/)
  assert.doesNotMatch(html, /aria-modal="true"|inset-0|<dialog/)
  for (const pathname of ['/admin', '/auth/callback', '/reset-password']) assert.equal(view(experience.HalloweenExperience, { pathname, onAuthRequest() {} }), '')
  resetHunt({ available: false }); assert.equal(view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} }), '')
})

test('actual welcome greets the community and exposes the normal theme selector without claiming an inactive palette is enabled', () => {
  resetHunt(); welcomeStorage.clear(); uiTheme = 'halloween'
  const seasonal = view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} })
  assert.match(seasonal, /З Гелловіном, спільното Xelay!/); assert.match(seasonal, /Увімкнули затишну тему/)
  assert.match(seasonal, /Змінити тему/); assert.match(seasonal, /Світлу або темну тему можна повернути будь-коли/)
  assert.match(seasonal, /Знайти гарбузики/); assert.match(seasonal, /href="\/halloween"/)
  assert.equal((seasonal.match(/class="halloween-intro"/g) || []).length, 1, 'One compact inline greeting')
  assert.doesNotMatch(seasonal, /aria-modal="true"|<dialog|fixed inset/)
  uiTheme = 'light'
  const normal = view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} })
  assert.match(normal, /Підготували затишну тему/); assert.doesNotMatch(normal, /Увімкнули затишну тему/)
  resetHunt({ available: false }); assert.equal(view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} }), '')
})

test('welcome dismissal is campaign and owner scoped; old preview dismissals do not consume the new greeting', () => {
  resetHunt(); welcomeStorage.clear()
  welcomeStorage.set('xelay:halloween-2026:intro:alice', 'dismissed')
  assert.match(view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} }), /З Гелловіном/)
  welcomeStorage.set('xelay:halloween-2026:welcome:alice', 'dismissed')
  assert.doesNotMatch(view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} }), /class="halloween-intro"/)
  currentHunt.userId = 'bob'; assert.match(view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} }), /З Гелловіном/)
  currentHunt.userId = undefined; assert.match(view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} }), /З Гелловіном/)
  welcomeStorage.set('xelay:halloween-2026:welcome:guest', 'dismissed')
  assert.doesNotMatch(view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} }), /class="halloween-intro"/)
  welcomeStorage.clear(); resetHunt()
  assert.equal(view(experience.HalloweenExperience, { pathname: '/', blocked: true, onAuthRequest() {} }), '')
  suspended = true; assert.equal(view(experience.HalloweenExperience, { pathname: '/', onAuthRequest() {} }), '')
})

test('mobile welcome keeps its layout in page flow and leaves messages free from a floating tracker', async () => {
  const css = await read('src/components/halloween/halloween.css')
  const intro = css.match(/\.halloween-intro\s*\{([^}]+)\}/)?.[1]
  assert.ok(intro); assert.match(intro, /position:relative/); assert.doesNotMatch(intro, /position:fixed|height:\s*100(?:d?vh|%)/)
  const overflow = [...css.matchAll(/\.halloween-intro\s*\{([^}]+)\}/g)].flatMap(([, declarations]) => [...declarations.matchAll(/(?:^|;)\s*overflow\s*:\s*([^;}]+)/g)].map(([, value]) => value.trim()))
  assert.equal(overflow.at(-1), 'clip', 'The decorative star must not create an internal scroll range when theme controls receive focus')
  assert.match(css, /@media\(max-width:639px\)/); assert.match(css, /\.halloween-intro-copy h2\{font-size:15px/)
  resetHunt(); welcomeStorage.clear()
  const inbox = view(experience.HalloweenExperience, { pathname: '/messages', onAuthRequest() {} })
  assert.doesNotMatch(inbox, /halloween-intro|halloween-chip|halloween-progress-panel/)
  assert.match(experienceSource, /if \(!visible \|\| !showTracker\)/)
})

test('new prizes are for new completions, while previous finishers keep their badge without a false exhaustion message', async () => {
  const page = load(await read('src/pages/HalloweenPage.tsx'), {
    react: React, 'react/jsx-runtime': jsx, 'lucide-react': new Proxy({}, { get: () => icon }),
    '@tanstack/react-router': { Link: ({ to, children, ...props }) => React.createElement('a', { href: to, ...props }, children) },
    '../context/HalloweenHuntContext': { useHalloweenHunt: () => currentHunt },
    '../context/ThemeContext': { useTheme: () => ({ theme: 'light', setTheme() {}, halloweenAvailable: true }) },
    '../context/AuthContext': { useAuth: () => ({ isAuthenticated: true }) },
    '../components/AuthModal': { AuthModal: () => null },
    '../components/halloween/HalloweenPumpkin': pumpkin,
    '../components/halloween/HalloweenExperience': experience,
  }).HalloweenPage
  resetHunt({ state: phaseState(ids, { winnersRemaining: 5 }) })
  const previousFinisher = view(page)
  assert.match(previousFinisher, /Повторної нагороди за вже завершений збір немає/)
  assert.doesNotMatch(previousFinisher, /Усі призові місяці вже розібрали|серед перших 15/)
  resetHunt({ state: phaseState([], { winnersRemaining: 5 }) })
  const newFinisher = view(page)
  assert.match(newFinisher, /Додаткових призових місяців залишилося:/)
  assert.match(newFinisher, />5\/5</); assert.match(newFinisher, />0\/10</)
  resetHunt({ state: phaseState(ids, { winnersRemaining: 0 }) })
  assert.match(view(page), /Усі призові місяці вже розібрали/)
  resetHunt({ state: phaseState(ids, { winnersRemaining: 4, subscriptionWon: true }) })
  assert.match(view(page), /місяць «Учасника» додано до вашого акаунта/)
})

test('all ten route placements, including both current home variants, stay outside purchase forms, links and other buttons', async () => {
  const pages = { 'src/components/home/LiveHomeDashboard.tsx': 'home', 'src/pages/CommunityPage.tsx': 'home', 'src/pages/CategoriesPage.tsx': 'questions', 'src/pages/NewsPage.tsx': 'news', 'src/pages/StudyGroupsPage.tsx': 'groups', 'src/pages/UserSearchPage.tsx': 'people', 'src/pages/MessagesPage.tsx': 'messages', 'src/pages/TeamSupportPage.tsx': 'support', 'src/pages/OpportunitiesPage.tsx': 'opportunities', 'src/pages/SubscriptionPage.tsx': 'subscription', 'src/pages/ProfilePage.tsx': 'profile' }
  for (const [page, id] of Object.entries(pages)) {
    const source = await read(page), ast = ts.createSourceFile(page, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let count = 0
    const walk = node => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'HalloweenPumpkin') {
        const attr = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === 'pumpkinId')
        assert.equal(attr?.initializer?.text, id, page + ' canonical ID'); count++
        for (let parent = node.parent; parent; parent = parent.parent) if (ts.isJsxElement(parent)) assert.ok(!['form', 'button', 'a'].includes(parent.openingElement.tagName.getText(ast)), page + ' independent pickup')
      }
      ts.forEachChild(node, walk)
    }
    walk(ast); assert.equal(count, 1, page + ' placement coverage')
  }
})

test('permanent trophy display and settings are independent of premium or campaign dates', async () => {
  const [source, modal, own, publicProfile] = await Promise.all(['src/components/halloween/HalloweenBadge.tsx', 'src/components/ProfileSettingsModal.tsx', 'src/pages/ProfilePage.tsx', 'src/pages/PublicProfilePage.tsx'].map(read))
  assert.match(source, /loadHalloweenBadge\(userId\)/); assert.match(source, /saveMyHalloweenBadge\(visible, signal\)/)
  assert.doesNotMatch(source, /useBilling|isPremium|HALLOWEEN_(?:STARTS|ENDS)_AT|isHalloweenThemeAvailable/)
  assert.match(source, /current\.current === owner/); assert.match(source, /request === version/)
  assert.match(modal, /<HalloweenBadgeSettings/); assert.match(own, /<HalloweenBadge userId=\{authUser\?\.id\}/); assert.match(publicProfile, /<HalloweenBadge userId=\{id\}/)
  const lib = await read('src/lib/halloweenHunt.ts')
  assert.match(lib, /rpc\('xelay_halloween_badge', \{ p_user_id: userId \}\)/)
  assert.doesNotMatch(lib.slice(lib.indexOf('export async function loadHalloweenBadge')), /participant_entitlements|billing_orders|support_payments|collected_at/)
})
