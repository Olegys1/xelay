import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const source = await readFile(new URL('src/components/GroupTimetable.tsx', root), 'utf8')
const photo = await readFile(new URL('src/components/StudyGroupTimetablePhoto.tsx', root), 'utf8')
const page = await readFile(new URL('src/pages/StudyGroupsPage.tsx', root), 'utf8')
function compile(source, imports = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, require: key => {
    if (key in imports) return imports[key]
    throw new Error(`Unexpected dependency: ${key}`)
  }, URL, Date, Intl })
  return module.exports
}
const copyTimes = compile(await readFile(new URL('src/lib/scheduleCopyTimes.ts', root), 'utf8'))
const timetable = compile(await readFile(new URL('src/lib/studyGroupTimetable.ts', root), 'utf8'), { './supabase': {}, './scheduleCopyTimes': copyTimes })
const links = compile(await readFile(new URL('src/lib/studyGroupLinks.ts', root), 'utf8'))
const emptyDetailsSource = source.match(/const emptyCellDetails = [^\r\n]*/)?.[0]
assert.ok(emptyDetailsSource, 'Use the real empty lesson metadata factory')
const makeDetails = compile(emptyDetailsSource + '\nexports.makeDetails=emptyCellDetails;').makeDetails
const buildSource = source.slice(source.indexOf('function buildLessons('), source.indexOf('\nfunction DraftWeek('))
const prelude = `
const DAYS = ['Понеділок','Вівторок','Середа','Четвер','П’ятниця','Субота','Неділя'];
const WEEK_NAMES = {upper:'Верхній',lower:'Нижній'};
const {isTimetableDate,mondayForDate,parseTimetableCell,normalizeTimetableTeacherName,TIMETABLE_TEACHER_NAME_MAX_LENGTH}=require('timetable');
const {safeLessonUrl,STUDY_GROUP_LINK_LABEL_MAX_LENGTH,normalizeScheduleConferenceAccess}=require('links');
const emptyCellDetails=require('emptyDetails');
`
const { buildLessons } = compile(prelude + buildSource + '\nexports.buildLessons=buildLessons;', { timetable, links, emptyDetails: makeDetails })
const slots = [{ number: 1, starts_at: '08:00', ends_at: '09:20' }]
const cell = extra => ({ ...makeDetails(), ...extra })
const grids = { upper: { '1:1': 'Математика (лекція)' }, lower: { '1:1': 'Математика (лекція)' } }
const build = details => buildLessons(grids, slots, '2026-09-01', '2026-12-31', '2026-09-07', details)

test('production photo and table views contain no foreign timetable preset or uploader', () => {
  assert.doesNotMatch(source + photo, /ЕУБ-4|eub-4-timetable-example|exampleGrids|useExample/)
  assert.match(photo, /!latestCanEdit\.current/)
  assert.match(photo, /event\.target\.files/)
  assert.match(page, /destinationName=\{group\.group_name\}/)
  assert.match(page, /destinationStudyLevel=\{group\.study_level\}/)
  assert.match(source, /Група для додавання розкладу/)
})
test('ordinary manually confirmed lessons retain the selected semester and merge identical weeks', () => {
  const result = build({ upper: {}, lower: {} })
  assert.equal(result.length, 1)
  assert.equal(result[0].week_pattern, 'every')
  assert.equal(result[0].valid_from, '2026-09-01')
  assert.equal(result[0].valid_until, '2026-12-31')
})
test('a visible date/count restriction cannot be imported with an implicit whole-semester period', () => {
  for (const values of [{}, { valid_from: '2026-10-01' }, { valid_until: '2026-11-30' }]) {
    assert.throws(() => build({ upper: { '1:1': cell({ date_note: 'початок з 01.10.2026, 9 пар', ...values }) }, lower: {} }), /обмеження дат/)
  }
})
test('explicit periods override the semester in actual import payload without sending source notes', () => {
  const metadata = cell({ date_note: 'початок з 01.10.2026', valid_from: '2026-10-01', valid_until: '2026-12-01' })
  const result = build({ upper: { '1:1': metadata }, lower: { '1:1': metadata } })
  assert.equal(result.length, 1)
  assert.equal(result[0].week_pattern, 'every')
  assert.equal(result[0].valid_from, '2026-10-01')
  assert.equal(result[0].valid_until, '2026-12-01')
  assert.equal('date_note' in result[0], false)
  assert.equal('needs_review' in result[0], false)
})
test('different upper/lower lesson periods remain separate records', () => {
  const result = build({ upper: { '1:1': cell({ valid_from: '2026-10-01', valid_until: '2026-12-01' }) }, lower: {} })
  assert.equal(result.length, 2)
  assert.equal(result[0].week_pattern, 'upper')
  assert.equal(result[0].valid_from, '2026-10-01')
  assert.equal(result[1].week_pattern, 'lower')
  assert.equal(result[1].valid_from, '2026-09-01')
})
test('invalid dates, reversed dates or a period outside the semester cannot reach import', () => {
  for (const dates of [['2026-02-30','2026-12-01'], ['2026-11-30','2026-10-01'], ['2026-08-01','2026-10-01'], ['2026-10-01','2027-01-01']]) {
    assert.throws(() => build({ upper: { '1:1': cell({ valid_from: dates[0], valid_until: dates[1] }) }, lower: {} }), /період заняття/)
  }
})
test('review flags still block saving even after the user has entered valid dates', () => {
  assert.throws(() => build({ upper: { '1:1': cell({ date_note: '9 пар', valid_from: '2026-10-01', valid_until: '2026-12-01', needs_review: true }) }, lower: {} }), /позначене заняття/)
})
