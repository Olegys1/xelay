import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load(file, imports = {}) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(output, { exports, Date, Intl, Map, Set, require(name) { if (!(name in imports)) throw new Error('Unexpected import: ' + name); return imports[name] } })
  return exports
}
const years = load('src/lib/studyGroupAcademicYears.ts')
const nav = load('src/lib/groupYearNavigation.ts', { './studyGroupAcademicYears': years })

test('year selection preserves the academic month and clamps a leap day', () => {
  assert.equal(nav.groupDateInAcademicYear('2026-10-27', 2024), '2024-10-27')
  assert.equal(nav.groupDateInAcademicYear('2027-02-10', 2025), '2026-02-10')
  assert.equal(nav.groupDateInAcademicYear('2024-02-29', 2022), '2023-02-28')
})
test('Kyiv academic-year boundary is independent of UTC date', () => {
  const day = nav.groupTodayInKyiv(new Date('2026-08-31T21:30:00Z'))
  assert.equal(day, '2026-09-01')
  assert.equal(years.groupAcademicYearForDate(day), 2026)
})
test('legacy years and cohort years remain reachable without looking up another group', () => {
  const choices = Array.from(nav.groupYearChoices({ today: '2026-10-27', selectedDate: '2020-10-27', cohortStartYear: 2024, dates: ['2023-09-01', 'infinity'] }))
  assert.ok(choices.includes(2020) && choices.includes(2023) && choices.includes(2026))
  assert.equal(choices[0], 2027)
  assert.ok(choices.every(Number.isInteger))
})
test('schedule-year intersection includes August/September edges and open-ended legacy rows', () => {
  assert.equal(nav.groupYearContainsSchedule({ valid_from: '2025-09-01', valid_until: '2026-08-31' }, 2025), true)
  assert.equal(nav.groupYearContainsSchedule({ valid_from: '2026-09-01', valid_until: '2027-01-31' }, 2025), false)
  assert.equal(nav.groupYearContainsSchedule({ valid_from: '-infinity', valid_until: 'infinity' }, 2025), true)
})
test('a saved homework entry stays visible after its schedule period changes', () => {
  assert.equal(nav.groupHomeworkMakesLessonVisible({ id: 'old-template' }, new Map([['old-template', { lesson_date: '2025-10-27' }]])), true)
  assert.equal(nav.groupHomeworkMakesLessonVisible({ id: 'other-template' }, new Map([['old-template', {}]])), false)
})

test('history reader handles a server row cap below requested page size and keeps the group boundary', async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: String(index + 1), group_id: 'same-group', weekday: 1, starts_at: '08:00' }))
  const calls = []
  const supabase = { from(table) { assert.equal(table, 'study_group_schedule'); const call = {}; calls.push(call); return {
    select() { return this }, eq(column, value) { call[column] = value; return this }, order(column) { call.order = column; return this },
    limit(size) { call.limit = size; return this }, gt(column, value) { call.after = value; return this },
    then(resolve) { resolve({ data: rows.filter(row => row.group_id === call.group_id && (!call.after || row.id > call.after)).slice(0, 2), error: null, status: 200 }) },
  } } }
  const reader = load('src/lib/studyGroupScheduleRead.ts', { './supabase': { supabase } })
  const result = await reader.loadStudyGroupScheduleHistory('same-group')
  assert.equal(result.data.length, 5)
  assert.equal(calls.length, 4)
  assert.ok(calls.every(call => call.group_id === 'same-group' && call.order === 'id'))
})
test('failed membership read returns no retained history rows', async () => {
  const error = { code: '42501', message: 'permission denied' }
  const supabase = { from() { return { select() { return this }, eq() { return this }, order() { return this }, limit() { return this }, then(resolve) { resolve({ data: null, error, status: 403 }) } } } }
  const reader = load('src/lib/studyGroupScheduleRead.ts', { './supabase': { supabase } })
  const result = await reader.loadStudyGroupScheduleHistory('same-group')
  assert.equal(result.data, null)
  assert.equal(result.error, error)
})
