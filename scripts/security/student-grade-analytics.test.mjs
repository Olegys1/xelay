// Published student results only; no database, real accounts or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

function compile(source, dependencies = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, TextEncoder, require(name) {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    throw new Error(`Unexpected runtime dependency: ${name}`)
  } })
  return module.exports
}

const grading = compile(await readFile(new URL('../../src/lib/teachingGrading.ts', import.meta.url), 'utf8'))
const { buildStudentGradeAnalytics } = compile(await readFile(new URL('../../src/lib/studentGradeAnalytics.ts', import.meta.url), 'utf8'), { './teachingGrading': grading })
const group = 'group-one'
const course = (id, rules = { categories: [], total_max: 100 }, semester = 'Осінь 2026') => ({
  id, title: 'Економіка', semester, starts_on: semester === 'Осінь 2026' ? '2026-09-01' : '2026-02-01',
  ends_on: '2026-12-31', grading_rules: rules, archived_at: null,
})
const grade = (id, subject, score, changes = {}) => ({
  id, course_id: subject.id, group_id: group, activity_id: `activity-${id}`, entry_id: `entry-${subject.id}`,
  published_score: score, published_comment: '', published_at: '2026-10-20T12:00:00Z',
  activity_title: `Робота ${id}`, activity_date: '2026-10-20', max_points: 100,
  category: '', course_title: subject.title, grading_rules: subject.grading_rules, ...changes,
})
const data = (courses, grades) => ({ courses, grades, pending_invites: [], assignments: [], materials: [] })

test('subjects and semesters receive separate totals even when their titles are identical', () => {
  const current = course('current'), previous = course('previous', undefined, 'Весна 2026')
  const result = buildStudentGradeAnalytics(data([current, previous], [grade('a', current, 10), grade('b', current, 20), grade('c', previous, 40)]), group)
  assert.equal(result.length, 2)
  assert.equal(result.find(item => item.course.id === current.id).earned, 30)
  assert.equal(result.find(item => item.course.id === current.id).assessedEarned, 30)
  assert.equal(result.find(item => item.course.id === previous.id).earned, 40)
})

test('category subtotals preserve four-decimal coefficients and use the same calculation as the teacher journal', () => {
  const subject = course('weighted', { total_max: 100, rounding: 'none', categories: [{ id: 'seminar', name: 'Семінари', max_points: 40, coefficient: 0.3333 }] })
  const result = buildStudentGradeAnalytics(data([subject], [grade('a', subject, 7.5, { category: 'seminar' })]), group)[0]
  assert.equal(result.assessedEarned, 7.5)
  assert.equal(result.earned, 7.5 * 0.3333)
  assert.equal(result.categories[0].rawEarned, 7.5)
  assert.equal(result.categories[0].earned, result.earned)
  assert.notEqual(result.categories[0].earned, 2.5)
})

test('category caps, unknown categories, group-specific coefficients and final rounding follow the shared formula', () => {
  const defaultRules = { total_max: 100, categories: [{ id: 'seminar', name: 'Семінари', max_points: 40 }] }
  const groupRules = { total_max: 20, rounding: 'integer', categories: [{ id: 'seminar', name: 'Семінари', max_points: 5, coefficient: 2 }, { id: 'exam', name: 'Іспит', max_points: 60, coefficient: 1.5 }] }
  const subject = course('overridden', defaultRules)
  const grades = [
    grade('a', subject, 3, { category: 'seminar', grading_rules: groupRules }),
    grade('b', subject, 3, { category: 'seminar', grading_rules: groupRules }),
    grade('c', subject, 8, { category: 'exam', grading_rules: groupRules }),
    grade('d', subject, 4, { grading_rules: groupRules }),
  ]
  const result = buildStudentGradeAnalytics(data([subject], grades), group)[0]
  assert.equal(result.assessedEarned, 18)
  assert.equal(result.earned, 20)
  assert.equal(result.maximum, 20)
  assert.equal(result.categories.find(item => item.id === 'seminar').earned, 5)
  assert.equal(result.categories.find(item => item.id === 'exam').earned, 12)
  assert.equal(result.categories.find(item => item.id === '').earned, 4)
  assert.equal(result.earned, grading.calculateTeachingTotal(groupRules, grades.map(item => ({ category: item.category, score: item.published_score }))))
})

test('published zero is a result while feedback without a numeric score stays unknown', () => {
  const zero = course('zero'), feedback = course('feedback')
  const result = buildStudentGradeAnalytics(data([zero, feedback], [
    grade('a', zero, 0, { max_points: 5 }),
    grade('b', feedback, null, { published_comment: 'Потрібно уточнити відповідь.', max_points: 5 }),
  ]), group)
  const zeroResult = result.find(item => item.course.id === zero.id)
  const feedbackResult = result.find(item => item.course.id === feedback.id)
  assert.equal(zeroResult.earned, 0)
  assert.equal(zeroResult.numericGrades.length, 1)
  assert.equal(zeroResult.assessedPercent, 0)
  assert.equal(feedbackResult.earned, null)
  assert.equal(feedbackResult.assessedPercent, null)
  assert.equal(feedbackResult.categories[0].earned, null)
  assert.equal(feedbackResult.feedbackOnlyCount, 1)
})

test('duplicate records are counted once using the newest published value and never expose draft fields', () => {
  const subject = course('dedupe')
  const result = buildStudentGradeAnalytics(data([subject], [
    grade('same-id', subject, 9, { published_at: '2026-10-19T12:00:00Z', draft_score: 99, draft_comment: 'Private draft' }),
    grade('same-id', subject, 7, { published_at: '2026-10-20T12:00:00Z', draft_score: 99, draft_comment: 'Private draft' }),
  ]), group)[0]
  assert.equal(result.earned, 7)
  assert.equal(result.grades.length, 1)
  assert.equal(Object.hasOwn(result.grades[0], 'draft_score'), false)
  assert.equal(Object.hasOwn(result.grades[0], 'draft_comment'), false)
})

test('foreign groups, unknown subjects, unpublished and invalid scores never enter a total', () => {
  const subject = course('valid'), unknown = course('unknown')
  const result = buildStudentGradeAnalytics(data([subject], [
    grade('valid', subject, 8),
    grade('foreign', subject, 99, { group_id: 'another-group' }),
    grade('unknown', unknown, 90),
    grade('unpublished', subject, 80, { published_at: null }),
    grade('too-high', subject, 101),
    grade('negative', subject, -1),
    grade('nan', subject, NaN),
  ]), group)[0]
  assert.equal(result.earned, 8)
  assert.equal(result.grades.length, 1)
  assert.equal(buildStudentGradeAnalytics(data([subject], []), '').length, 0)
})
