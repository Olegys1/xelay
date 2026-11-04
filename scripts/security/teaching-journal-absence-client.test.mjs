// Actual client helpers and export handlers, with synthetic records only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
function load(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, Intl, Blob, setTimeout: callback => callback(), ...globals,
    require(name) { assert.ok(Object.hasOwn(imports, name), 'Known import: ' + name); return imports[name] } })
  return module.exports
}
const helpers = load(await read('src/lib/teachingGradeFollowup.ts'))
const preferences = load(await read('src/lib/teachingJournalPreferences.ts'))
const grading = load(await read('src/lib/teachingGrading.ts'))
const semester = load(await read('src/lib/teachingSemesterJournal.ts'), { './teachingGrading': grading })
const analytics = load(await read('src/lib/studentGradeAnalytics.ts'), { './teachingGrading': grading })
const course = { id: 'course', title: 'Математика', semester: 'Осінь', permissions: ['grades'], grading_rules: { categories: [] } }
const entry = { id: 'entry', course_id: course.id, group_id: 'group', active: true, full_name: 'Тестова студентка' }
const activity = { id: 'activity', course_id: course.id, group_id: 'group', title: 'МКР', work_type: 'МКР', activity_date: '2026-11-04', max_points: 20, category: '' }
const grade = { id: 'grade', activity_id: activity.id, entry_id: entry.id, draft_score: null, draft_absent: true, draft_comment: '', published_score: null, published_absent: true, published_comment: '', published_at: '2026-11-04T08:00:00Z', version: 3 }
const plain = value => JSON.parse(JSON.stringify(value))

test('absence, blank and zero stay distinct and published absence corrections need reasons', () => {
  assert.equal(helpers.teachingGradeDraftValue(grade), 'Н')
  assert.equal(helpers.teachingGradeDraftValue({ ...grade, draft_absent: false }), '')
  assert.equal(helpers.teachingGradeDraftValue({ ...grade, draft_absent: false, draft_score: 0 }), '0')
  assert.equal(helpers.teachingGradeDraftScore(grade), null)
  for (const text of ['Н', 'н', 'H', 'h']) assert.equal(helpers.isTeachingGradeAbsence(text), true)
  assert.throws(() => helpers.teachingGradeDraftPayload(course.id, entry, activity, grade, { score: '', comment: '', reason: '' }), /причину/)
  assert.throws(() => helpers.teachingGradeDraftPayload(course.id, entry, activity, grade, { score: '4', comment: '', reason: '' }), /причину/)
  const payload = helpers.teachingGradeDraftPayload(course.id, entry, activity, grade, { score: '4', comment: '', reason: 'Відпрацювала' })
  assert.equal(payload.score, 4); assert.equal(payload.absent, false)
  assert.throws(() => helpers.teachingGradeEditScore('2', activity, grade, 'add'), /основний бал/)
  const absent = helpers.teachingGradeDraftPayload(course.id, entry, activity, undefined, { score: 'Н', comment: '', reason: '' })
  assert.equal(absent.score, null); assert.equal(absent.absent, true)
})

test('saved order is stable with newly added work and work types have explicit tones', () => {
  const next = { ...activity, id: 'new', title: 'Залік', activity_date: '2026-11-05' }
  assert.deepEqual(plain(preferences.orderedTeachingActivities([activity, next], ['stale', 'new']).map(row => row.id)), ['new', 'activity'])
  assert.deepEqual([preferences.teachingActivityTone('МКР'), preferences.teachingActivityTone('Залік'), preferences.teachingActivityTone('Тест'), preferences.teachingActivityTone('Семінар')], ['module', 'exam', 'test', 'ordinary'])
  assert.equal(preferences.teachingGradeValue(0), '0'); assert.equal(preferences.teachingGradeValue(null), '—'); assert.equal(preferences.teachingGradeValue(null, true), 'Н')
})

test('own analytics excludes absence from assessed counts and never carries private drafts', () => {
  const result = analytics.buildStudentGradeAnalytics({ courses: [course], grades: [{ ...grade, course_id: course.id, group_id: 'group', activity_title: activity.title, activity_date: activity.activity_date, max_points: 20, category: '', course_title: course.title }], assignments: [], materials: [], pending_invites: [] }, 'group')[0]
  assert.equal(result.numericGrades.length, 0); assert.equal(result.earned, null); assert.equal(result.assessedMaximum, 0)
  assert.equal(result.grades[0].published_absent, true); assert.equal(result.grades[0].draft_absent, undefined)
})

test('CSV and XLSX keep published Н, numeric zero, private draft isolation and personal column order', async () => {
  const zero = { ...activity, id: 'zero', title: 'Контрольна' }, privateWork = { ...activity, id: 'private', title: 'Чернетка' }
  const snapshot = { course, groups: [{ group_id: 'group', group_name: 'ТЕСТ' }], entries: [entry], activities: [activity, zero, privateWork], grades: [grade,
    { ...grade, id: 'zero-grade', activity_id: zero.id, draft_absent: false, draft_score: 0, published_absent: false, published_score: 0 },
    { ...grade, id: 'private-grade', activity_id: privateWork.id, draft_absent: false, draft_score: 19, published_at: null, published_absent: false }], audit: [] }
  const source = ts.createSourceFile('teaching.ts', await read('src/lib/teaching.ts'), ts.ScriptTarget.ES2022, true)
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'exportTeachingJournal')
  let blob, clicked = 0
  const csv = load(`const orderedTeachingActivities = require('preferences').orderedTeachingActivities; const teachingStatementRows = require('semester').teachingStatementRows;\n${declaration.getText(source)}`,
    { preferences, semester }, { URL: { createObjectURL(value) { blob = value; return 'blob:synthetic' }, revokeObjectURL() {} }, document: { createElement() { return { click() { clicked++ } } } } })
  const order = ['zero', 'activity', 'private']
  csv.exportTeachingJournal(snapshot, 'group', 'name', order)
  const text = await blob.text()
  assert.equal(clicked, 1); assert.ok(text.indexOf('Контрольна') < text.indexOf('МКР'))
  assert.match(text, /"0";"Н";"";"0"/); assert.doesNotMatch(text, /"19"/)
  const written = []
  const xlsx = { utils: { book_new: () => ({}), aoa_to_sheet: rows => ({ rows }), encode_range: () => 'A1:E2', book_append_sheet: (_book, sheet, name) => written.push({ name, sheet }) }, writeFileXLSX() {} }
  const workbook = load(await read('src/lib/teachingJournalWorkbook.ts'), { './teachingGrading': grading, './teachingSemesterJournal': semester, './teachingJournalPreferences': preferences, xlsx })
  await workbook.exportTeachingJournalWorkbook(snapshot, 'group', () => true, { activityIds: order })
  const journal = written.find(item => item.name === 'Журнал').sheet.rows
  assert.ok(journal[0][1].startsWith('Контрольна')); assert.deepEqual(plain(journal[1].slice(1)), [0, 'Н', null, 0])
})
