import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import postcss from 'postcss'

const root = new URL('../../', import.meta.url)
const read = name => readFile(new URL(name, root), 'utf8')
const modelModule = { exports: {} }
vm.runInNewContext(ts.transpileModule(await read('src/lib/winterCampaign.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: modelModule, exports: modelModule.exports })
const model = modelModule.exports

test('the platform winter palette keeps reading text and primary actions above 4.5:1 in both themes', async () => {
  const css = postcss.parse(await read('src/components/winter/winterPlatform.css'))
  const luminance = value => {
    const [h, s, l] = value.split(/\s+/).map(parseFloat)
    const a = s / 100 * Math.min(l / 100, 1 - l / 100)
    const channel = n => {
      const k = (n + h / 30) % 12
      const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
      return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
    }
    return .2126 * channel(0) + .7152 * channel(8) + .0722 * channel(4)
  }
  const palette = selector => Object.fromEntries(css.nodes.find(node => node.selector === selector).nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
  const light = palette(':root:has(.winter-decorations)'), dark = { ...light, ...palette(':root.dark:has(.winter-decorations)') }
  for (const [theme, colours] of [['light', light], ['dark', dark]]) {
    const pairs = ['foreground', 'muted-foreground', 'primary-text'].flatMap(foreground => ['background', 'card', 'muted'].map(background => [foreground, background]))
    pairs.push(['primary-foreground', 'primary'])
    for (const [foreground, background] of pairs) {
      const a = luminance(colours['--' + foreground]), b = luminance(colours['--' + background])
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      assert.ok(ratio >= 4.5, `${theme} ${foreground}/${background}: ${ratio.toFixed(2)}`)
    }
  }
})
const base = { campaignId: 'winter-2026', userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', serverNow: '2026-12-04T12:00:00.000Z', startsAt: model.WINTER_STARTS_AT, endsAt: model.WINTER_ADVENT_ENDS_AT, phase: 'active', currentDay: 4, eligible: true, ineligibleReason: null, claimedDays: [1, 2] }

test('winter launch, catch-up end and decoration end use exact Kyiv boundaries', () => {
  const start = Date.parse('2026-11-30T22:00:00Z'), end = Date.parse('2026-12-31T22:00:00Z'), decorationsEnd = Date.parse('2027-01-14T22:00:00Z')
  assert.equal(model.winterPhase(start - 1), 'upcoming'); assert.equal(model.winterDay(start - 1), 0)
  assert.equal(model.winterPhase(start), 'active'); assert.equal(model.winterDay(start), 1)
  assert.equal(model.winterDay(start + 86_400_000 - 1), 1); assert.equal(model.winterDay(start + 86_400_000), 2)
  assert.equal(model.winterDay(end - 1), 31); assert.equal(model.winterPhase(end), 'ended')
  assert.equal(model.winterDecorationsAvailable(end), true); assert.equal(model.winterDecorationsAvailable(decorationsEnd - 1), true)
  assert.equal(model.winterDecorationsAvailable(decorationsEnd), false)
  assert.equal(model.winterDecorationsAvailable(NaN), false); assert.equal(model.nextWinterBoundary(start - 1), start)
  assert.equal(model.nextWinterBoundary(start), end); assert.equal(model.nextWinterBoundary(end), decorationsEnd); assert.equal(model.nextWinterBoundary(decorationsEnd), null)
})

test('a personal calendar rejects future or duplicate claims and inconsistent server time', () => {
  assert.deepEqual([...model.parseWinterAdventState({ ...base, claimedDays: [4, 1, 3] }).claimedDays], [1, 3, 4])
  for (const value of [null, { ...base, currentDay: 5 }, { ...base, claimedDays: [1, 1] }, { ...base, claimedDays: [5] }, { ...base, claimedDays: [0] }, { ...base, claimedDays: [1.5] }, { ...base, userId: null }, { ...base, ineligibleReason: 'guest' }, { ...base, phase: 'ended' }, { ...base, serverNow: 'invalid' }, { ...base, startsAt: '2026-11-01' }]) assert.throws(() => model.parseWinterAdventState(value))
  assert.equal(model.parseWinterAdventState({ ...base, userId: null, eligible: false, ineligibleReason: 'guest', claimedDays: [] }).eligible, false)
  for (const value of [
    { ...base, eligible: false, ineligibleReason: 'account_unavailable' },
    { ...base, eligible: false, ineligibleReason: 'email_unconfirmed' },
    { ...base, eligible: false, ineligibleReason: 'guest', claimedDays: [] },
    { ...base, userId: null, eligible: false, ineligibleReason: 'account_unavailable', claimedDays: [] },
  ]) assert.throws(() => model.parseWinterAdventState(value))
  assert.throws(() => model.parseWinterAdventClaim({ ...base, newlyClaimed: true }, 4))
  assert.throws(() => model.parseWinterAdventClaim({ ...base, claimedDays: [1, 2, 4], newlyClaimed: 'yes' }, 4))
  assert.equal(model.parseWinterAdventClaim({ ...base, claimedDays: [1, 2, 4], newlyClaimed: false }, 4).newlyClaimed, false)
  assert.throws(() => model.parseWinterAdventClaim({ ...base, phase: 'ended', serverNow: '2026-12-31T22:00:00Z', currentDay: 31, newlyClaimed: false }, 1))
  for (const day of [0, 1.5, 5, 32, NaN]) assert.throws(() => model.parseWinterAdventClaim({ ...base, newlyClaimed: false }, day))
})

test('31 server-backed gift descriptions preserve the approved finite campaign budget', () => {
  assert.equal(model.WINTER_REWARDS.length, 31)
  assert.equal(new Set(model.WINTER_REWARDS.map(item => item.id)).size, 31)
  for (const [index, reward] of model.WINTER_REWARDS.entries()) {
    assert.equal(reward.day, index + 1)
    assert.ok(['credits', 'extension', 'upgrade', 'pause', 'subscription_coupon', 'friend_coupon', 'credit_bonus'].includes(reward.kind))
    assert.ok(reward.name && reward.description)
    assert.ok(Number.isInteger(reward.amount) && reward.amount > 0)
  }
  const total = kind => model.WINTER_REWARDS.filter(item => item.kind === kind).reduce((sum, item) => sum + item.amount, 0)
  assert.equal(total('credits'), 150); assert.equal(total('extension'), 7)
  assert.equal(total('upgrade'), 3); assert.equal(total('pause'), 7)
  assert.equal(Math.max(...model.WINTER_REWARDS.filter(item => item.kind === 'credit_bonus').map(item => item.maximum)), 300)
  assert.equal(Math.max(...model.WINTER_REWARDS.filter(item => item.kind === 'subscription_coupon').map(item => item.amount)), 25)
})

test('decorations stay outside administrative, business and authentication routes', () => {
  for (const path of ['/admin', '/admin/review', '/dean', '/dean/draft', '/business', '/business/document/file', '/auth/callback', '/reset-password']) assert.equal(model.winterRouteAllowed(path), false)
  for (const path of ['/', '/learning', '/groups', '/teaching', '/winter', '/subscription']) assert.equal(model.winterRouteAllowed(path), true)
})

const componentFiles = ['src/components/winter/WinterBenefitsPanel.tsx', 'src/components/winter/WinterGiftArt.tsx', 'src/components/winter/WinterAtmosphere.tsx', 'src/components/winter/WinterHolidayArt.tsx', 'src/components/winter/WinterCalendarView.tsx', 'src/components/winter/WinterScratchCard.tsx', 'src/components/winter/WinterArt.tsx', 'src/components/winter/WinterDecorations.tsx', 'src/components/XelayMini.tsx', 'src/lib/winterCampaign.ts']
const sources = Object.fromEntries(await Promise.all(componentFiles.map(async name => [name, await read(name)])))
const loaded = new Map(), requirePackage = createRequire(import.meta.url)
function component(name) {
  if (loaded.has(name)) return loaded.get(name).exports
  assert.ok(name in sources, `Known component: ${name}`)
  const module = { exports: {} }; loaded.set(name, module)
  vm.runInNewContext(ts.transpileModule(sources[name], { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, console, performance,
    require(imported) {
      if (imported.endsWith('.css')) return {}
      if (!imported.startsWith('.')) return requirePackage(imported)
      const source = path.posix.normalize(path.posix.join(path.posix.dirname(name), imported))
      return component(source + (source + '.tsx' in sources ? '.tsx' : '.ts'))
    },
  })
  return module.exports
}
const render = state => renderToStaticMarkup(React.createElement(component('src/components/winter/WinterCalendarView.tsx').WinterCalendarView, { state, onClaim: async () => {} }))

test('paid gift actions stay disabled while loading, paused or past the activation deadline', () => {
  const subscription = { planId: 'plus', effectivePlanId: 'plus', expiresAt: '2027-04-01T12:00:00Z', pausedUntil: '2027-03-10T12:00:00Z', upgradeUntil: null }
  const state = { campaignId: 'winter-2026', serverNow: '2026-12-15T12:00:00Z', eligible: true, activationEndsAt: '2027-02-28T22:00:00Z', promo: { collectedCredits: 50, purchaseBonusCredits: 0, availableCredits: 0, reservedCredits: 0, spentCredits: 0, activatedAt: null, activationEndsAt: '2027-01-31T22:00:00Z', usable: false }, subscriptions: { student: subscription, teacher: { ...subscription, planId: 'teacher_start', effectivePlanId: 'teacher_start' } }, benefits: [{ day: 2, kind: 'extension', amountDays: 1, status: 'available', audience: null, activeUntil: null, convertedToExtension: false }] }
  const offers = { campaign: 'winter-2026', expiresAt: '2027-02-28T22:00:00Z', subscriptionUsed: false, paused: { student: true, teacher: true }, monthly: { start: 10, plus: 10, max: 5 }, annualPercent: 0, friend: { percent: 10, acceptedPercent: 0 }, creditBonus: { percent: 0, capCredits: 0, used: false } }
  const benefits = props => renderToStaticMarkup(React.createElement(component('src/components/winter/WinterBenefitsPanel.tsx').WinterBenefitsPanel, { state, offers, onRefresh() {}, onAction() {}, onQuote() {}, onCheckout() {}, onIssueFriend() {}, onAcceptFriend() {}, ...props }))
  const paused = benefits({})
  assert.match(paused, /<button[^>]*disabled=""[^>]*>[^]*?Активувати кредити/)
  assert.match(paused, /Подарунок зачекає на відповідну оплачену підписку/)
  assert.match(paused, /Відновити зараз/)
  const pending = benefits({ pending: true })
  assert.ok([...pending.matchAll(/<button[^>]*>/g)].every(match => match[0].includes('disabled=""')))
  const expired = benefits({ state: { ...state, serverNow: '2027-03-01T12:00:00Z' } })
  assert.match(expired, /Строк зимових пропозицій завершився/)
  assert.doesNotMatch(expired, /Обери підписку і перевір остаточну суму|До оплати/)
  const pendingOrder = { audience: 'student', planId: 'plus', termMonths: 1, source: 'own', orderReference: 'fixture', status: 'pending', expiresAt: '2026-12-16T12:00:00Z', amount: 359.1, listAmount: 399, discountPercent: 10, currency: 'UAH' }
  const reserved = benefits({ offers: { ...offers, pendingOrder } })
  assert.match(reserved, /Продовжити оплату/); assert.match(reserved, /359,1 грн/)
  assert.match(reserved, /Перевірити оплату/)
  assert.doesNotMatch(reserved, /Обери підписку і перевір остаточну суму|Зимову знижку на підписку вже використано/)
  const expiredOrder = benefits({ offers: { ...offers, pendingOrder: { ...pendingOrder, expiresAt: '2026-12-14T12:00:00Z' } } })
  assert.doesNotMatch(expiredOrder, /Продовжити оплату|Обери підписку і перевір остаточну суму/)
  assert.match(expiredOrder, /Перевірити оплату/)
})

test('scratch strokes clamp captured pointers and cap work even after an extreme drag', () => {
  const { boundedWinterScratchStroke: stroke, WINTER_SCRATCH_MAX_STEPS: limit } = component('src/components/winter/WinterScratchCard.tsx')
  const long = stroke(320, 210, { x: 1e100, y: -1e100 }, { x: -1e100, y: 1e100 })
  assert.equal(long.from.x, 0); assert.equal(long.from.y, 210)
  assert.equal(long.to.x, 320); assert.equal(long.to.y, 0)
  assert.equal(limit, 32); assert.equal(long.steps, limit)
  const repeated = stroke(320, 210, { x: 1e100, y: -1e100 }, long.to)
  assert.equal(repeated.steps, 1)
  assert.equal(stroke(320, 210, { x: 10, y: 10 }, null).steps, 1)
  assert.equal(stroke(320, 210, { x: Infinity, y: 10 }, null), null)
  assert.equal(stroke(0, 210, { x: 10, y: 10 }, null), null)
  assert.equal(stroke(320, 210, { x: 10, y: 10 }, { x: NaN, y: 0 }), null)
  // The coverage pass visits a fixed 20×12 grid per step: at most 7,920
  // distance checks per event, regardless of how far the pointer leaves it.
  assert.ok((long.steps + 1) * 20 * 12 <= 7_920)
})

test('calendar renders every day, keyboard gift action and honest saved collection', () => {
  const html = render(base)
  assert.equal((html.match(/<button[^>]+class="wg-day(?: |")/g) || []).length, 31)
  assert.match(html, /Відкрити подарунок/)
  assert.match(html, /2 із 31 подарунка/)
  assert.match(html, /Пропущені дні можна відкрити до кінця грудня/)
  assert.doesNotMatch(html, /href="[^\"]*(?:checkout|billing)/)
  assert.match(html, /Кредити потрібно активувати до 31 січня 2027 року з оплаченою підпискою з ШІ/)
  assert.match(html, /id="winter-benefits"/)
})

test('upcoming, ended and guest calendars cannot render an enabled claim action', () => {
  const fixtures = [
    { ...base, userId: null, eligible: false, ineligibleReason: 'guest', claimedDays: [] },
    { ...base, phase: 'upcoming', serverNow: '2026-11-26T12:00:00Z', currentDay: 0, claimedDays: [] },
    { ...base, phase: 'ended', serverNow: '2027-01-01T12:00:00Z', currentDay: 31, claimedDays: [] },
  ]
  for (const state of fixtures) assert.match(render(state), /<button[^>]*class="winter-primary-button"[^>]*disabled=""[^>]*>/)
})

test('winter text meets 4.5:1 on light and dark reading surfaces', async () => {
  const css = postcss.parse(await read('src/components/winter/winter.css'))
  const luminance = hex => {
    const rgb = hex.replace('#', '').match(/../g).map(value => parseInt(value, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
  }
  for (const selector of ['.winter-page', '.dark .winter-page']) {
    const rule = css.nodes.find(node => node.selector === selector)
    const palette = Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
    for (const foreground of ['ink', 'muted', 'accent', 'green', 'gold']) for (const background of ['paper', 'card', 'wash']) {
      const a = luminance(palette[`--winter-${foreground}`]), b = luminance(palette[`--winter-${background}`]), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      assert.ok(ratio >= 4.5, `${selector} ${foreground}/${background}: ${ratio.toFixed(2)}`)
    }
  }
})

const pageSource = ts.transpileModule(await read('src/pages/WinterPage.tsx'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
function pageHarness() {
  let cursor = 0, dirty = false, tree, mounted = true, nextTimer = 0
  const slots = [], effects = [], timers = new Map(), requests = []
  const auth = { authUser: { id: base.userId }, isLoading: false, isPasswordRecovery: false }
  const changed = (a, b) => !a || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]))
  const hooks = {
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useState(initial) { const index = cursor++; const slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slot.value, next => { const value = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; dirty = true } }] },
    useCallback(fn, deps) { const index = cursor++; if (changed(slots[index]?.deps, deps)) slots[index] = { deps, fn }; return slots[index].fn },
    useEffect(fn, deps) { const index = cursor++; if (changed(slots[index]?.deps, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: fn() } }) },
  }
  const events = () => {
    const listeners = new Map()
    return { hidden: false, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) }, removeEventListener(name, fn) { listeners.get(name)?.delete(fn) }, emit(name) { for (const fn of [...listeners.get(name) || []]) fn() } }
  }
  const window = events(), document = events(), module = { exports: {} }
  vm.runInNewContext(pageSource, {
    module, exports: module.exports, AbortController, window, document, performance: { now: () => 0 },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id }, clearTimeout(id) { timers.delete(id) },
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, reject, reply(data) { resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => data }) } })) },
    require(imported) {
      if (imported === 'react') return hooks
      if (imported === 'react/jsx-runtime') return { Fragment: 'fragment', jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      if (imported.endsWith('/AuthContext')) return { useAuth: () => auth }
      if (imported.endsWith('/AuthModal')) return { AuthModal: 'auth-modal' }
      if (imported.endsWith('/supabase')) return { supabase: { auth: { getSession: async () => ({ data: { session: auth.authUser ? { user: auth.authUser, access_token: 'fixture-token' } : null } }) } } }
      if (imported.endsWith('/winterCampaign')) return model
      if (imported.endsWith('/WinterCalendarView')) return { WinterCalendarView: 'calendar' }
      if (imported.endsWith('/WinterBenefitsPanel')) return { WinterBenefitsPanel: 'benefits' }
      if (imported.endsWith('/useWinterBenefits')) return { useWinterBenefits: () => ({ pending: false, onRefresh() {} }) }
      throw new Error(`Unexpected import ${imported}`)
    },
  })
  const render = () => { cursor = 0; dirty = false; tree = module.exports.WinterPage(); while (effects.length) effects.shift()() }
  const settle = async () => { for (let n = 0; n < 40; n++) { await Promise.resolve(); if (dirty && mounted) render() } }
  const props = () => tree.props.children.find(child => child?.type === 'calendar').props
  const boundary = () => {
    const timer = [...timers].find(([, value]) => value.delay === 1_100)
    assert.ok(timer, 'one midnight refresh is scheduled from server time')
    timers.delete(timer[0]); timer[1].fn()
  }
  render()
  return { requests, auth, window, props, settle, boundary, rerender: render, unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.() } }
}
const beforeMidnight = { ...base, serverNow: '2026-12-01T21:59:59.000Z', currentDay: 1, claimedDays: [] }

test('midnight refresh waits for an active claim and retries once even when both requests fail', async () => {
  const h = pageHarness(); await h.settle()
  h.requests[0].reply(beforeMidnight); await h.settle()
  const claim = h.props().onClaim(1).catch(() => {}); await h.settle()
  assert.equal(h.requests[1].options.method, 'POST')
  h.boundary(); h.window.emit('online'); h.window.emit('online'); await h.settle()
  assert.equal(h.requests.length, 2, 'queued events do not interrupt the claim')
  h.requests[1].reject(new Error('offline')); await h.settle(); await claim
  assert.equal(h.requests.length, 3, 'one deferred refresh survives the failed claim')
  assert.equal(h.requests[2].options.method, 'GET')
  h.requests[2].reject(new Error('still offline')); await h.settle()
  assert.equal(h.requests.length, 3, 'a failed refresh does not schedule an error loop')
  assert.equal(h.props().loading, false)
  h.window.emit('online'); await h.settle()
  assert.equal(h.requests.length, 4, 'a later external reconnect can retry normally')
  h.requests[3].reply({ ...base, serverNow: '2026-12-01T22:00:01Z', currentDay: 2, claimedDays: [1] }); await h.settle()
  assert.equal(h.props().state.currentDay, 2)
  assert.deepEqual([...h.props().state.claimedDays], [1])
  h.unmount()
})

test('changing accounts cancels a queued refresh and never restores the previous collection', async () => {
  const h = pageHarness(); await h.settle()
  h.requests[0].reply(beforeMidnight); await h.settle()
  const claim = h.props().onClaim(1).catch(() => {}); await h.settle(); h.boundary()
  h.auth.authUser = null; h.rerender(); await h.settle()
  assert.equal(h.props().state, null)
  assert.equal(h.requests.length, 3)
  h.requests[2].reply({ ...beforeMidnight, userId: null, eligible: false, ineligibleReason: 'guest' }); await h.settle()
  h.requests[1].reply({ ...beforeMidnight, claimedDays: [1], newlyClaimed: true }); await h.settle(); await claim
  assert.equal(h.requests.length, 3, 'the old owner cannot trigger another deferred request')
  assert.equal(h.props().state.userId, null)
  assert.equal(h.props().state.claimedDays.length, 0)
  h.unmount()
})
