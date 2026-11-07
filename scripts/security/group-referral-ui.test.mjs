import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const project = fileURLToPath(new URL('../../', import.meta.url)), nativeRequire = createRequire(import.meta.url)
const fixedNow = Date.parse('2026-11-07T10:00:00Z')
function harness(initialStates = []) {
  let stateIndex = 0, uuid = 0
  const states = [], cache = new Map()
  const fakeReact = { ...React, useEffect() {}, useRef: value => ({ current: value }), useId: () => 'synthetic-dialog', useState(value) {
    const i = stateIndex++, initial = i < initialStates.length ? initialStates[i] : typeof value === 'function' ? value() : value
    states[i] = initial
    return [initial, next => { states[i] = typeof next === 'function' ? next(states[i]) : next }]
  } }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const source = readFileSync(file, 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    vm.runInNewContext(code, { module, exports: module.exports, Intl, Date, URL, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, require(id) {
      if (id === 'react') return fakeReact
      if (id.endsWith('.css')) return {}
      if (!id.startsWith('.')) return nativeRequire(id)
      const target = resolve(dirname(file), id)
      const path = [target, target + '.ts', target + '.tsx'].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
      if (!path) throw new Error(`Missing fixture dependency: ${id}`)
      return load(path)
    } }, { filename: file })
    return module.exports
  }
  return { load: file => load(resolve(project, file)), states }
}
const baseCampaign = { id: 'synthetic-campaign', slug: 'synthetic', title: 'Синтетична акція', state: 'open', version: 1, startsAt: '2026-11-01T10:00:00Z', joinsUntil: '2026-11-20T10:00:00Z', qualifiesUntil: '2026-11-25T10:00:00Z', drawAt: '2026-11-26T10:00:00Z', minimumStudents: 10, prizes: [{ rank: 1, label: 'ChatGPT Plus', months: 1 }, { rank: 2, label: 'Telegram Premium', months: 6 }, { rank: 3, label: 'Telegram Premium', months: 3 }], rulesVersion: 'synthetic' }
const actor = { id: 'synthetic-organizer', alias: 'Синтетичний організатор', verified: true, canAdmin: false }
const workspace = (patch = {}) => ({ campaign: baseCampaign, actor, ownLink: null, ownGroups: [], candidateGroups: [], ownTickets: 0, winners: [], ...patch })
const seed = value => [value, false, null, '', value.actor?.alias || '', true, 'SYNTHETIC', '', '', null, fixedNow]
const noRepository = { load: async () => { throw new Error('Unexpected load during SSR') }, action: async () => { throw new Error('Unexpected action during SSR') } }
const noop = () => {}
function renderCampaign(value) { const api = harness(seed(value)); const { GroupReferralCampaign } = api.load('src/components/referrals/GroupReferralCampaign.tsx'); return renderToStaticMarkup(React.createElement(GroupReferralCampaign, { repository: noRepository, now: () => fixedNow, onAuthRequest: noop })) }

test('public draft describes three prizes and never presents an unconfigured campaign as active', () => {
  const html = renderCampaign(workspace({ campaign: null, actor: null }))
  assert.match(html, /Акція ще не почалася/)
  assert.match(html, /ChatGPT Plus/)
  assert.match(html, /1 місяць/)
  assert.match(html, /Три призові місця/)
  assert.match(html, /Кількість груп не обмежена/)
  assert.match(html, /Увійти до Xelay/)
  assert.doesNotMatch(html, /id="gr-admin-title"|Створити запрошення/)
})

test('ticket count is not capped and a member sees real group progress without submission controls', () => {
  const html = renderCampaign(workspace({ ownTickets: 17, ownGroups: [{ id: 'entry', groupId: 'group', groupName: 'Синтетична група', organizerId: actor.id, organizerAlias: actor.alias, state: 'collecting', version: 1, verifiedStudents: 12, returningStudents: 9, hasSchedule: true, hasResource: true, eligible: false, issues: ['Потрібне ще одне повторне відвідування.'], viewerRole: 'member', canSubmit: false, registeredAt: baseCampaign.startsAt, createdAt: baseCampaign.startsAt }] }))
  assert.match(html, /<strong>17<\/strong>/)
  assert.match(html, /12 \/ 10/)
  assert.match(html, /9 \/ 10/)
  assert.match(html, /Потрібне ще одне повторне відвідування/)
  assert.doesNotMatch(html, /Подати групу на перевірку/)
  assert.match(html, /href="\/groups\?referral=SYNTHETIC"/)
})

test('administrator controls require both the actor permission and an admin workspace', () => {
  for (const value of [workspace(), workspace({ actor: { ...actor, canAdmin: true } }), workspace({ admin: { groups: [], audit: [], approvedTickets: 0, eligibleOrganizers: 0 } })]) assert.doesNotMatch(renderCampaign(value), /id="gr-admin-title"/)
  assert.match(renderCampaign(workspace({ actor: { ...actor, canAdmin: true }, admin: { groups: [], audit: [], approvedTickets: 0, eligibleOrganizers: 0 } })), /id="gr-admin-title"/)
})

test('private draw results are absent from public output until publication and public winners need no private statuses', () => {
  const winners = [{ id: 'winner', rank: 1, alias: '<img src=x onerror=alert(1)>', prize: baseCampaign.prizes[0], version: 1, isOwn: false }]
  assert.doesNotMatch(renderCampaign(workspace({ campaign: { ...baseCampaign, state: 'drawn' }, winners })), /Вітаємо переможців|gr-winner-own/)
  const html = renderCampaign(workspace({ campaign: { ...baseCampaign, state: 'published' }, winners }))
  assert.match(html, /Вітаємо переможців/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img src=x|undefined|Відмовитися від інтерв’ю|Ваш приз/)
})

test('stage guards reject early freeze/draw and incomplete draft activation in rendered controls', () => {
  const admin = { groups: [], audit: [], approvedTickets: 6, eligibleOrganizers: 2 }
  const html = renderCampaign(workspace({ actor: { ...actor, canAdmin: true }, admin }))
  assert.match(html, /<button[^>]*disabled=""[^>]*>Зафіксувати список<\/button>/)
  assert.match(html, /<button[^>]*disabled=""[^>]*>Провести розіграш/)
  const draft = renderCampaign(workspace({ actor: { ...actor, canAdmin: true }, campaign: { ...baseCampaign, state: 'draft', prizes: [{ ...baseCampaign.prizes[0], months: null }, ...baseCampaign.prizes.slice(1)] }, admin }))
  assert.match(draft, /<button[^>]*disabled=""[^>]*>Відкрити акцію/)
})

function descendants(node, result = []) { if (!node || typeof node !== 'object') return result; if (node.type === 'form') result.push(node); const children = node.props?.children; for (const child of Array.isArray(children) ? children : [children]) { if (Array.isArray(child)) for (const nested of child) descendants(nested, result); else descendants(child, result) } return result }
const tick = () => new Promise(resolve => setImmediate(resolve))
test('failed retries retain the same requestId, successful actions clear it and errors preserve input state', async () => {
  const value = workspace(), api = harness(seed(value)), calls = []
  let attempt = 0
  const repository = { load: noRepository.load, async action(action, payload) { calls.push({ action, payload }); if (++attempt === 1) throw new Error('REFERRAL_SOURCE_UNAVAILABLE'); return value } }
  const { GroupReferralCampaign } = api.load('src/components/referrals/GroupReferralCampaign.tsx')
  const element = GroupReferralCampaign({ repository, now: () => fixedNow })
  const [form] = descendants(element), event = { preventDefault() {} }
  form.props.onSubmit(event); await tick()
  assert.equal(api.states[0], value)
  assert.equal(api.states[4], actor.alias)
  assert.equal(api.states[6], 'SYNTHETIC')
  assert.ok(api.states[3].length > 0)
  form.props.onSubmit(event); await tick()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].payload.requestId, calls[1].payload.requestId)
  assert.equal(calls[0].payload.acceptRules, true)
  form.props.onSubmit(event); await tick()
  assert.notEqual(calls[2].payload.requestId, calls[1].payload.requestId)
})

test('Kyiv datetime parsing is explicit and rejects ambiguous or nonexistent DST times', () => {
  const api = harness().load('src/components/referrals/referralUi.tsx')
  assert.equal(api.referralKyivIso('2026-11-07T12:00'), '2026-11-07T10:00:00.000Z')
  assert.equal(api.referralKyivInput('2026-07-07T09:00:00Z'), '2026-07-07T12:00')
  assert.throws(() => api.referralKyivIso('2026-10-25T03:30'), /годинника/)
  assert.throws(() => api.referralKyivIso('2027-03-28T03:30'), /годинника/)
  assert.equal(api.referralKyivIso(''), null)
})

test('invitation copying accepts only same-origin paths and never an external or script URL', () => {
  const api = harness().load('src/components/referrals/referralUi.tsx'), origin = 'https://www.xelay.ink'
  assert.equal(api.referralSafeLink('/referrals?ref=SYNTHETIC', origin), origin + '/referrals?ref=SYNTHETIC')
  for (const input of ['//evil.example/', 'javascript:alert(1)', 'https://evil.example/', '/\\evil.example/', '/referrals\ncode=x']) assert.equal(api.referralSafeLink(input, origin), null)
})

test('the invitation field always uses ref even when a repository returns an old code path', () => {
  const html = renderCampaign(workspace({ ownLink: { code: 'SYNTHETIC', path: '/referrals?code=SYNTHETIC' } }))
  assert.match(html, /value="\/referrals\?ref=SYNTHETIC"/)
  assert.doesNotMatch(html, /\/referrals\?code=/)
})

test('public rules explain registration, activity and voluntary interview terms explicitly', () => {
  const html = renderCampaign(workspace())
  for (const text of ['протягом перших 24 годин', 'два різні київські дні', 'протягом 7 днів', 'але не пізніше кінцевого строку акції', 'не дає додаткових 7 днів', 'Після закінчення акції групи можна створювати й далі', 'повні 7 днів після приєднання не гарантуються', 'Один студент зараховується тільки одній групі', 'Тестові й дубльовані групи', 'Кожен із трьох переможців отримає запрошення на співбесіду', 'Участь добровільна']) assert.ok(html.includes(text), text)
})

test('late entrants see the real campaign cutoff without a promise of seven extra days', () => {
  const cutoff = '2026-11-21T21:59:00Z', value = workspace({ campaign: { ...baseCampaign, joinsUntil: cutoff, qualifiesUntil: cutoff, drawAt: '2026-11-22T16:00:00Z' } })
  const now = Date.parse('2026-11-21T20:59:00Z'), api = harness([...seed(value).slice(0, -1), now])
  const { GroupReferralCampaign } = api.load('src/components/referrals/GroupReferralCampaign.tsx')
  const html = renderToStaticMarkup(React.createElement(GroupReferralCampaign, { repository: noRepository, now: () => now }))
  assert.match(html, /До кінця виконання умов: 1 година 0 хвилин/)
  assert.match(html, /21 листопада 2026 р\. (?:о |, )?23:59/)
  assert.match(html, /повні 7 днів після приєднання не гарантуються/)
  const { referralTimeRemaining } = harness().load('src/components/referrals/referralUi.tsx')
  assert.equal(referralTimeRemaining(cutoff, Date.parse(cutoff)), 'Час вичерпано')
  assert.equal(referralTimeRemaining(cutoff, Date.parse(cutoff) - 20_000), '1 хвилина')
})

test('administrators can save one shared joining and qualification deadline', async () => {
  const cutoff = '2026-11-21T21:59:00Z', value = workspace({ actor: { ...actor, canAdmin: true }, campaign: { ...baseCampaign, state: 'draft', joinsUntil: cutoff, qualifiesUntil: cutoff, drawAt: '2026-11-22T16:00:00Z' }, admin: { groups: [], audit: [], approvedTickets: 0, eligibleOrganizers: 0 } })
  const api = harness(), { GroupReferralAdmin } = api.load('src/components/referrals/GroupReferralAdmin.tsx'), calls = []
  const element = GroupReferralAdmin({ workspace: value, onAction: async (action, payload) => { calls.push({ action, payload }); return value }, busy: false, now: fixedNow, onRefresh: noop })
  descendants(element)[0].props.onSubmit({ preventDefault() {} }); await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'save_campaign')
  assert.equal(calls[0].payload.joinsUntil, '2026-11-21T21:59:00.000Z')
  assert.equal(calls[0].payload.qualifiesUntil, calls[0].payload.joinsUntil)
})

test('an organizer who is not a member does not see an invented own attendance counter', () => {
  const entry = { id: 'entry', groupId: 'group', groupName: 'Група прикладу', organizerId: actor.id, organizerAlias: actor.alias, state: 'approved', version: 1, verifiedStudents: 10, returningStudents: 10, hasSchedule: true, hasResource: true, eligible: true, issues: [], registeredAt: baseCampaign.startsAt, createdAt: baseCampaign.startsAt, ownMemberDays: 0, ownMemberCounts: false, viewerRole: 'organizer', canSubmit: false }
  assert.doesNotMatch(renderCampaign(workspace({ ownGroups: [entry] })), /Ваші навчальні відвідування/)
  assert.match(renderCampaign(workspace({ ownGroups: [{ ...entry, viewerRole: 'member', ownMemberDays: 2, ownMemberCounts: true }] })), /Ваші навчальні відвідування/)
})

test('the open-state display follows real campaign deadlines while administrative state remains open', () => {
  const { referralCampaignDisplayLabel } = harness().load('src/components/referrals/referralUi.tsx')
  assert.equal(referralCampaignDisplayLabel(baseCampaign, Date.parse('2026-10-31T10:00:00Z')), 'Незабаром')
  assert.equal(referralCampaignDisplayLabel(baseCampaign, fixedNow), 'Приймаємо групи')
  assert.equal(referralCampaignDisplayLabel(baseCampaign, Date.parse('2026-11-21T10:00:00Z')), 'Групи виконують умови')
  assert.equal(referralCampaignDisplayLabel(baseCampaign, Date.parse('2026-11-25T10:00:00.001Z')), 'Очікуємо розіграшу')
  assert.equal(baseCampaign.state, 'open')
})

function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  const values = Array.isArray(node) ? node : node.props?.children
  for (const child of Array.isArray(values) ? values : [values]) { const found = findElement(child, predicate); if (found) return found }
  return undefined
}

test('the synthetic creation callback prevents navigation into the real application', () => {
  const api = harness(seed(workspace())), { GroupReferralCampaign } = api.load('src/components/referrals/GroupReferralCampaign.tsx')
  let prevented = 0, created = 0
  const element = GroupReferralCampaign({ repository: noRepository, now: () => fixedNow, onCreateGroup: () => created++ })
  const link = findElement(element, node => node.type === 'a' && node.props.href === '/groups?referral=SYNTHETIC')
  assert.ok(link)
  link.props.onClick({ preventDefault() { prevented++ } })
  assert.equal(prevented, 1); assert.equal(created, 1)
})

test('candidate pagination appends without resetting previously loaded own or administrative groups', async () => {
  const own = [{ id: 'own-first' }, { id: 'own-extra-page' }], candidates = [{ id: 'candidate-first', name: 'Перша', canRegister: true }], adminGroups = [{ id: 'admin-first', state: 'pending' }, { id: 'admin-extra-page', state: 'approved' }]
  const value = workspace({ actor: { ...actor, canAdmin: true }, ownGroups: own, candidateGroups: candidates, nextCursor: 'own-next', candidateNextCursor: 'candidate-next', admin: { groups: adminGroups, audit: [], approvedTickets: 0, eligibleOrganizers: 0, nextCursor: 'admin-next' } })
  const next = workspace({ ...value, ownGroups: [{ id: 'own-first', updated: true }], candidateGroups: [{ id: 'candidate-second', name: 'Друга', canRegister: true }], nextCursor: 'wrong-own-reset', candidateNextCursor: null, admin: { ...value.admin, groups: [{ id: 'admin-first', state: 'pending', updated: true }], nextCursor: 'wrong-admin-reset' } })
  const calls = [], api = harness(seed(value)), { GroupReferralCampaign } = api.load('src/components/referrals/GroupReferralCampaign.tsx')
  const repository = { async load(options) { calls.push(options); return next }, action: noRepository.action }
  const element = GroupReferralCampaign({ repository, now: () => fixedNow })
  const more = findElement(element, node => node.props?.children === 'Ще групи для участі')
  assert.ok(more); more.props.onClick(); await tick()
  assert.equal(calls[0].candidateAfter, 'candidate-next')
  assert.deepEqual(Array.from(api.states[0].candidateGroups, group => group.id), ['candidate-first', 'candidate-second'])
  assert.deepEqual(Array.from(api.states[0].ownGroups, group => group.id), ['own-first', 'own-extra-page'])
  assert.deepEqual(Array.from(api.states[0].admin.groups, group => group.id), ['admin-first', 'admin-extra-page'])
  assert.equal(api.states[0].ownGroups[0].updated, true)
  assert.equal(api.states[0].nextCursor, 'own-next'); assert.equal(api.states[0].admin.nextCursor, 'admin-next'); assert.equal(api.states[0].candidateNextCursor, null)
})
