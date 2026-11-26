import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
async function load(file) {
  const api = {}
  const source = await readFile(new URL(file, root), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(js, { exports: api })
  return api
}
const plans = await load('src/lib/studentPlans.ts')
const budget = await load('src/lib/studentAiBudget.ts')
const now = Date.parse('2026-11-16T08:00:00Z')
const audience = { userId: 'student-1', initialAudience: 'student', assignedAt: '2026-01-01T00:00:00Z' }
const base = { authenticatedUserId: 'student-1', billingAudience: audience, now }
const legacy = (extra = {}) => ({ userId: 'student-1', kind: 'payment', isPremium: true, isLifetime: false, expiresAt: '2026-12-01T00:00:00Z', ...extra })
const grant = (extra = {}) => ({ userId: 'student-1', planId: 'plus', startsAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', ...extra })

test('catalog has three paid monthly levels and preserves a separate free study core', () => {
  assert.deepEqual(Array.from(plans.STUDENT_PLANS, item => [item.id, item.monthlyPriceUah]), [['start', 149], ['plus', 399], ['max', 999]])
  assert.equal(plans.STUDENT_FREE_FEATURES.length, 4)
  assert.ok(plans.STUDENT_FREE_FEATURES.some(text => /пошту/.test(text)))
  assert.ok(plans.STUDENT_FREE_FEATURES.some(text => /Тести викладачів/.test(text)))
  assert.throws(() => plans.getStudentPlan('unknown'))
  assert.equal(Object.isFrozen(plans.STUDENT_PLANS), true)
  assert.equal(Object.isFrozen(plans.getStudentPlan('plus').features), true)
  assert.deepEqual(Array.from(plans.LEGACY_PARTICIPANT_CAPABILITIES), [
    'participant_badge', 'text_status', 'emoji_status', 'chat_history_search',
    'scheduled_direct_messages', 'personal_organizer', 'shared_organizer',
    'organizer_push_reminders', 'profile_appearance', 'chat_appearance',
    'create_polls', 'create_articles',
  ])
})

test('student acquiring teaching capability remains a student; profile labels never resolve billing audience', () => {
  assert.equal(plans.resolveBillingAudience({ ...audience, isTeacher: true, accountType: 'teacher' }, 'student-1', now), 'student')
  assert.equal(plans.resolveBillingAudience({ accountType: 'teacher', isTeacher: true }, 'student-1', now), 'unresolved')
  assert.equal(plans.resolveBillingAudience({ ...audience, userId: 'other' }, 'student-1', now), 'unresolved')
  assert.equal(plans.resolveBillingAudience({ ...audience, initialAudience: 'admin' }, 'student-1', now), 'unresolved')
  assert.equal(plans.resolveBillingAudience({ ...audience, assignedAt: 'tomorrow' }, 'student-1', now), 'unresolved')
  assert.equal(plans.resolveBillingAudience({ ...audience, assignedAt: '2026-12-01' }, 'student-1', now), 'unresolved')
})

test('Start explains every former Participant capability with concrete limits rather than an unnamed bundle', () => {
  const start = plans.getStudentPlanFeatures('start')
  const legacyRows = start.filter(feature => feature.legacyCapability)
  assert.deepEqual(Array.from(legacyRows, feature => feature.legacyCapability).sort(), Array.from(plans.LEGACY_PARTICIPANT_CAPABILITIES).sort())
  assert.equal(legacyRows.length, 12)
  assert.ok(legacyRows.every(feature => feature.minimumPlan === 'start' && feature.status === 'existing' && feature.description.length > 40))
  assert.match(start.find(feature => feature.id === 'text_status').description, /48/)
  assert.match(start.find(feature => feature.id === 'emoji_status').description, /трьох/)
  assert.match(start.find(feature => feature.id === 'shared_organizer').description, /35 людей разом із власником/)
  assert.match(start.find(feature => feature.id === 'shared_organizer').description, /кожному потрібна активна підписка/i)
  assert.match(start.find(feature => feature.id === 'organizer_push').description, /підтримуваних пристроях/)
  assert.ok(plans.getStudentPlan('start').features.every(text => !/усі можливості|учасник/i.test(text)))
})

test('feature inheritance is cumulative, stable and cannot treat an unknown plan as the maximum tier', () => {
  const start = plans.getStudentPlanFeatures('start'), plus = plans.getStudentPlanFeatures('plus'), max = plans.getStudentPlanFeatures('max')
  const ids = rows => new Set(Array.from(rows, item => item.id))
  assert.ok(start.every(item => ids(plus).has(item.id)))
  assert.ok(plus.every(item => ids(max).has(item.id)))
  assert.ok(plus.length > start.length && max.length > plus.length)
  assert.equal(new Set(max.map(item => item.id)).size, max.length)
  for (const invalid of ['free', 'teacher', 'unlimited', '__proto__', null]) assert.throws(() => plans.getStudentPlanFeatures(invalid))
  assert.equal(Object.isFrozen(start), true)
  assert.equal(Object.isFrozen(max[0]), true)
})

test('new non-AI features add useful tools to all tiers and AI remains a separate paused roadmap', () => {
  const all = plans.STUDENT_PLAN_FEATURES
  const validCategories = new Set(plans.STUDENT_FEATURE_CATEGORIES.map(category => category.id))
  assert.ok(all.every(feature => validCategories.has(feature.category) && ['existing', 'local', 'planned', 'paused'].includes(feature.status) && feature.description.trim().length >= 40))
  for (const level of ['start', 'plus', 'max']) assert.ok(all.filter(feature => feature.minimumPlan === level && !feature.legacyCapability).length >= 4)
  for (const id of ['focus_sessions', 'study_bookmarks', 'daily_checklist', 'personal_quiz_builder', 'quiz_import', 'mistake_review', 'practice_history', 'timed_rehearsal', 'multi_exam_plan', 'workload_calendar', 'grade_goal']) assert.ok(all.some(feature => feature.id === id && feature.status === 'local'))
  assert.ok(plans.STUDENT_AI_ROADMAP.length >= 3)
  assert.ok(plans.STUDENT_AI_ROADMAP.every(feature => feature.status === 'paused'))
  const activeIds = new Set(plans.getStudentPlanFeatures('max').map(feature => feature.id))
  assert.ok(plans.STUDENT_AI_ROADMAP.every(feature => !activeIds.has(feature.id)))
  assert.ok(plans.STUDENT_PLANS.every(plan => plan.features.every(text => !/ШІ|навчального помічника|поглиблені пояснення|голос/i.test(text))))
})

test('Max has an independent source-to-project studio workflow while every lower-tier feature remains inherited', () => {
  const max = plans.getStudentPlan('max')
  assert.equal(max.eyebrow, 'Особиста навчальна студія')
  assert.match(max.description, /джерела/)
  assert.match(max.features.join(' '), /Великі роботи/)
  const uniqueIds = ['research_reader', 'source_capture', 'coursework_projects', 'source_citations', 'project_versions', 'project_export']
  const startIds = new Set(plans.getStudentPlanFeatures('start').map(feature => feature.id))
  const plusIds = new Set(plans.getStudentPlanFeatures('plus').map(feature => feature.id))
  for (const id of uniqueIds) {
    const feature = plans.STUDENT_PLAN_FEATURES.find(item => item.id === id)
    assert.ok(feature)
    assert.equal(feature.minimumPlan, 'max')
    assert.equal(feature.status, 'local')
    assert.equal(startIds.has(id), false)
    assert.equal(plusIds.has(id), false)
  }
  const maxIds = new Set(plans.getStudentPlanFeatures('max').map(feature => feature.id))
  assert.ok(Array.from(plusIds).every(id => maxIds.has(id)))
  for (const id of ['timed_rehearsal', 'multi_exam_plan', 'workload_calendar', 'grade_goal']) assert.ok(maxIds.has(id))
  assert.ok(max.features.some(text => /версії роботи/.test(text)))
  assert.ok(max.features.some(text => /Сценарії/.test(text)))
})

test('Max source and result descriptions preserve ownership, local scope and honest academic boundaries', () => {
  const byId = id => plans.STUDENT_PLAN_FEATURES.find(feature => feature.id === id)
  assert.match(byId('research_reader').description, /завантажені вами PDF/)
  assert.match(byId('research_reader').description, /захищені оригінали викладача не підтягуються/)
  assert.match(byId('source_capture').description, /сторінкою/)
  assert.match(byId('source_citations').description, /без обіцянки автоматичної відповідності/)
  assert.match(byId('grade_goal').description, /не змінює оцінок у журналі/)
  assert.match(byId('project_export').description, /після зміни тарифу/)
  assert.equal(plans.getStudentPlanFeatures('start').length, 18)
  assert.equal(plans.getStudentPlanFeatures('plus').length, 28)
  assert.equal(plans.STUDENT_PLAN_FEATURES.filter(feature => feature.minimumPlan === 'max').length, 11)
})

test('active Participant payment retains all benefits and its exact remaining period in Start', () => {
  const state = plans.resolveStudentEntitlements({ ...base, legacyGrant: legacy() })
  assert.equal(state.planId, 'start')
  assert.equal(state.source, 'legacy_payment')
  assert.equal(state.expiresAt, legacy().expiresAt)
  assert.equal(state.legacyBenefits, true)
  assert.equal(state.aiAllowance, 'pending_legacy_policy')
  assert.equal(state.monthlyAiBudgetUsd, 0)
})

test('gift and lifetime retain old benefits without silently granting new metered AI', () => {
  for (const old of [legacy({ kind: 'gift' }), legacy({ kind: 'lifetime', isLifetime: true, expiresAt: null })]) {
    const state = plans.resolveStudentEntitlements({ ...base, legacyGrant: old })
    assert.equal(state.planId, 'start')
    assert.equal(state.legacyBenefits, true)
    assert.equal(state.isLifetime, old.isLifetime)
    assert.equal(state.expiresAt, old.expiresAt)
    assert.equal(state.aiAllowance, 'pending_legacy_policy')
    assert.equal(state.monthlyAiBudgetUsd, 0)
  }
})

test('teacher or unresolved billing audience never loses legacy benefits or gains student AI by inference', () => {
  for (const record of [null, { ...audience, initialAudience: 'teacher' }]) {
    const state = plans.resolveStudentEntitlements({ ...base, billingAudience: record, legacyGrant: legacy(), planGrant: grant() })
    assert.equal(state.planId, 'free')
    assert.equal(state.legacyBenefits, true)
    assert.equal(state.aiAllowance, 'not_included')
  }
})

test('expired, future, invalid and foreign grants cannot activate a subscription; own content stays accessible', () => {
  const badOld = [legacy({ expiresAt: new Date(now).toISOString() }), legacy({ expiresAt: 'invalid' }), legacy({ userId: 'other' }), legacy({ kind: 'lifetime', isLifetime: true }), legacy({ isPremium: 'yes' }), legacy({ isLifetime: 0 })]
  for (const old of badOld) assert.equal(plans.resolveStudentEntitlements({ ...base, legacyGrant: old }).legacyBenefits, false)
  const badNew = [grant({ startsAt: '2026-12-01' }), grant({ expiresAt: new Date(now).toISOString() }), grant({ userId: 'other' }), grant({ planId: 'unlimited' }), grant({ startsAt: 'invalid' })]
  for (const planGrant of badNew) {
    const state = plans.resolveStudentEntitlements({ ...base, planGrant })
    assert.equal(state.planId, 'free')
    assert.equal(state.ownSavedContentAccess, true)
  }
  assert.equal(plans.resolveStudentEntitlements({ ...base, planGrant: grant(), now: NaN }).planId, 'free')
})

test('new grant uses its own level without consuming an old lifetime benefit', () => {
  const old = legacy({ kind: 'lifetime', isLifetime: true, expiresAt: null })
  assert.equal(plans.resolveStudentEntitlements({ ...base, planGrant: grant(), legacyGrant: old }).planId, 'plus')
  const after = plans.resolveStudentEntitlements({ ...base, legacyGrant: old, now: Date.parse('2027-01-01') })
  assert.equal(after.legacyBenefits, true)
  assert.equal(after.isLifetime, true)
})

test('economics keep FX and processor assumptions explicit and exclude fixed costs and taxes', () => {
  assert.deepEqual(Array.from(plans.STUDENT_PLANS, p => plans.calculateStudentPlanEconomics(p.id).contributionUah), [131.02, 206.02, 404.02])
  const estimate = plans.calculateStudentPlanEconomics('start', { uahPerUsd: 60, paymentFeeRate: 0.03, otherVariableUah: 20 })
  assert.equal(estimate.aiUah, 0)
  assert.equal(estimate.paymentFeeUah, 4.47)
  assert.equal(estimate.contributionUah, 124.53)
  for (const assumptions of [{ uahPerUsd: NaN }, { uahPerUsd: 0 }, { paymentFeeRate: 2 }, { otherVariableUah: -1 }]) assert.throws(() => plans.calculateStudentPlanEconomics('start', assumptions))
})

test('cost includes cached input, all output including reasoning once, and explicitly billed tools', () => {
  const rates = { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 10 }
  assert.equal(budget.calculateAiCostMicros({ inputTokens: 8000, cachedInputTokens: 0, outputTokens: 2000, reasoningTokens: 1000 }, rates), 36000)
  assert.equal(budget.calculateAiCostMicros({ inputTokens: 8000, cachedInputTokens: 4000, outputTokens: 2000, reasoningTokens: 1000, toolCostUsd: 0.01 }, rates), 38400)
  assert.equal(budget.aiUsdToMicros(0.00000001), 1)
  assert.equal(budget.aiUsdToMicros(0), 0)
  for (const usage of [{ inputTokens: NaN }, { cachedInputTokens: 8001 }, { outputTokens: -1 }, { reasoningTokens: 2001 }, { toolCostUsd: Infinity }]) {
    assert.throws(() => budget.calculateAiCostMicros({ inputTokens: 8000, cachedInputTokens: 0, outputTokens: 2000, ...usage }, rates))
  }
})

test('reservation admits exact allowance boundary and denies invalid, over-budget or zero-cost operations', () => {
  const state = { limitMicros: 600000, spentMicros: 500000, reservedMicros: 50000 }
  assert.equal(budget.evaluateAiReservation(state, 50000).allowed, true)
  assert.equal(budget.evaluateAiReservation(state, 50001).allowed, false)
  assert.equal(budget.evaluateAiReservation(state, 50000).remainingMicros, 0)
  for (const value of [0, -1, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(budget.evaluateAiReservation(state, value).allowed, false)
  assert.equal(budget.evaluateAiReservation({ ...state, spentMicros: NaN }, 1).reason, 'invalid_budget')
  assert.equal(budget.evaluateAiReservation({ ...state, spentMicros: Number.MAX_SAFE_INTEGER, reservedMicros: 1 }, 1).reason, 'invalid_budget')
})

test('unknown usage consumes reservation, known actual cost releases remainder and overspend is never hidden', () => {
  const state = { limitMicros: 600000, spentMicros: 500000, reservedMicros: 50000 }
  const unknown = budget.settleAiReservation(state, 40000, null)
  assert.equal(unknown.spentMicros, 540000)
  assert.equal(unknown.reservedMicros, 10000)
  const actual = budget.settleAiReservation(state, 40000, 30000)
  assert.equal(actual.spentMicros, 530000)
  assert.equal(actual.reservedMicros, 10000)
  const overspent = budget.settleAiReservation(state, 50000, 120000)
  assert.equal(overspent.spentMicros, 620000)
  assert.equal(budget.evaluateAiReservation(overspent, 1).allowed, false)
  assert.throws(() => budget.settleAiReservation(state, 50001, 1))
  assert.throws(() => budget.settleAiReservation(state, 50000, NaN))
  assert.throws(() => budget.settleAiReservation({ ...state, spentMicros: Number.MAX_SAFE_INTEGER }, 1, 2))
  assert.throws(() => budget.settleAiReservation({ ...state, spentMicros: Number.MAX_SAFE_INTEGER }, 1, 0))
})
