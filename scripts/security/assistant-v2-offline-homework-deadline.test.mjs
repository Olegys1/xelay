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
function captureHarness(error) {
  const calls = []
  class Query {
    constructor(table) { this.table = table; this.columns = ''; this.after = false; this.status = 200 }
    select(columns) { this.columns = columns; return this } eq() { return this } order() { return this } limit() { return this } gte() { return this } lte() { return this } is() { return this } gt() { this.after = true; return this } abortSignal() { return this }
    result() {
      calls.push({ table: this.table, columns: this.columns })
      if (this.table === 'study_groups') return { data: { id: GROUP, group_name: 'Вигадана група', representative_id: USER }, error: null, status: 200 }
      if (this.table === 'study_group_members') return { data: { id: 'member', status: 'accepted' }, error: null, status: 200 }
      if (this.table === 'study_group_homework' && this.columns.includes('due_at') && error) return { data: null, error, status: error.status || 400 }
      const rows = this.after ? [] : this.table === 'study_group_schedule' ? [{ id: LESSON, group_id: GROUP, weekday: 1, starts_at: '09:40', ends_at: '11:00', subject: 'Математика', lesson_type: 'lecture' }] : this.table === 'study_group_homework' ? [{ id: HOMEWORK, group_id: GROUP, schedule_item_id: LESSON, lesson_date: '2026-11-02', lesson_topic: 'Приклади', body: 'Повні умови', ...(this.columns.includes('due_at') ? { due_at: dueAt } : {}) }] : []
      return { data: rows, error: null, status: 200 }
    }
    maybeSingle() { return Promise.resolve(this.result()) }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject) }
  }
  const supabase = { auth: { getSession: async () => ({ data: { session: { user: { id: USER } } }, error: null }) }, from(table) { return new Query(table) }, rpc() { return { abortSignal: async () => ({ data: { assignments: [] }, error: null, status: 200 }) } } }
  const module = { exports: {} }, source = readFileSync(new URL('../../src/lib/offlineStudyCapture.ts', import.meta.url), 'utf8')
  vm.runInNewContext(compile(source.replaceAll('import.meta.env.VITE_SUPABASE_URL', "'https://synthetic.invalid'")), { module, exports: module.exports, DOMException, URL, AbortController, require(name) {
    if (name === './supabase') return { supabase }
    if (name === './studyGroupTimetable') return { addTimetableDays: (date, count) => new Date(Date.parse(date + 'T12:00:00Z') + count * 86400000).toISOString().slice(0, 10), scheduleOccursOnDate: (_item, date) => date === '2026-11-02' }
    if (name === './seminars') return { kyivToday: () => '2026-11-02' }
    if (name === './resourceLinkLabels') return { getResourceLinkLabels: () => ({}) }
    if (name === './studyGroupTimetablePhoto') return { loadTimetablePhoto: async () => null }
    throw Error('Unexpected import ' + name)
  }, fetch() { throw Error('Network forbidden') } })
  return { capture: () => module.exports.captureOfflineStudyGroup(USER, GROUP, new AbortController().signal), calls }
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
