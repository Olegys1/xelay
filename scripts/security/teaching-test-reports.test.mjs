import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as XLSX from 'xlsx'

function load(file, imports = {}, extra = {}) {
  const source = readFileSync(new URL(`../../src/lib/${file}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, URL, Blob, Uint8Array, TextEncoder, setTimeout, ...extra,
    require(name) { assert.ok(Object.hasOwn(imports, name), `Known import ${name}`); return imports[name] },
  })
  return module.exports
}

const content = load('teachingTestContent')
const journal = load('teachingJournalWorkbook', { './teachingGrading': {}, './teachingSemesterJournal': {}, './teachingJournalPreferences': {} })
const modules = { './teachingTestContent': content, './teachingJournalWorkbook': journal, xlsx: XLSX }
const reports = load('teachingTestReports', modules)
const pdf = load('teachingTestReportPdf', { './teachingTestContent': content, './teachingTestQuestionImages': {}, './teachingTestReports': reports })
const first = { id: 'one', kind: 'choice', text: 'Скільки буде \\(2^2\\)?', points: 2, options: [{ id: 'a', text: '4' }, { id: 'b', text: '' , images: [{ id: 'photo', alt: 'Графік'}] }], answer: 'a' }
const second = { id: 'two', kind: 'essay', text: 'Пояснення', points: 5, options: [] }
const third = { id: 'three', kind: 'short_text', text: 'Інший варіант', points: 1, options: [], answer: ['Київ','Києві'] }
const attempt = { id: 'attempt-abcdefgh', student_name: 'Олена Синиця', group_id: 'one', status: 'submitted', score: 7, auto_score: 5, bonus_score: 2, final_score: 9, elapsed_seconds: 60, attempt_number: 1, started_at: '2026-11-06T12:00:00Z', submitted_at: '2026-11-06T12:01:00Z', questions: [first, second], answers: { one: 'b' }, opened_at: { one: '2026-11-06T12:00:00Z' } }
const data = { title: 'Контрольна з математики', courseTitle: 'Математика', maxPoints: 10, finalized: false, groupNames: new Map([['one', 'Група А'], ['two', 'Група Б']]), attempts: [attempt, { ...attempt, id: 'attempt-ijklmnop', student_name: 'Софія Білик', group_id: 'two', questions: [{ ...first, options: [...first.options].reverse() }, third], answers: { one: 'b', three: 'Київ' } }] }

test('answer matrix maps the exact option order of each delivered attempt and distinguishes omitted and skipped', () => {
  const [matrix, keys] = reports.buildTeachingTestReportSheets('answers-matrix', data)
  assert.match(matrix.rows[1][3], /Варіант B · Графік/)
  assert.match(matrix.rows[2][3], /Варіант A · Графік/)
  assert.equal(matrix.rows[1][4], 'Без відповіді')
  assert.equal(matrix.rows[2][4], 'Не було у варіанті')
  assert.equal(matrix.rows[1][5], 'Не було у варіанті')
  assert.equal(matrix.rows[2][5], 'Київ')
  assert.equal(keys.rows[1][1], 'Скільки буде 2^2?')
})

test('detailed reports are based on the submitted attempt, with explicit grading status and no unapproved bonus', () => {
  const [summary, details] = reports.buildTeachingTestReportSheets('selected-workbook', data)
  assert.equal(summary.rows[1][1], 'Група А')
  assert.equal(summary.rows[1][4].includes('14:00'), true)
  assert.equal(summary.rows[1][9], null)
  assert.equal(summary.rows[1][10], null)
  assert.equal(summary.rows[1][12], 'Очікує ручної перевірки')
  assert.match(details.rows[1][5], /Варіант B · Графік/)
  assert.match(details.rows[3][5], /^Варіант A · Графік/)
  assert.equal(details.rows[2][9], null)
  assert.equal(details.rows[4][7], 'Київ / Києві')
  const [approved] = reports.buildTeachingTestReportSheets('summary-xlsx', { ...data, finalized: true })
  assert.equal(approved.rows[1][9], 2)
  assert.equal(approved.rows[1][10], 9)
})

test('CSV escapes spreadsheet formulas, quotes, and preserves numeric grades', () => {
  const csv = reports.teachingTestReportCsv([['\t=1+1','Відповідь "так"',-2]])
  assert.equal(csv, '\uFEFF"\'\t=1+1";"Відповідь ""так""";"-2"')
})

test('XLSX download contains plain-text values and excludes an unfinished attempt', async () => {
  let blob
  const links = []
  const browserReports = load('teachingTestReports', modules, { URL: { createObjectURL(value) { blob = value; return 'blob:report' }, revokeObjectURL() {} }, document: { createElement() { return { click() { links.push(this.download) } } } } })
  await browserReports.downloadTeachingTestReport('summary-xlsx', { ...data, attempts: [{ ...attempt, student_name: '=1+2' }, { ...attempt, id: 'live', student_name: 'Не включати', status: 'in_progress' }] }, new AbortController().signal)
  const workbook = XLSX.read(await blob.arrayBuffer(), { type: 'array' })
  const sheet = workbook.Sheets['Результати']
  assert.equal(sheet.A2.t, 's')
  assert.equal(sheet.A2.f, undefined)
  assert.equal(sheet.A2.v, "'=1+2")
  assert.equal(sheet.A3, undefined)
  assert.match(links[0], /summary-xlsx\.xlsx$/)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(browserReports.downloadTeachingTestReport('summary-csv', data, aborted.signal), { name: 'AbortError' })
  assert.equal(links.length, 1)
})

test('PDF has separate pages and byte-correct offsets for embedded binary page streams', async () => {
  const jpeg = Uint8Array.from([255, 216, 201, 10, 255, 217])
  const blob = pdf.makeTeachingTestPagePdf([jpeg, jpeg], 877, 1240, false)
  const bytes = Buffer.from(await blob.arrayBuffer())
  const text = bytes.toString('latin1')
  assert.equal(blob.type, 'application/pdf')
  assert.match(text, /^%PDF-1.4/)
  assert.match(text, /\/Count 2/)
  const offset = Number(text.match(/startxref\n(\d+)/)[1])
  const entries = text.slice(offset).match(/\d{10} 00000 n/g)
  assert.equal(entries.length, 8)
  entries.forEach((entry, index) => assert.equal(text.slice(Number(entry.slice(0, 10))).startsWith(`${index + 1} 0 obj`), true))
  assert.equal(bytes.indexOf(jpeg) >= 0, true)
})

test('the seven report actions create files in their promised formats', async () => {
  const files = []
  let blob
  const context = { fillRect() {}, fillText() {}, drawImage() {}, measureText: value => ({ width: value.length * 8 }) }
  const canvas = { getContext: () => context, toDataURL: () => 'data:image/jpeg;base64,/9j/2Q==' }
  const environment = {
    URL: { createObjectURL(value) { blob = value; return 'blob:report' }, revokeObjectURL() {} },
    document: { createElement(tag) { return tag === 'canvas' ? canvas : { click() { files.push({ filename: this.download, blob }) } } } },
    atob,
  }
  const browserPdf = load('teachingTestReportPdf', { './teachingTestContent': content, './teachingTestQuestionImages': { readableTeachingTestQuestionImages: () => [] }, './teachingTestReports': reports }, environment)
  const browserReports = load('teachingTestReports', { ...modules, './teachingTestReportPdf': browserPdf }, environment)
  for (const { id } of reports.TEACHING_TEST_REPORTS) {
    await browserReports.downloadTeachingTestReport(id, data, new AbortController().signal)
  }
  assert.equal(files.length, 7)
  const extension = file => file.filename.split('.').at(-1)
  assert.deepEqual(files.map(extension), ['pdf', 'xlsx', 'csv', 'xlsx', 'pdf', 'pdf', 'xlsx'])
  for (const file of files) {
    if (extension(file) === 'pdf') assert.equal(await file.blob.slice(0, 8).text(), '%PDF-1.4')
    else if (extension(file) === 'xlsx') assert.equal(await file.blob.slice(0, 2).text(), 'PK')
    else assert.match(await file.blob.text(), /^"Студент";/)
  }
})
