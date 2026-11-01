import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import React from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const USER = '10000000-0000-4000-8000-000000000001', GROUP = '20000000-0000-4000-8000-000000000001', LESSON = '30000000-0000-4000-8000-000000000001', HOMEWORK = '40000000-0000-4000-8000-000000000001'
const dueAt = '2026-11-02T16:30:00.000Z'
const snapshot = () => ({ groupId: GROUP, groupName: 'Вигадана група', rangeStart: '2026-11-02', rangeEnd: '2026-11-15', lessons: [], assignments: [], homework: [{ id: HOMEWORK, date: '2026-11-02', subject: 'Математика', title: 'Приклади', body: 'Повні умови', dueAt }] })
function normalization() {
  const module = { exports: {} }, source = readFileSync(new URL('../../src/lib/offlineStudy.ts', import.meta.url), 'utf8')
  vm.runInNewContext(compile(source) + '\nmodule.exports.testNormalize=normalizeSnapshot;', { module, exports: module.exports, TextEncoder, URL, require(name) { if (name === './studyGroupVisibility') return { isStudyGroupListed() { return true } }; throw Error('Unexpected import ' + name) } })
  return module.exports.testNormalize
}
function captureHarness(error, options = {}) {
  const calls = []
  const linksModule = { exports: {} }, electiveModule = { exports: {} }
  vm.runInNewContext(compile(readFileSync(new URL('../../src/lib/studyGroupLinks.ts', import.meta.url), 'utf8')), { module: linksModule, exports: linksModule.exports, URL })
  vm.runInNewContext(compile(readFileSync(new URL('../../src/lib/studentElectiveTimetable.ts', import.meta.url), 'utf8')), { module: electiveModule, exports: electiveModule.exports, URL, TextEncoder, require(name) { if (name === './studyGroupLinks.ts') return linksModule.exports; throw Error('Unexpected elective import ' + name) } })
  class Query {
    constructor(table) { this.table = table; this.columns = ''; this.after = false; this.status = 200 }
    select(columns) { this.columns = columns; return this } eq() { return this } order() { return this } limit() { return this } gte() { return this } lte() { return this } is() { return this } gt() { this.after = true; return this } abortSignal() { return this }
    result() {
      calls.push({ table: this.table, columns: this.columns })
      if (this.table === 'study_groups') return { data: { id: GROUP, group_name: 'Вигадана група', representative_id: USER }, error: null, status: 200 }
      if (this.table === 'study_group_members') return { data: { id: 'member', status: 'accepted' }, error: null, status: 200 }
      if (this.table === 'study_group_homework' && this.columns.includes('due_at') && error) return { data: null, error, status: error.status || 400 }
      if (this.table === 'study_group_schedule' && this.columns.includes('is_elective_block') && options.flagError) return { data: null, error: options.flagError, status: options.flagError.status || 400 }
      let rows = this.after ? [] : this.table === 'study_group_schedule' ? options.schedule || [{ id: LESSON, group_id: GROUP, weekday: 1, starts_at: '09:40', ends_at: '11:00', subject: 'Математика', lesson_type: 'lecture', valid_from: '2026-11-02', valid_until: '2026-11-15', week_pattern: 'every' }] : this.table === 'study_group_homework' ? options.homework || [{ id: HOMEWORK, group_id: GROUP, schedule_item_id: LESSON, lesson_date: '2026-11-02', lesson_topic: 'Приклади', body: 'Повні умови', ...(this.columns.includes('due_at') ? { due_at: dueAt } : {}) }] : []
      if (this.table === 'study_group_schedule' && !this.columns.includes('is_elective_block')) rows = rows.map(({ is_elective_block, ...row }) => row)
      return { data: rows, error: null, status: 200 }
    }
    maybeSingle() { return Promise.resolve(this.result()) }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject) }
  }
  let accountChecks = 0
  const supabase = { auth: { getSession: async () => ({ data: { session: { user: { id: options.accountChanged && ++accountChecks > 1 ? GROUP : USER } } }, error: null }) }, from(table) { return new Query(table) }, rpc() { return { abortSignal: async () => ({ data: { assignments: [] }, error: null, status: 200 }) } } }
  const module = { exports: {} }, source = readFileSync(new URL('../../src/lib/offlineStudyCapture.ts', import.meta.url), 'utf8')
  vm.runInNewContext(compile(source.replaceAll('import.meta.env.VITE_SUPABASE_URL', "'https://synthetic.invalid'")), { module, exports: module.exports, DOMException, URL, AbortController, require(name) {
    if (name === './supabase') return { supabase }
    if (name === './studentElectiveTimetable') return electiveModule.exports
    if (name === './studentElectiveTimetableRepository') return { studentElectiveTimetableRepository: { load: async (userId, groupId) => { calls.push({ table: 'student_elective_plans', userId, groupId }); if (options.planError) throw options.planError; return options.plans || [] } } }
    if (name === './studyGroupTimetable') return { addTimetableDays: (date, count) => new Date(Date.parse(date + 'T12:00:00Z') + count * 86400000).toISOString().slice(0, 10), scheduleOccursOnDate: (_item, date) => date === '2026-11-02' }
    if (name === './seminars') return { kyivToday: () => '2026-11-02' }
    if (name === './resourceLinkLabels') return { getResourceLinkLabels: () => ({}) }
    if (name === './studyGroupTimetablePhoto') return { loadTimetablePhoto: async () => null }
    throw Error('Unexpected import ' + name)
  }, fetch() { throw Error('Network forbidden') } })
  return { capture: () => module.exports.captureOfflineStudyGroup(USER, GROUP, new AbortController().signal), denied: module.exports.isOfflineStudyAccessDenied, calls }
}
test('real capture and strict snapshot normalization retain a homework deadline through JSON round trip', async () => {
  const value = await captureHarness().capture(), normalize = normalization()
  assert.equal(value.homework[0].dueAt, dueAt)
  const restored = normalize(JSON.parse(JSON.stringify(normalize(value))))
  assert.equal(restored.homework[0].dueAt, dueAt)
})
test('old cached homework without the new optional deadline remains readable; invalid deadlines fail closed', () => {
  const normalize = normalization(), value = snapshot(); delete value.homework[0].dueAt
  assert.equal(normalize(value).homework[0].dueAt, null)
  value.homework[0].dueAt = 'not-a-time'; assert.throws(() => normalize(value), /OFFLINE_SNAPSHOT_INVALID/)
})
test('only the exact missing due_at column errors use a legacy-column fallback', async () => {
  for (const code of ['42703', 'PGRST204']) { const harness = captureHarness({ code, message: 'column study_group_homework.due_at does not exist' }); const value = await harness.capture(); assert.equal(value.homework[0].dueAt, null); assert.ok(harness.calls.some(call => call.table === 'study_group_homework' && !call.columns.includes('due_at'))) }
  for (const error of [{ code: '42501', message: 'due_at denied', status: 403 }, { code: '42703', message: 'column another_column does not exist' }, { code: 'XX000', message: 'database failure due_at' }]) { const harness = captureHarness(error); await assert.rejects(harness.capture()); assert.equal(harness.calls.some(call => call.table === 'study_group_homework' && !call.columns.includes('due_at')), false) }
})
test('actual offline homework card displays the preserved deadline using Kyiv time', () => {
  const module = { exports: {} }, source = readFileSync(new URL('../../src/components/OfflineStudyReader.tsx', import.meta.url), 'utf8')
  vm.runInNewContext(compile(source) + '\nmodule.exports.testHomeworkCard=HomeworkCard;', { module, exports: module.exports, require(name) {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return { jsx, jsxs }
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => React.createElement('svg') })
    if (name === '../lib/offlineStudy') return {}
    throw Error('Unexpected import ' + name)
  } })
  const html = renderToStaticMarkup(React.createElement(module.exports.testHomeworkCard, { item: snapshot().homework[0] }))
  assert.match(html, /Здати до/); assert.match(html, /18:30/); assert.match(html, /Київ/)
  assert.doesNotMatch(html, /16:30/)
})

const PERSONAL = '50000000-0000-4000-8000-000000000001', PLAN = '60000000-0000-4000-8000-000000000001'
const electiveSchedule = () => [{ id: LESSON, group_id: GROUP, weekday: 1, starts_at: '09:40', ends_at: '11:00', subject: 'Вибіркові дисципліни', lesson_type: 'lecture', valid_from: '2026-11-02', valid_until: '2026-11-15', week_pattern: 'every', is_elective_block: true }]
const electivePlan = (extra = {}) => ({ id: PLAN, user_id: USER, group_id: GROUP, valid_from: '2026-11-02', valid_until: '2026-11-08', configured: true, version: 1, lessons: [{ id: PERSONAL, subject: 'Моя психологія', weekday: 4, starts_at: '18:00', ends_at: '19:20', lesson_type: 'seminar', teacher_name: 'Мій викладач', location: '401', online_url: null, online_url_secondary: null, online_links_extra: [], conference_id: null, conference_access_code: null, week_pattern: 'every', week_anchor_date: null }], ...extra })

test('offline capture stores the owner actual elective day and restores the generic block after the personal term expires', async () => {
  const harness = captureHarness(undefined, { schedule: electiveSchedule(), plans: [electivePlan()] }), value = await harness.capture()
  assert.equal(value.lessons.some(row => row.subject === 'Вибіркові дисципліни' && row.date === '2026-11-02'), false)
  assert.ok(value.lessons.some(row => row.subject === 'Вибіркові дисципліни' && row.date === '2026-11-09'))
  const personal = value.lessons.find(row => row.subject === 'Моя психологія')
  assert.equal(personal.date, '2026-11-05'); assert.equal(personal.startsAt, '18:00'); assert.equal(personal.teacherName, 'Мій викладач')
  assert.equal(personal.id, 'personal-elective:' + PLAN + ':' + PERSONAL); assert.equal(value.homework.length, 0)
  const normalized = normalization()(JSON.parse(JSON.stringify(value)))
  assert.equal(normalized.lessons.find(row => row.subject === 'Моя психологія').id, personal.id)
  assert.doesNotMatch(JSON.stringify(normalized), /user_id|confirmationToken|lessons.*configured/)
  assert.deepEqual(harness.calls.filter(call => call.table === 'student_elective_plans'), [{ table: 'student_elective_plans', userId: USER, groupId: GROUP }])
})

test('an unconfigured or absent personal plan leaves the generic offline timetable and its real homework intact', async () => {
  for (const plans of [[], [electivePlan({ configured: false })]]) {
    const value = await captureHarness(undefined, { schedule: electiveSchedule(), plans }).capture()
    assert.ok(value.lessons.some(row => row.subject === 'Вибіркові дисципліни' && row.date === '2026-11-02'))
    assert.equal(value.homework.length, 1); assert.equal(value.homework[0].scheduleItemId, LESSON)
  }
})

test('private elective copies never return another owner or group plan, or complete after an account switch', async () => {
  for (const plan of [electivePlan({ user_id: GROUP }), electivePlan({ group_id: USER })]) {
    const harness = captureHarness(undefined, { schedule: electiveSchedule(), plans: [plan] })
    await assert.rejects(harness.capture(), error => harness.denied(error))
  }
  await assert.rejects(captureHarness(undefined, { schedule: electiveSchedule(), plans: [electivePlan()], accountChanged: true }).capture(), /Акаунт змінився/)
})

test('only exact staged elective table and schedule flag absence may retain the legacy shared offline calendar', async () => {
  for (const code of ['42P01', 'PGRST205']) {
    const value = await captureHarness(undefined, { schedule: electiveSchedule(), planError: { code, message: 'table public.student_elective_plans does not exist' } }).capture()
    assert.ok(value.lessons.some(row => row.subject === 'Вибіркові дисципліни'))
  }
  for (const code of ['42703', 'PGRST204']) {
    const harness = captureHarness(undefined, { schedule: electiveSchedule(), plans: [electivePlan()], flagError: { code, message: 'column study_group_schedule.is_elective_block does not exist' } })
    assert.ok((await harness.capture()).lessons.some(row => row.subject === 'Вибіркові дисципліни'))
    assert.ok(harness.calls.some(call => call.table === 'study_group_schedule' && !call.columns.includes('is_elective_block')))
  }
  for (const error of [{ code: '42501', status: 403, message: 'is_elective_block denied' }, { code: '42703', message: 'column another_field does not exist' }]) {
    const harness = captureHarness(undefined, { flagError: error }); await assert.rejects(harness.capture())
    assert.equal(harness.calls.some(call => call.table === 'study_group_schedule' && !call.columns.includes('is_elective_block')), false)
  }
  for (const error of [{ code: '42501', message: 'student_elective_plans denied' }, { code: 'PGRST205', status: 403, message: 'student_elective_plans unavailable' }, { code: '42P01', message: 'another_table does not exist' }]) await assert.rejects(captureHarness(undefined, { schedule: electiveSchedule(), planError: error }).capture())
  const ordinary = captureHarness(); await ordinary.capture()
  assert.equal(ordinary.calls.some(call => call.table === 'student_elective_plans'), false)
})
