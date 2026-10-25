// Exercise the real page callbacks with an in-memory read repository only.
// This deliberately performs no HTTP request, model inference or database write.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const pageText = await readFile(new URL('../../src/pages/StudyGroupsPage.tsx', import.meta.url), 'utf8')
const page = ts.createSourceFile('StudyGroupsPage.tsx', pageText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function initializer(name) {
  let found
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(page) === name) found = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(page)
  assert.ok(found, `${name} still exists in the production page`)
  return found.getText(page)
}
function evaluate(name, context) {
  const output = ts.transpileModule(`const subject = ${initializer(name)}; subject`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return vm.runInNewContext(output, { URL, AbortController, setTimeout, clearTimeout, ...context })
}
async function loadCore(name) {
  const module = { exports: {} }
  const output = ts.transpileModule(await readFile(new URL(`../../src/lib/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(output, { module, exports: module.exports, URL, require: () => ({ supabase: {} }) })
  return module.exports
}
const core = await loadCore('homeworkAiDraft')
const resources = await loadCore('homeworkResources')
const { scheduleOccursOnDate } = await loadCore('studyGroupTimetable')
const date = '2026-10-27'
const lesson = { id: 'lesson-1', group_id: 'group-1', subject: 'Вища математика', lesson_type: 'practical', weekday: 2, starts_at: '09:40', valid_from: '2026-09-01', valid_until: '2026-12-31', week_pattern: 'every' }
const source = 'Вища математика. На вівторок. Похідні. Розв’язати задачі 1–5. https://example.org/new'
const input = { source_text: source, reference_date: '2026-10-25' }
const draft = { version: 1, complete: true, general_instructions: '', items: [{ subject: 'Вища математика', lesson_type: 'practical', date_text: 'На вівторок', lesson_topic: 'Похідні', source_fragment: source, links: [{ url: 'https://example.org/new', title: '' }] }], warnings: [] }
const plain = value => JSON.parse(JSON.stringify(value))

function harness(mode = 'inline', schedule = [lesson]) {
  const writes = [], reads = []
  let resolveRead, readSignal
  const read = new Promise(resolve => { resolveRead = resolve })
  const current = { groupId: 'group-1', userId: 'user-1', allowed: true, saving: false, editing: mode === 'inline' ? lesson : null, inlineKey: 'inline-key', inlineVersion: 'version-1', scheduleVersion: 'schedule-1', schedule, pageDate: '2026-10-25' }
  const value = { input, draft, itemIndex: 0, target: { lesson, date }, expected: { groupId: current.groupId, currentUserId: current.userId, editorKey: mode === 'inline' ? current.inlineKey : 'group-1:user-1:bulk', baseDraftVersion: mode === 'inline' ? current.inlineVersion : current.scheduleVersion } }
  const query = { select() { return this }, eq(key, value) { reads.push([key, value]); return this }, abortSignal(signal) { readSignal = signal; return this }, maybeSingle() { return read } }
  const context = {
    homeworkAiCurrent: { current }, active: { current: true }, homeworkAiOpening: false, homeworkAiOpeningSequence: { current: 0 },
    homeworkDate: date, homeworkLinks: ['https://example.org/existing'], homeworkLinkTitles: ['Наявна назва'],
    ...core, ...resources, scheduleOccursOnDate,
    supabase: { from(table) { assert.equal(table, 'study_group_homework'); return query } },
    populateHomeworkForm: (...args) => writes.push(['populate', ...args]),
    ...Object.fromEntries(['setHomeworkAiOpening', 'setSelectedDate', 'setHomeworkTopic', 'setHomeworkBody', 'setHomeworkLinks', 'setHomeworkLinkTitles', 'setHomeworkError'].map(name => [name, value => writes.push([name, value])])),
  }
  return { current, value, writes, reads, context, resolveRead, get readSignal() { return readSignal }, run: () => evaluate(mode === 'inline' ? 'applyHomeworkAiToForm' : 'openHomeworkAiForm', context)(value) }
}

test('inline extraction version changes when the latest schedule is changed or a date is cancelled', () => {
  const context = { editingHomeworkRecordId: null, homeworkTopic: '', homeworkBody: '', homeworkLinks: [], homeworkLinkTitles: [], homeworkFiles: [], homeworkAttachments: [] }
  const version = schedule => evaluate('homeworkAiInlineVersion', { ...context, homeworkAiScheduleVersion: evaluate('homeworkAiScheduleVersion', { schedule }) })
  assert.notEqual(version([lesson]), version([{ ...lesson, excluded_dates: [date] }]))
  assert.notEqual(version([lesson]), version([{ ...lesson, subject: 'Інший предмет' }]))
})

test('inline apply rejects a removed, cancelled or foreign latest lesson even if the old editor row still exists', () => {
  for (const schedule of [[], [{ ...lesson, excluded_dates: [date] }], [{ ...lesson, group_id: 'another-group' }]]) {
    const fx = harness('inline', schedule)
    assert.throws(fx.run, /Форма, пара або доступ змінилися/)
    assert.equal(fx.writes.length, 0)
  }
})

test('inline apply preserves old links and their titles; exceeding ten links mutates no field', () => {
  const fx = harness()
  assert.equal(fx.run(), true)
  assert.deepEqual(plain(fx.writes.find(([name]) => name === 'setHomeworkLinks')[1]), ['https://example.org/existing', 'https://example.org/new'])
  assert.deepEqual(plain(fx.writes.find(([name]) => name === 'setHomeworkLinkTitles')[1]), ['Наявна назва', ''])
  assert.equal(fx.writes.some(([name]) => /Files|Attachments/.test(name)), false)
  const over = harness()
  over.context.homeworkLinks = Array.from({ length: 10 }, (_, index) => `https://example.org/existing-${index}`)
  over.context.homeworkLinkTitles = Array(10).fill('')
  assert.throws(over.run, /10 посилань/)
  assert.equal(over.writes.length, 0)
})

test('changing the viewed calendar day during a pending existing-homework read cannot open or retarget the editor', async () => {
  const fx = harness('bulk')
  const pending = fx.run()
  fx.context.homeworkAiCurrent.current = { ...fx.current, pageDate: '2026-10-26' }
  fx.resolveRead({ data: null, error: null })
  assert.equal(await pending, false)
  assert.equal(fx.writes.some(([name]) => name === 'populate' || name === 'setSelectedDate'), false)
})

test('bulk reads exactly group + lesson + target date and opens existing content unchanged with a review carry', async () => {
  const fx = harness('bulk')
  const existing = { id: 'homework-1', group_id: 'group-1', schedule_item_id: lesson.id, lesson_date: date, lesson_topic: 'Наявне ДЗ', body: 'Не замінювати без підтвердження', attachments: [{ file_name: 'Наявний файл.pdf' }] }
  const pending = fx.run()
  fx.resolveRead({ data: existing, error: null })
  assert.equal(await pending, true)
  assert.deepEqual(fx.reads, [['group_id', 'group-1'], ['schedule_item_id', lesson.id], ['lesson_date', date]])
  const opened = fx.writes.find(([name]) => name === 'populate')
  assert.equal(opened[3], existing)
  assert.equal(opened[4].itemIndex, 0)
  assert.equal(fx.writes.some(([name]) => name === 'setHomeworkBody' || name === 'setHomeworkTopic'), false)
  assert.deepEqual(fx.writes.find(([name]) => name === 'setSelectedDate'), ['setSelectedDate', date])
})

test('a stalled bulk read times out, aborts transport and releases manual editing without moving the date', async () => {
  const fx = harness('bulk')
  let expire, timeoutMs, cleared
  const timer = { local: true }
  fx.context.setTimeout = (callback, delay) => { expire = callback; timeoutMs = delay; return timer }
  fx.context.clearTimeout = value => { cleared = value }
  const pending = fx.run()
  assert.equal(timeoutMs, 18000)
  assert.equal(fx.readSignal.aborted, false)
  expire()
  await assert.rejects(pending, /Спробуйте ще раз або відкрийте пару й заповніть ДЗ вручну/)
  assert.equal(fx.readSignal.aborted, true)
  assert.equal(cleared, timer)
  assert.deepEqual(fx.writes.filter(([name]) => name === 'setHomeworkAiOpening'), [['setHomeworkAiOpening', true], ['setHomeworkAiOpening', false]])
  assert.equal(fx.writes.some(([name]) => name === 'populate' || name === 'setSelectedDate'), false)
  const count = fx.writes.length
  fx.resolveRead({ data: null, error: null })
  await Promise.resolve()
  assert.equal(fx.writes.length, count, 'a late read cannot reopen or modify the form after timeout')
})
