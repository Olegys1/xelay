// Synthetic period scoping only. No database, provider, server or audit.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
const root = fileURLToPath(new URL('../', import.meta.url)), modules = new Map()
const plain = value => JSON.parse(JSON.stringify(value))
function load(file) {
  const filename = resolve(root, file)
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }; modules.set(filename, module)
  const result = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  vm.runInNewContext(result.outputText, { module, exports: module.exports, Date, Intl,
    require(name) { if (name.startsWith('.')) return load(resolve(dirname(filename), name + '.ts')); throw new Error('Unexpected external import') } }, { filename })
  return module.exports
}
const helper = load('src/lib/studyGroupTeachingYear.ts')
const group = 'group-a'
const course = (id, starts_on, ends_on) => ({ id, starts_on, ends_on, title: id })
const item = (id, course_id, target = { group_id: group }, extra = {}) => ({ id, course_id, targets: [target], ...extra })
function data() {
  return { courses: [course('past', '2025-09-01', '2026-06-30'), course('current', '2026-09-01', '2027-06-30'), course('shared-period', '2025-09-01', '2027-08-31')],
    pending_invites: [{ id: 'mine', group_id: group }, { id: 'foreign-invite', group_id: 'group-b' }],
    grades: [
      { id: 'past-grade', course_id: 'past', group_id: group, activity_date: '2025-10-01' },
      { id: 'current-grade', course_id: 'current', group_id: group, activity_date: '2026-10-01' },
      { id: 'foreign-grade', course_id: 'past', group_id: 'group-b', activity_date: '2025-10-01' },
      { id: 'shared-past', course_id: 'shared-period', group_id: group, activity_date: '2026-08-31' },
      { id: 'shared-current', course_id: 'shared-period', group_id: group, activity_date: '2026-09-01' },
    ], assignments: [], materials: [] }
}
test('course periods intersect a selected academic year and reject invalid dates', () => {
  assert.equal(helper.groupTeachingCourseInAcademicYear(course('x', '2025-08-31', '2025-09-01'), 2025), true)
  assert.equal(helper.groupTeachingCourseInAcademicYear(course('x', '2025-01-01', '2025-08-31'), 2025), false)
  assert.equal(helper.groupTeachingCourseInAcademicYear(course('x', '2026-08-31', '2026-09-02'), 2025), true)
  assert.equal(helper.groupTeachingCourseInAcademicYear(course('x', '2026-09-01', '2027-01-01'), 2025), false)
  assert.equal(helper.groupTeachingCourseInAcademicYear(course('x', '2026-02-30', '2026-06-01'), 2025), false)
  assert.equal(helper.groupTeachingCourseInAcademicYear(course('x', '2026-04-01', '2026-03-01'), 2025), false)
})
test('own grade periods exclude other groups, other courses and out-of-year activities', () => {
  const source = data(), original = structuredClone(source)
  const result = helper.groupTeachingDataForAcademicYear(source, group, 2025)
  assert.deepEqual(plain(result.courses.map(row => row.id)), ['past', 'shared-period'])
  assert.deepEqual(plain(result.grades.map(row => row.id)), ['past-grade', 'shared-past'])
  assert.deepEqual(plain(result.pending_invites.map(row => row.id)), ['mine'])
  assert.deepEqual(source, original, 'Scoping must not mutate the repository cache')
})
test('assignment lesson date wins over a different deadline; undated assignments keep a known course period', () => {
  const source = data()
  source.assignments = [
    item('lesson-past', 'shared-period', { group_id: group, lesson_date: '2026-08-31', due_at: '2026-09-02T10:00:00Z' }),
    item('lesson-current', 'shared-period', { group_id: group, lesson_date: '2026-09-01', due_at: '2026-08-31T10:00:00Z' }),
    item('due-past', 'past', { group_id: group, due_at: '2025-11-12T10:00:00Z' }),
    item('undated', 'past'), item('wrong-course', 'current'),
    item('wrong-group', 'past', { group_id: 'group-b', lesson_date: '2025-10-01' }),
  ]
  assert.deepEqual(plain(helper.groupTeachingDataForAcademicYear(source, group, 2025).assignments.map(row => row.id)), ['lesson-past', 'due-past', 'undated'])
})
test('deadlines are interpreted using Kyiv calendar dates at the September boundary', () => {
  const source = data()
  source.assignments = [item('kyiv-september', 'shared-period', { group_id: group, due_at: '2026-08-31T21:30:00Z' }), item('kyiv-august', 'shared-period', { group_id: group, due_at: '2026-08-31T18:30:00Z' })]
  assert.deepEqual(plain(helper.groupTeachingDataForAcademicYear(source, group, 2025).assignments.map(row => row.id)), ['kyiv-august'])
  assert.deepEqual(plain(helper.groupTeachingDataForAcademicYear(source, group, 2026).assignments.map(row => row.id)), ['kyiv-september'])
})
test('materials use their study date then publication date; undated materials remain in all-years', () => {
  const source = data()
  source.materials = [
    item('dated-past', 'shared-period', undefined, { material_date: '2026-08-31', published_at: '2026-10-01T10:00:00Z' }),
    item('dated-current', 'shared-period', undefined, { material_date: '2026-09-01', published_at: '2025-10-01T10:00:00Z' }),
    item('published-past', 'past', undefined, { published_at: '2025-10-01T10:00:00Z' }),
    item('unknown', 'past'), item('wrong-group', 'past', { group_id: 'group-b' }, { material_date: '2025-10-01' }),
  ]
  assert.deepEqual(plain(helper.groupTeachingDataForAcademicYear(source, group, 2025).materials.map(row => row.id)), ['dated-past', 'published-past'])
  assert.deepEqual(plain(helper.groupTeachingDataForAcademicYear(source, group).materials.map(row => row.id)), ['dated-past', 'dated-current', 'published-past', 'unknown'])
})
test('omitting the year keeps historical grades and courses while preserving the group boundary', () => {
  const result = helper.groupTeachingDataForAcademicYear(data(), group)
  assert.equal(result.courses.length, 3)
  assert.deepEqual(plain(result.grades.map(row => row.id)), ['past-grade', 'current-grade', 'shared-past', 'shared-current'])
})
